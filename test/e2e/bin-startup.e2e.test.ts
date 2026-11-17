// End-to-end coverage for the `dist/bin.js` entry shim's failure path: when
// startup throws, the process must exit 1 with a prefixed message on stderr
// and nothing on stdout (stdout is reserved for JSON-RPC). The individual
// config error messages are unit-tested in test/config.test.ts.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERVER_BIN } from './helpers/mcp-harness.js';

function runBin(
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_BIN], {
      // Same isolation as startMcp: never inherit real AIRBRAKE_* vars.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      // If startup ever stops failing, the server would wait on stdin forever;
      // kill it so the test fails fast instead of leaking a process.
      timeout: 10_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('e2e: bin.js startup failure', () => {
  beforeAll(() => {
    if (!existsSync(SERVER_BIN)) {
      throw new Error(`${SERVER_BIN} not found — run \`npm run build\` before the e2e suite`);
    }
  });

  it('exits 1 with a prefixed stderr message when AIRBRAKE_HOST is invalid', async () => {
    const res = await runBin({ AIRBRAKE_USER_TOKEN: 't', AIRBRAKE_HOST: 'not a url' });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/^airbrake-mcp failed to start: AIRBRAKE_HOST /m);
    expect(res.stdout).toBe('');
  });
});
