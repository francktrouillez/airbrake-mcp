import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { AirbrakeClient, MAX_RESPONSE_BYTES, type HttpMethod } from '../../src/client/airbrake.js';
import { AirbrakeApiError, AirbrakeNetworkError } from '../../src/client/errors.js';
import {
  classifyFetchError,
  failureHint,
  isRetriable,
  type RetryOutcome,
} from '../../src/client/retry-policy.js';

const HOST = 'https://api.airbrake.io';
const PATH = '/api/v4/projects/1/thing';
const HINT = /not retried: resending \w+ is unsafe; the request may have been applied/;
const NOT_SENT_HINT = '(connection failed; the request was not sent)';

const NETWORK: RetryOutcome = { kind: 'network-error' };
const NOT_SENT: RetryOutcome = { kind: 'not-sent' };
const status = (s: number): RetryOutcome => ({ kind: 'status', status: s });

// Mirrors undici: `TypeError('fetch failed')` with the errno error as `cause`.
const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });
const errno = (code: string, syscall?: string): Error =>
  Object.assign(new Error(`${syscall ?? 'connect'} ${code}`), { code, syscall });

const baseConfig = {
  userToken: 'tok_abc',
  projectKeys: {},
  host: HOST,
  timeoutMs: 5000,
  maxRetries: 2,
};

describe('isRetriable (retry policy)', () => {
  const AMBIGUOUS: RetryOutcome[] = [500, 502, 503, 504, 599].map(status).concat(NETWORK);
  const NEVER: RetryOutcome[] = [200, 201, 204, 301, 400, 401, 404, 409, 422, 499, 600].map(status);

  it.each([
    ['GET', true],
    ['HEAD', true],
    ['PUT', true],
    ['POST', false],
    ['PATCH', false],
    ['DELETE', false],
  ] as const)('%s: 429/not-sent always retried, 5xx/network retried=%s', (m, ambiguous) => {
    expect(isRetriable(m, status(429))).toBe(true);
    expect(isRetriable(m, NOT_SENT)).toBe(true);
    for (const o of AMBIGUOUS) expect(isRetriable(m, o), JSON.stringify(o)).toBe(ambiguous);
    for (const o of NEVER) expect(isRetriable(m, o), JSON.stringify(o)).toBe(false);
  });
});

describe('classifyFetchError', () => {
  it.each([
    errno('ECONNREFUSED'),
    errno('ENOTFOUND'),
    errno('EAI_AGAIN'),
    errno('UND_ERR_CONNECT_TIMEOUT'),
    errno('ENETUNREACH', 'connect'),
    errno('EHOSTUNREACH', 'connect'),
    errno('ETIMEDOUT', 'connect'),
  ])('treats $code (syscall: $syscall) as not-sent', (cause) => {
    expect(classifyFetchError(fetchFailed(cause))).toEqual(NOT_SENT);
  });

  it('treats an AggregateError of connect failures as not-sent', () => {
    const agg = new AggregateError([errno('ECONNREFUSED'), errno('ENETUNREACH', 'connect')]);
    expect(classifyFetchError(fetchFailed(agg))).toEqual(NOT_SENT);
  });

  it.each([
    // Unreachable errors on an established socket may follow a sent request.
    ['EHOSTUNREACH on write', fetchFailed(errno('EHOSTUNREACH', 'write'))],
    ['ENETUNREACH without syscall', fetchFailed(errno('ENETUNREACH'))],
    ['ETIMEDOUT on read', fetchFailed(errno('ETIMEDOUT', 'read'))],
    ['ECONNRESET (may have been sent)', fetchFailed(errno('ECONNRESET'))],
    ['EPIPE', fetchFailed(errno('EPIPE'))],
    ['UND_ERR_SOCKET', fetchFailed(errno('UND_ERR_SOCKET'))],
    ['a timeout abort', new DOMException('The operation was aborted', 'AbortError')],
    [
      'a mixed AggregateError',
      fetchFailed(new AggregateError([errno('ECONNREFUSED'), errno('ECONNRESET')])),
    ],
    ['an empty AggregateError', fetchFailed(new AggregateError([]))],
    ['a plain string', 'boom'],
    ['null', null],
    ['an error with no code', new Error('fetch failed')],
  ])('treats %s as an ambiguous network error', (_label, err) => {
    expect(classifyFetchError(err)).toEqual(NETWORK);
  });

  it('stops descending a pathological cause chain', () => {
    let err: { cause?: unknown } = errno('ECONNREFUSED');
    for (let i = 0; i < 10; i++) err = { cause: err };
    expect(classifyFetchError(err)).toEqual(NETWORK);
  });
});

