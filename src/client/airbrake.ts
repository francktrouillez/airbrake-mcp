import type { Config } from '../config.js';
import { AirbrakeApiError, AirbrakeNetworkError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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
        const delay = retryAfterMs !== null ? retryAfterMs : backoffMs(attempt);
        await sleep(delay);
        attempt++;
        continue;
      }

      const text = response.status === 204 ? '' : await response.text();
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
