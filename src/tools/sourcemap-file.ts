// Local source-map file loading for `airbrake_sourcemaps` `upload`.
//
// The upload action reads a file from the machine running this MCP server and
// sends it to the Airbrake host. A prompt-injected model could otherwise point
// `file_path` at ~/.ssh/id_rsa, ~/.aws/credentials, etc. and exfiltrate it, so
// every check below runs BEFORE any HTTP request, and together they ensure
// only a genuine source map can ever leave the machine:
//
//   1. the path is absolute and its own basename ends in `.map` — checked
//      before touching the filesystem, so the tool cannot be used to probe
//      whether arbitrary non-.map files or directories exist;
//   2. it resolves (realpath, symlinks followed) to a regular file — not a
//      directory, device, FIFO or socket — whose RESOLVED basename also ends
//      in `.map`, so `x.map -> ~/.ssh/id_rsa` fails;
//   3. the size is at most MAX_SOURCEMAP_BYTES, checked via lstat before reading;
//   4. the content parses as JSON shaped like a source map v3. This is also
//      the backstop for hard links (`x.map` hard-linked to a secret), which no
//      path check can detect.
//
// Error messages never include the resolved target path or file content, so
// a rejection cannot be used to read files back through the model either.

import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

/** Upper bound on an uploaded source map. */
export const MAX_SOURCEMAP_BYTES = 50 * 1024 * 1024;
/** MAX_SOURCEMAP_BYTES as a human-readable label, for tool descriptions. */
export const MAX_SOURCEMAP_SIZE_LABEL = `${MAX_SOURCEMAP_BYTES / (1024 * 1024)} MiB`;

const SOURCEMAP_EXTENSION = '.map';
// O_NOFOLLOW: refuse to open if the already-resolved path was swapped for a
// symlink after realpath(). O_NONBLOCK: a path swapped for a FIFO cannot hang
// open(). Both are 0 (no-op) on platforms that lack them; the lstat checks and
// the post-open dev/ino comparison still apply there.
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

export class SourceMapFileError extends Error {
  constructor(message: string) {
    super(`file_path rejected: ${message}`);
    this.name = 'SourceMapFileError';
  }
}

