// Which failed attempts may be re-sent. The core risk is an *ambiguous*
// failure — a 5xx, a dropped connection or a timeout — where the server may
// already have acted on the request: re-sending a POST then creates duplicate
// notices / deploy markers.

import type { HttpMethod } from './airbrake.js';

/** What happened on one attempt. */
export type RetryOutcome =
  /** The server answered with this HTTP status. */
  | { kind: 'status'; status: number }
  /** The connection was never established, so nothing reached the server. */
  | { kind: 'not-sent' }
  /** The request failed after connecting, or timed out: its effect is unknown. */
  | { kind: 'network-error' };

// Methods safe to re-send after an ambiguous failure. GET/HEAD are read-only
// and PUT sets an absolute state, so a repeat does not compound. DELETE is
// idempotent in effect but NOT in response: if the first DELETE succeeded and
// its response was lost, the retry gets a 404 and the tool reports failure for
// an operation that actually succeeded. POST/PATCH would create duplicates or
// re-apply a delta.
const AMBIGUOUS_FAILURE_RETRY_METHODS: ReadonlySet<RetryMethod> = new Set(['GET', 'HEAD', 'PUT']);

/** HEAD is not sent by any tool today, but the policy covers it. */
export type RetryMethod = HttpMethod | 'HEAD';

// Codes that only arise in DNS lookup or connection setup, before any request
// byte is written.
const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// Unreachable / timed-out errors can also hit an established socket mid-request;
// only a failed connect() proves nothing was sent.
const CONNECT_ONLY_CODES: ReadonlySet<string> = new Set([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);

interface ErrorFields {
  code?: unknown;
  syscall?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function isNotSentError(err: unknown, depth: number): boolean {
  if (depth > 4 || typeof err !== 'object' || err === null) return false;
  const { code, syscall, cause, errors } = err as ErrorFields;
  if (typeof code === 'string') {
    if (PRE_SEND_CODES.has(code)) return true;
    if (CONNECT_ONLY_CODES.has(code) && syscall === 'connect') return true;
  }
  // Happy-eyeballs connect failures arrive as an AggregateError of per-address errors.
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((e) => isNotSentError(e, depth + 1));
  }
  return isNotSentError(cause, depth + 1);
}

/** Classify a `fetch` rejection: connect-phase failures are 'not-sent', all else ambiguous. */
export function classifyFetchError(err: unknown): RetryOutcome {
  return isNotSentError(err, 0) ? { kind: 'not-sent' } : { kind: 'network-error' };
}

function isAmbiguous(outcome: RetryOutcome): boolean {
  if (outcome.kind === 'status') return outcome.status >= 500 && outcome.status < 600;
  return outcome.kind === 'network-error';
}

/**
 * Retry policy. 429 and 'not-sent' are retried for every method: the server
 * never processed the request. Ambiguous failures (5xx, network errors,
 * timeouts) are retried only for AMBIGUOUS_FAILURE_RETRY_METHODS.
 */
export function isRetriable(method: RetryMethod, outcome: RetryOutcome): boolean {
  if (outcome.kind === 'not-sent') return true;
  if (outcome.kind === 'status' && outcome.status === 429) return true;
  return isAmbiguous(outcome) && AMBIGUOUS_FAILURE_RETRY_METHODS.has(method);
}

/**
 * Context for the final error of a request, telling the caller (an LLM)
 * whether re-sending is safe. Undefined when the error speaks for itself.
 */
export function failureHint(method: RetryMethod, outcome: RetryOutcome): string | undefined {
  if (outcome.kind === 'not-sent') return 'connection failed; the request was not sent';
  if (isAmbiguous(outcome) && !isRetriable(method, outcome)) {
    return `not retried: resending ${method} is unsafe; the request may have been applied`;
  }
  return undefined;
}
