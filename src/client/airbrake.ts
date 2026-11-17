import type { Config } from '../config.js';
import { AirbrakeApiError, AirbrakeNetworkError } from './errors.js';
import { classifyFetchError, failureHint, isRetriable, type RetryOutcome } from './retry-policy.js';

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
  /**
   * - `FormData`: sent as multipart/form-data; fetch generates the boundary,
   *   so any caller-supplied content-type is dropped.
   * - `string`: sent verbatim; caller controls content-type via `headers`.
   * - anything else: JSON-serialized with `content-type: application/json`.
   */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Raise the per-attempt timeout to at least this many ms for this request
   * (the effective timeout is max(config.timeoutMs, minTimeoutMs)).
   */
  minTimeoutMs?: number;
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

interface EncodedBody {
  body: string | FormData | undefined;
  headers: Record<string, string>;
}

// Encodes the request body and returns the headers that must accompany it.
// FormData is passed through untouched: fetch serializes it fresh on every
// call (it is not a one-shot stream), so retries re-send the complete body,
// and fetch sets `content-type: multipart/form-data; boundary=…` itself — a
// caller-supplied content-type would carry the wrong boundary, so drop it.
function encodeBody(input: unknown, headers: Record<string, string>): EncodedBody {
  if (input === undefined) return { body: undefined, headers };
  if (input instanceof FormData) {
    const withoutContentType = Object.fromEntries(
      Object.entries(headers).filter(([k]) => k !== 'content-type'),
    );
    return { body: input, headers: withoutContentType };
  }
  if (typeof input === 'string') return { body: input, headers };
  return {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json', ...headers },
  };
}

export class AirbrakeClient {
  constructor(private readonly config: Config) {}

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = `${this.config.host}${path}${buildQuery(options.query)}`;
    if (options.auth !== 'none' && !this.config.userToken) {
      throw new AirbrakeApiError(401, method, path, {
        message: 'AIRBRAKE_USER_TOKEN env var is required',
      });
    }
    const { body, headers } = encodeBody(options.body, {
      accept: 'application/json',
      ...sanitizeUserHeaders(options.headers),
      ...(options.auth !== 'none' ? { authorization: `Bearer ${this.config.userToken}` } : {}),
    });
    const timeoutMs = Math.max(this.config.timeoutMs, options.minTimeoutMs ?? 0);

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;

    // Single retry decision point, gated by the method-aware policy in
    // retry-policy.ts: a retriable status waits for Retry-After (capped) or
    // backoff; a retriable transport failure (incl. timeouts at either stage)
    // waits for backoff. Anything else returns or throws.
    let attempt = 0;
    while (true) {
      const canRetry = attempt < this.config.maxRetries;
      const outcome = await this.attempt(method, path, url, init, timeoutMs, canRetry);
      if (outcome.kind === 'done') return parseResponse(outcome, method, path);
      let delayMs: number;
      if (outcome.kind === 'retry') {
        delayMs = statusRetryDelayMs(outcome.response, attempt);
      } else {
        if (!canRetry || !isRetriable(method, outcome.failure)) throw outcome.error;
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
  // Transport failures and timeouts at either stage come back as 'failed' with
  // their retry classification; an oversized body throws AirbrakeApiError.
  private async attempt(
    method: HttpMethod,
    path: string,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    canRetry: boolean,
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      if (canRetry && isRetriable(method, { kind: 'status', status: response.status })) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'retry', response };
      }
      const text =
        response.status === 204 ? '' : await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
      return { kind: 'done', response, text };
    } catch (err) {
      if (response && err instanceof ResponseTooLargeError) {
        const hint = failureHint(method, { kind: 'status', status: response.status });
        throw new AirbrakeApiError(response.status, method, path, { message: err.message }, hint);
      }
      // After the headers arrived the server has answered, so the request
      // was certainly sent: a body-read failure is always ambiguous.
      const failure: RetryOutcome = response ? { kind: 'network-error' } : classifyFetchError(err);
      const cause = describeFailure(err, controller.signal.aborted, timeoutMs, response?.status);
      const error = new AirbrakeNetworkError(method, path, cause, failureHint(method, failure));
      return { kind: 'failed', error, failure };
    } finally {
      clearTimeout(timer);
    }
  }
}

type AttemptOutcome =
  /** Retriable status the caller will retry; body cancelled unread. */
  | { kind: 'retry'; response: Response }
  /** Final response with its fully-read body. */
  | { kind: 'done'; response: Response; text: string }
  /** Transport failure or timeout; the caller applies the retry policy. */
  | { kind: 'failed'; error: AirbrakeNetworkError; failure: RetryOutcome };

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
    const hint = failureHint(method, { kind: 'status', status: response.status });
    throw new AirbrakeApiError(response.status, method, path, parsed, hint);
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