export interface LoadedSourceMap {
  /** Basename of the resolved file; used as the multipart filename. */
  readonly fileName: string;
  /** Exact file bytes, sent unmodified. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface ResolvedFile {
  readonly realPath: string;
  readonly stats: Stats;
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? String(err.code) : undefined;
}

function hasMapExtension(p: string): boolean {
  return path.basename(p).toLowerCase().endsWith(SOURCEMAP_EXTENSION);
}

// On Windows, `\\host\share\x.map` (or `//host/...`) is absolute, and merely
// resolving it opens an SMB connection that sends the user's NTLM hash to the
// host. `\\?\` / `\\.\` device-namespace paths are rejected the same way.
export function isWindowsNetworkPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(filePath);
}

// Every filesystem error — at resolve or open time — maps to ONE message that
// names only the caller's own path: distinguishing ENOENT from EACCES would
// let a model probe which protected files and directories exist.
function unavailable(filePath: string): SourceMapFileError {
  return new SourceMapFileError(`${filePath} does not exist or cannot be accessed`);
}

// realpath() follows every symlink in the chain. lstat() (not stat) then
// describes the resolved entry itself: if it was swapped for a symlink after
// realpath(), it is no longer a regular file and is rejected.
async function resolveFile(filePath: string): Promise<ResolvedFile> {
  if (!path.isAbsolute(filePath)) {
    throw new SourceMapFileError('must be an absolute path');
  }
  if (isWindowsNetworkPath(filePath)) {
    throw new SourceMapFileError('network (UNC) and device paths are not allowed');
  }
  if (!hasMapExtension(filePath)) {
    throw new SourceMapFileError(`file name must end in ${SOURCEMAP_EXTENSION}`);
  }
  try {
    const realPath = await realpath(filePath);
    return { realPath, stats: await lstat(realPath) };
  } catch {
    throw unavailable(filePath);
  }
}

function assertUploadable(realPath: string, stats: Stats, maxBytes: number): void {
  if (!stats.isFile()) {
    throw new SourceMapFileError('must be a regular file (not a directory, device, or FIFO)');
  }
  if (!hasMapExtension(realPath)) {
    throw new SourceMapFileError(
      `file name must end in ${SOURCEMAP_EXTENSION} (checked after following symlinks)`,
    );
  }
  assertWithinCap(stats.size, maxBytes);
}

function assertWithinCap(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new SourceMapFileError(`file size ${size} bytes exceeds the ${maxBytes}-byte cap`);
  }
}

// Opens the vetted path and re-checks the open handle, so a file swapped
// between lstat() and open() is caught rather than read. A dev/ino match
// proves it is the same inode (type and name already vetted); only its size
// can have changed.
async function readVettedFile(
  filePath: string,
  { realPath, stats: vetted }: ResolvedFile,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  let handle;
  try {
    handle = await open(realPath, OPEN_FLAGS);
  } catch {
    // An unreadable file must look like a missing one (see unavailable()).
    throw unavailable(filePath);
  }
  try {
    const current = await handle.stat();
    if (current.dev !== vetted.dev || current.ino !== vetted.ino) {
      throw new SourceMapFileError('file changed while being read');
    }
    assertWithinCap(current.size, maxBytes);
    // Read at most size + 1 bytes: memory stays bounded by the vetted size,
    // and the extra byte detects a file that grew after it was checked.
    // allocUnsafeSlow skips the zero-fill; only the filled prefix is returned.
    const buffer = Buffer.allocUnsafeSlow(current.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== current.size) {
      throw new SourceMapFileError('file changed while being read');
    }
    return buffer.subarray(0, filled);
  } finally {
    // A read-only handle has no unflushed state; a close failure must not
    // mask the actual rejection or read error above, but is still reported.
    await handle.close().catch((err: unknown) => {
      process.stderr.write(
        `airbrake-mcp: warning: closing source map file failed (${errnoCode(err) ?? 'unknown error'})\n`,
      );
    });
  }
}

function notV3(reason: string): SourceMapFileError {
  return new SourceMapFileError(`content is not a source map v3 (${reason})`);
}

/**
 * Throws SourceMapFileError unless `bytes` is JSON shaped like a source map v3
 * (`version === 3`, string `mappings`, `sources` an array of strings or nulls
 * when present). A leading UTF-8 BOM is ignored. Never echoes the content:
 * JSON.parse messages quote their input.
 */
export function validateSourceMapContent(bytes: Uint8Array): void {
  let parsed: unknown;
  try {
    // TextDecoder decodes without copying and strips a leading BOM.
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SourceMapFileError('content is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw notV3('expected a JSON object');
  }
  const map = parsed as Record<string, unknown>;
  if (map.version !== 3) throw notV3('version must be 3');
  if (typeof map.mappings !== 'string') throw notV3('mappings must be a string');
  if (
    'sources' in map &&
    !(Array.isArray(map.sources) && map.sources.every((s) => typeof s === 'string' || s === null))
  ) {
    throw notV3('sources must be an array of strings or nulls');
  }
}

/**
 * Resolves, vets, reads and validates a local source map. Throws
 * SourceMapFileError on any violation; performs no network I/O.
 * `maxBytes` exists so tests can exercise the cap without large files.
 */
export async function loadSourceMapFile(
  filePath: string,
  maxBytes: number = MAX_SOURCEMAP_BYTES,
): Promise<LoadedSourceMap> {
  const resolved = await resolveFile(filePath);
  assertUploadable(resolved.realPath, resolved.stats, maxBytes);
  const bytes = await readVettedFile(filePath, resolved, maxBytes);
  validateSourceMapContent(bytes);
  return { fileName: path.basename(resolved.realPath), bytes };
}
