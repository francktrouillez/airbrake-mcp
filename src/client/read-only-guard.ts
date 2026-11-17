import type { HttpMethod } from './airbrake.js';
import { AirbrakeConfigError } from './errors.js';

// An upstream or proxy honouring any of these would turn a GET into a write.
const METHOD_OVERRIDE_HEADERS = new Set([
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);
const METHOD_OVERRIDE_PARAMS = new Set(['_method']);

/**
 * Backstop for AIRBRAKE_READ_ONLY, below every tool: only a plain GET may
 * leave the process. Checks the method, the final (lower-cased) headers and
 * the fully built URL — so a `_method` smuggled into `path` is caught as
 * well as one passed via `query`.
 */
export function assertReadOnlyRequest(
  method: HttpMethod,
  path: string,
  url: string,
  headers: Readonly<Record<string, string>>,
): void {
  const refuse = (why: string): never => {
    throw new AirbrakeConfigError(`${method} ${path} refused: ${why}AIRBRAKE_READ_ONLY is set`);
  };
  if (method !== 'GET') refuse('');
  const header = Object.keys(headers).find((h) => METHOD_OVERRIDE_HEADERS.has(h.toLowerCase()));
  if (header !== undefined) refuse(`method-override header ${header} is not allowed while `);
  const param = [...new URL(url).searchParams.keys()].find((k) =>
    METHOD_OVERRIDE_PARAMS.has(k.toLowerCase()),
  );
  if (param !== undefined) refuse(`method-override query parameter ${param} is not allowed while `);
}
