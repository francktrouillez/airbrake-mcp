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

export class AirbrakeClient {
  constructor(private readonly config: Config) {}

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = `${this.config.host}${path}${buildQuery(options.query)}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.headers ?? {}),
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

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      try {
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (body !== undefined) init.body = body;
        response = await fetch(url, init);
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.config.maxRetries) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new AirbrakeNetworkError(method, path, err);
      }
      clearTimeout(timer);

      if (isRetriable(response.status) && attempt < this.config.maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const rawDelay = retryAfterMs !== null ? retryAfterMs : backoffMs(attempt);
        const delay = Math.min(MAX_RETRY_DELAY_MS, rawDelay);
        await sleep(delay);
        attempt++;
        continue;
      }

      let text = '';
      if (response.status !== 204) {
        try {
          text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
        } catch (err) {
          throw new AirbrakeApiError(response.status, method, path, {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
  }
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
      throw new Error(`response body exceeds ${max} bytes (Content-Length: ${n})`);
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
        throw new Error(`response body exceeds ${max} bytes`);
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
