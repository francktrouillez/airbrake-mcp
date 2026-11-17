import type { Config } from '../config.js';
import { AirbrakeApiError, AirbrakeNetworkError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// A server-supplied Retry-After of `Fri, 31 Dec 9999 23:59:59 GMT` parses as
// a ~253-trillion-ms sleep — effectively a stall that holds the bearer token
// in memory and blocks the MCP client's tool call. Cap at 60s.
export const MAX_RETRY_DELAY_MS = 60_000;
// `await response.text()` reads with no size limit. A malicious or compromised
// upstream can send a multi-GB body and OOM the Node process. 25 MB matches
// the largest realistic Airbrake list response.
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/** The response body exceeded the size cap (see MAX_RESPONSE_BYTES). */
export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** 'bearer' (default) uses AIRBRAKE_USER_TOKEN; 'none' omits Authorization (notifier path) */
  auth?: 'bearer' | 'none';
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function isRetriable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Retry-After (RFC 7231 §7.1.3) is either delta-seconds or an HTTP-date.
// Returns ms to wait, or null if the header is absent or unparseable.
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

// Equal-jitter exponential backoff: random delay between 50% and 100% of
// 2^attempt * baseMs. Avoids thundering-herd retries under concurrent load.
export function backoffMs(attempt: number, baseMs: number = 250): number {
  const exp = 2 ** attempt * baseMs;
  return exp * 0.5 + Math.random() * exp * 0.5;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Strip security-sensitive headers from user-supplied input and normalize
// remaining keys to lowercase. Without this, a case-variant `Authorization`
// header from an LLM survives as a distinct object key and Node's Headers
// constructor *appends* duplicate-name headers — the wire ends up sending
// `Authorization: <attacker>, Bearer <real_token>` (verified). Stripping
// host/cookie closes related abuse vectors against fixed-host destinations.
const RESERVED_HEADERS = new Set(['authorization', 'host', 'cookie']);

function sanitizeUserHeaders(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) continue;
    out[lower] = v;
  }
  return out;
}

export class AirbrakeClient {
  constructor(private readonly config: Config) {}

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = `${this.config.host}${path}${buildQuery(options.query)}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...sanitizeUserHeaders(options.headers),
    };
    if (options.auth !== 'none') {
      if (!this.config.userToken) {
        throw new AirbrakeApiError(401, method, path, {
          message: 'AIRBRAKE_USER_TOKEN env var is required',
        });
      }
      headers.authorization = `Bearer ${this.config.userToken}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        // Pre-formed payload (e.g. multipart, plain text, raw JSON).
        // Caller controls Content-Type via options.headers.
        body = options.body;
      } else {
        if (!('content-type' in headers)) {
          headers['content-type'] = 'application/json';
        }
        body = JSON.stringify(options.body);
      }
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;

    // Single retry decision point: a retriable status (429/5xx) waits for
    // Retry-After (capped) or backoff; a network error (incl. timeouts at
    // either stage) waits for backoff. Anything else returns or throws.
    let attempt = 0;
    while (true) {
      const canRetry = attempt < this.config.maxRetries;
      let delayMs: number;
      try {
        const outcome = await this.attempt(method, path, url, init, canRetry);
        if (outcome.kind === 'done') return parseResponse(outcome, method, path);
        delayMs = statusRetryDelayMs(outcome.response, attempt);
      } catch (err) {
        if (!canRetry || !(err instanceof AirbrakeNetworkError)) throw err;
        delayMs = backoffMs(attempt);
      }
      await sleep(delayMs);
      attempt++;
    }
  }

  // One HTTP attempt under a single deadline covering connect, headers and the
  // full body read — clearing the timer when headers arrive would let a server
  // that stalls mid-body hang the tool call forever. When the caller can retry
  // a retriable status, the body is cancelled unread (releasing the socket).
  // Throws AirbrakeNetworkError for transport failures and timeouts at either
  // stage, and AirbrakeApiError for an oversized body.
  private async attempt(
    method: HttpMethod,
    path: string,
    url: string,
    init: RequestInit,
    canRetry: boolean,
  ): Promise<AttemptOutcome> {
    const { timeoutMs } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      if (canRetry && isRetriable(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'retry', response };
      }
      const text =
        response.status === 204 ? '' : await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
      return { kind: 'done', response, text };
    } catch (err) {
      if (response && err instanceof ResponseTooLargeError) {
        throw new AirbrakeApiError(response.status, method, path, { message: err.message });
      }
      const cause = describeFailure(err, controller.signal.aborted, timeoutMs, response?.status);
      throw new AirbrakeNetworkError(method, path, cause);
    } finally {
      clearTimeout(timer);
    }
  }
}

type AttemptOutcome =
  /** Retriable status the caller will retry; body cancelled unread. */
  | { kind: 'retry'; response: Response }
  /** Final response with its fully-read body. */
  | { kind: 'done'; response: Response; text: string };

function statusRetryDelayMs(response: Response, attempt: number): number {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  return Math.min(MAX_RETRY_DELAY_MS, retryAfterMs ?? backoffMs(attempt));
}

function parseResponse(
  outcome: { response: Response; text: string },
  method: HttpMethod,
  path: string,
): unknown {
  const { response, text } = outcome;
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new AirbrakeApiError(response.status, method, path, parsed);
  }
  return parsed;
}

// The cause for an AirbrakeNetworkError. A timeout states the deadline; a
// failure after the headers arrived names the HTTP status, which would
// otherwise be lost. A fetch-stage transport error is passed through as is.
function describeFailure(
  err: unknown,
  timedOut: boolean,
  timeoutMs: number,
  status: number | undefined,
): unknown {
  const reason = timedOut
    ? `request timed out after ${timeoutMs}ms`
    : err instanceof Error
      ? err.message
      : String(err);
  if (status !== undefined) {
    return new Error(`${reason} while reading the HTTP ${status} response body`, { cause: err });
  }
  return timedOut ? new Error(reason, { cause: err }) : err;
}

// Reads the body via a streaming reader and aborts if it exceeds `max` bytes.
// Pre-checks Content-Length to fail fast when the server is honest about size.
// Exported for direct testing — the production cap (25 MB) is too large to
// allocate in a unit test, so tests exercise the cap logic with a small max.
export async function readBodyWithLimit(response: Response, max: number): Promise<string> {
  const cl = response.headers.get('content-length');
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > max) {
      throw new ResponseTooLargeError(`response body exceeds ${max} bytes (Content-Length: ${n})`);
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new ResponseTooLargeError(`response body exceeds ${max} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel(); ignore
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}