// The method × failure table below covers the "may have been applied" hint.
describe('failureHint', () => {
  it('says a not-sent request was not sent, for every method', () => {
    expect(failureHint('POST', NOT_SENT)).toBe('connection failed; the request was not sent');
    expect(failureHint('GET', NOT_SENT)).toBe('connection failed; the request was not sent');
  });

  it('hints a 504 only when the method is not retried', () => {
    expect(failureHint('GET', status(504))).toBeUndefined();
    expect(failureHint('POST', status(504))).toMatch(HINT);
  });
});

describe('AirbrakeClient retry behaviour by method', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nock.cleanAll();
    // Pin jitter to its minimum so backoff sleeps stay short (125ms, 250ms).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  type Failure = 429 | 500 | 503 | 'network';
  const failures: Failure[] = [429, 500, 503, 'network'];
  const methods: HttpMethod[] = ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'];
  const retriesOn = (m: HttpMethod, f: Failure): boolean => f === 429 || m === 'GET' || m === 'PUT';

  function failForever(method: HttpMethod, failure: Failure): void {
    const interceptor = nock(HOST).intercept(PATH, method).times(10);
    if (failure === 'network') {
      interceptor.replyWithError('ECONNRESET');
    } else {
      // Retry-After: 0 keeps the 429/5xx cases fast; backoff is unchanged.
      interceptor.reply(failure, { message: 'nope' }, { 'Retry-After': '0' });
    }
  }

  async function requestError(method: HttpMethod, maxRetries = 2): Promise<Error> {
    const client = new AirbrakeClient({ ...baseConfig, maxRetries });
    return client.request(method, PATH).then(
      () => expect.fail('expected the request to fail'),
      (e: unknown) => e as Error,
    );
  }

  const table = methods.flatMap((m) =>
    failures.map((f) => ({ method: m, failure: f, retries: retriesOn(m, f) })),
  );

  it.each(table)(
    '$method on persistent $failure (maxRetries=2): retried=$retries, correct error and hint',
    async ({ method, failure, retries }) => {
      failForever(method, failure);
      const err = await requestError(method);
      expect(fetchSpy).toHaveBeenCalledTimes(retries ? 3 : 1);
      if (failure === 'network') {
        expect(err).toBeInstanceOf(AirbrakeNetworkError);
        expect(err).toMatchObject({ method, path: PATH, cause: expect.any(Error) });
        expect(err.message).toContain(`Airbrake network error on ${method} ${PATH}: ECONNRESET`);
      } else {
        expect(err).toMatchObject({ name: 'AirbrakeApiError', status: failure, method });
      }
      // The hint marks exactly the ambiguous failures we refused to retry.
      // 429 never gets it: the server rejected the request unprocessed.
      if (retries) expect(err.message).not.toMatch(HINT);
      else expect(err.message).toContain(`(not retried: resending ${method} is unsafe;`);
    },
  );

  // One transient failure, then success: a single retry recovers the request.
  it.each([
    { method: 'POST', fail: 'refused', ok: 200 },
    { method: 'PATCH', fail: 'refused', ok: 200 },
    { method: 'DELETE', fail: 'refused', ok: 200 },
    { method: 'GET', fail: 'reset', ok: 200 },
    { method: 'PUT', fail: 503, ok: 200 },
    { method: 'DELETE', fail: 429, ok: 204 },
  ] as const)('$method $fail then $ok succeeds after 2 attempts', async ({ method, fail, ok }) => {
    const first = nock(HOST).intercept(PATH, method);
    const scope =
      fail === 'refused'
        ? first.replyWithError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })
        : fail === 'reset'
          ? first.replyWithError('ECONNRESET')
          : first.reply(fail, '', { 'Retry-After': '0' });
    scope.intercept(PATH, method).reply(ok, ok === 204 ? undefined : { ok: true });
    const client = new AirbrakeClient(baseConfig);
    await expect(client.request(method, PATH)).resolves.toEqual(ok === 204 ? null : { ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('POST persistent connect failure exhausts retries and says the request was not sent', async () => {
    nock(HOST)
      .post(PATH)
      .times(10)
      .replyWithError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' });
    const err = await requestError('POST');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(AirbrakeNetworkError);
    expect(err.message).toContain(NOT_SENT_HINT);
    expect(err.message).not.toMatch(HINT);
  });

  it('POST 429 then 201 succeeds after 2 attempts, re-sending the same body', async () => {
    nock(HOST)
      .post(PATH, { a: 1 })
      .reply(429, '', { 'Retry-After': '0' })
      .post(PATH, { a: 1 })
      .reply(201, { id: 'n_1' });
    const client = new AirbrakeClient(baseConfig);
    await expect(client.request('POST', PATH, { body: { a: 1 } })).resolves.toEqual({ id: 'n_1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('POST 4xx is final and carries no hint (the server answered definitively)', async () => {
    nock(HOST).post(PATH).reply(422, { message: 'invalid' });
    const err = await requestError('POST');
    expect(err).toMatchObject({ name: 'AirbrakeApiError', status: 422 });
    expect(err.message).not.toMatch(HINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('POST network error still carries the hint with maxRetries=0 (equally ambiguous)', async () => {
    failForever('POST', 'network');
    const err = await requestError('POST', 0);
    expect(err.message).toMatch(HINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // AIRBRAKE_TIMEOUT_MS aborts are ambiguous: the server may still be working.
  it.each([
    ['POST', 1],
    ['GET', 3],
  ] as const)('%s timeout makes %i attempt(s)', async (method, attempts) => {
    // A server that never answers: only the client's own abort ends the attempt.
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal!;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const client = new AirbrakeClient({ ...baseConfig, timeoutMs: 50 });
    const err = await client.request(method, PATH).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(AirbrakeNetworkError);
    expect(fetchSpy).toHaveBeenCalledTimes(attempts);
    if (method === 'POST') expect(err.message).toMatch(HINT);
    else expect(err.message).not.toMatch(HINT);
  });

  it('POST 502 whose body cannot be read still carries the hint', async () => {
    nock(HOST)
      .post(PATH)
      .reply(502, 'x', { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
    const err = await requestError('POST');
    expect(err).toMatchObject({ name: 'AirbrakeApiError', status: 502 });
    expect(err.message).toMatch(/exceeds/);
    expect(err.message).toMatch(HINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('error hints', () => {
  it('AirbrakeNetworkError appends the hint in parentheses, or nothing without one', () => {
    const cause = new Error('ECONNRESET');
    expect(new AirbrakeNetworkError('POST', '/p', cause, 'some hint').message).toBe(
      'Airbrake network error on POST /p: ECONNRESET (some hint)',
    );
    expect(new AirbrakeNetworkError('GET', '/p', cause).message).toBe(
      'Airbrake network error on GET /p: ECONNRESET',
    );
  });

  it('AirbrakeApiError appends the hint in parentheses, or nothing without one', () => {
    expect(new AirbrakeApiError(503, 'POST', '/p', { m: 1 }, 'some hint').message).toBe(
      'Airbrake API error 503 on POST /p: {"m":1} (some hint)',
    );
    expect(new AirbrakeApiError(503, 'GET', '/p', { m: 1 }).message).toBe(
      'Airbrake API error 503 on GET /p: {"m":1}',
    );
  });
});
