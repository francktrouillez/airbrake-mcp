import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAX_SOURCEMAP_BYTES,
  SourceMapFileError,
  isWindowsNetworkPath,
  loadSourceMapFile,
  validateSourceMapContent,
} from '../../src/tools/sourcemap-file.js';

const VALID_MAP = JSON.stringify({
  version: 3,
  file: 'app.min.js',
  sources: ['app.js'],
  names: [],
  mappings: 'AAAA',
});

describe('loadSourceMapFile', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smfile-')));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string | Buffer): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('loads a valid v3 source map and returns its exact bytes and file name', async () => {
    const p = write('app.min.js.map', VALID_MAP);
    const loaded = await loadSourceMapFile(p);
    expect(loaded.fileName).toBe('app.min.js.map');
    expect(Buffer.from(loaded.bytes).toString('utf8')).toBe(VALID_MAP);
  });

  it('accepts a symlink whose target is a .map file and reports the target name', async () => {
    const target = write('real-target.js.map', VALID_MAP);
    const link = path.join(dir, 'alias.map');
    fs.symlinkSync(target, link);
    const loaded = await loadSourceMapFile(link);
    expect(loaded.fileName).toBe('real-target.js.map');
  });

  it('rejects relative paths', async () => {
    await expect(loadSourceMapFile('app.js.map')).rejects.toThrow(/absolute/);
  });

  it('rejects a non-.map path before touching the filesystem (no existence oracle)', async () => {
    // Both a missing and an existing non-.map path get the same answer, so
    // the tool cannot be used to probe which secret files exist.
    const existing = write('id_rsa_probe', 'secret');
    for (const p of [existing, path.join(dir, 'missing_secret'), dir]) {
      const err = await loadSourceMapFile(p).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceMapFileError);
      expect((err as Error).message).toMatch(/must end in \.map$/);
    }
  });

  it('rejects a non-.map path that is a symlink to a valid .map file', async () => {
    const target = write('linked-target.js.map', VALID_MAP);
    const link = path.join(dir, 'alias.txt');
    fs.symlinkSync(target, link);
    await expect(loadSourceMapFile(link)).rejects.toThrow(/\.map/);
  });

  it('rejects a missing file', async () => {
    await expect(loadSourceMapFile(path.join(dir, 'nope.js.map'))).rejects.toThrow(
      /does not exist or cannot be accessed/,
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'gives an unreadable directory the same message as a missing one (no EACCES oracle)',
    async () => {
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, 'inner.js.map'), VALID_MAP);
      fs.chmodSync(locked, 0o000);
      try {
        const missing = await loadSourceMapFile(path.join(dir, 'absent', 'x.map')).catch(
          (e: Error) => e.message.replace(/^.*does not/, 'does not'),
        );
        const denied = await loadSourceMapFile(path.join(locked, 'inner.js.map')).catch(
          (e: Error) => e.message.replace(/^.*does not/, 'does not'),
        );
        expect(denied).toBe(missing);
        expect(denied).toBe('does not exist or cannot be accessed');
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'gives an unreadable .map file the same message as a missing one',
    async () => {
      const p = write('unreadable.js.map', VALID_MAP);
      fs.chmodSync(p, 0o000);
      try {
        await expect(loadSourceMapFile(p)).rejects.toThrow(
          `${p} does not exist or cannot be accessed`,
        );
      } finally {
        fs.chmodSync(p, 0o600);
      }
    },
  );

  it('rejects a directory, even one named *.map', async () => {
    const d = path.join(dir, 'folder.map');
    fs.mkdirSync(d);
    await expect(loadSourceMapFile(d)).rejects.toThrow(/regular file/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO named *.map', async () => {
    const fifo = path.join(dir, 'pipe.map');
    execFileSync('mkfifo', [fifo]);
    await expect(loadSourceMapFile(fifo)).rejects.toThrow(/regular file/);
  });

  it.skipIf(process.platform === 'win32')('rejects a device via a *.map symlink', async () => {
    const link = path.join(dir, 'null.map');
    fs.symlinkSync('/dev/null', link);
    // realpath → /dev/null: fails both the regular-file and .map checks.
    await expect(loadSourceMapFile(link)).rejects.toBeInstanceOf(SourceMapFileError);
  });

  it('rejects a .map symlink pointing at a non-.map file (exfiltration guard)', async () => {
    const secret = write('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
    const link = path.join(dir, 'innocent.js.map');
    fs.symlinkSync(secret, link);
    const err = await loadSourceMapFile(link).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceMapFileError);
    expect((err as Error).message).toMatch(/\.map/);
    // The resolved target path must not be disclosed back to the model.
    expect((err as Error).message).not.toContain('id_rsa');
  });

  it('rejects a .map symlink chain ending at a non-.map file', async () => {
    const secret = write('credentials', 'aws_secret_access_key=xyz');
    const hop = path.join(dir, 'hop.map');
    fs.symlinkSync(secret, hop);
    const link = path.join(dir, 'chain.map');
    fs.symlinkSync(hop, link);
    await expect(loadSourceMapFile(link)).rejects.toThrow(/\.map/);
  });

  it('rejects files above the size cap (injected small cap)', async () => {
    const p = write('big.js.map', VALID_MAP);
    await expect(loadSourceMapFile(p, 8)).rejects.toThrow(/exceeds/);
  });

  it('rejects files above the default cap without reading them (sparse file)', async () => {
    const p = path.join(dir, 'huge.js.map');
    fs.writeFileSync(p, '');
    fs.truncateSync(p, MAX_SOURCEMAP_BYTES + 1);
    await expect(loadSourceMapFile(p)).rejects.toThrow(/exceeds/);
  });

  it('accepts a file exactly at the cap boundary', async () => {
    const p = write('exact.js.map', VALID_MAP);
    const loaded = await loadSourceMapFile(p, Buffer.byteLength(VALID_MAP));
    expect(loaded.bytes.byteLength).toBe(Buffer.byteLength(VALID_MAP));
  });

  it('rejects invalid JSON without echoing file content', async () => {
    const p = write('broken.js.map', 'TOPSECRET not json');
    const err = await loadSourceMapFile(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceMapFileError);
    expect((err as Error).message).toMatch(/not valid JSON/);
    expect((err as Error).message).not.toContain('TOPSECRET');
  });

  it('rejects JSON that is not a v3 source map', async () => {
    const p = write('pkg.json.map', JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    await expect(loadSourceMapFile(p)).rejects.toThrow(/source map v3/);
  });
});

describe('isWindowsNetworkPath', () => {
  it.each([
    '\\\\attacker.example\\share\\x.map',
    '//attacker.example/share/x.map',
    '\\\\?\\C:\\dist\\x.map',
    '\\\\.\\pipe\\x.map',
  ])('flags %s on win32', (p) => {
    expect(isWindowsNetworkPath(p, 'win32')).toBe(true);
  });

  it('allows local drive paths on win32', () => {
    expect(isWindowsNetworkPath('C:\\dist\\app.js.map', 'win32')).toBe(false);
  });

  it('is a no-op on POSIX platforms', () => {
    expect(isWindowsNetworkPath('//srv/x.map', 'linux')).toBe(false);
  });
});

describe('validateSourceMapContent', () => {
  const ok = (v: unknown): void => validateSourceMapContent(Buffer.from(JSON.stringify(v)));

  it('accepts a minimal v3 map', () => {
    expect(() => ok({ version: 3, mappings: '' })).not.toThrow();
  });

  it('accepts a UTF-8 BOM prefix', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID_MAP)]);
    expect(() => validateSourceMapContent(bytes)).not.toThrow();
  });

  it('accepts null entries in sources', () => {
    expect(() => ok({ version: 3, mappings: 'AAAA', sources: ['a.js', null] })).not.toThrow();
  });

  it.each([
    ['an array', [1, 2, 3]],
    ['null', null],
    ['a string', 'version 3'],
    ['version 2', { version: 2, mappings: 'AAAA' }],
    ['version "3" as a string', { version: '3', mappings: 'AAAA' }],
    ['missing mappings', { version: 3, sources: [] }],
    ['non-string mappings', { version: 3, mappings: [1] }],
    ['an index map (sections, no mappings)', { version: 3, sections: [] }],
    ['non-array sources', { version: 3, mappings: 'AAAA', sources: 'a.js' }],
    ['non-string source entry', { version: 3, mappings: 'AAAA', sources: [42] }],
  ])('rejects %s', (_label, value) => {
    expect(() => ok(value)).toThrow(SourceMapFileError);
  });
});
