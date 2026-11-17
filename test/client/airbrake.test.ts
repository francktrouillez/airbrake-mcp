import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { PassThrough } from 'node:stream';
import {
  AirbrakeClient,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_DELAY_MS,
  ResponseTooLargeError,
  backoffMs,
  parseRetryAfter,
  readBodyWithLimit,
} from '../../src/client/airbrake.js';
import { AirbrakeApiError, AirbrakeNetworkError } from '../../src/client/errors.js';

const baseConfig = {
  userToken: 'tok_abc',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 2,
};

describe('AirbrakeClient', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('sends Bearer auth header on GET', async () => {
    nock('https://api.airbrake.io', { reqheaders: { authorization: 'Bearer tok_abc' } })
      .get('/api/v4/projects')
      .reply(200, { projects: [] });

    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects');
    expect(result).toEqual({ projects: [] });
  });

  it('serializes query params', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({ page: '2', per_page: '10' })
      .reply(200, { groups: [] });

    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects/1/groups', {
      query: { page: 2, per_page: 10 },
    });
    expect(result).toEqual({ groups: [] });
  });

  it('sends JSON body on POST', async () => {
    nock('https://api.airbrake.io')
      .post('/api/v4/projects/1/deploys', { environment: 'prod', revision: 'abc' })
      .reply(201, { id: 99 });

    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('POST', '/api/v4/projects/1/deploys', {
      body: { environment: 'prod', revision: 'abc' },
    });
    expect(result).toEqual({ id: 99 });
  });

  it('throws AirbrakeApiError on 4xx with body', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/999')
      .reply(404, { message: 'not found' });
    const client = new AirbrakeClient(baseConfig);
    await expect(client.request('GET', '/api/v4/projects/999')).rejects.toMatchObject({
      name: 'AirbrakeApiError',
      status: 404,
      body: { message: 'not found' },
    });
  });

  it('retries on 429 honoring Retry-After', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .reply(429, '', { 'Retry-After': '0' })
      .get('/api/v4/projects')
      .reply(200, { projects: [{ id: 1 }] });

    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects');
    expect(result).toEqual({ projects: [{ id: 1 }] });
  });

  it('retries on 429 honoring Retry-After in HTTP-date format', async () => {
    // Past date — server is saying "wait until then" but it's already past,
    // so we should retry immediately (max(0, past - now) === 0).
    const past = new Date(Date.now() - 1000).toUTCString();
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .reply(429, '', { 'Retry-After': past })
      .get('/api/v4/projects')
      .reply(200, { ok: true });

    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects');
    expect(result).toEqual({ ok: true });
  });

  it('retries on 5xx with backoff up to maxRetries', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .reply(500, 'boom')
      .get('/api/v4/projects')
      .reply(500, 'boom')
      .get('/api/v4/projects')
      .reply(200, { projects: [] });

    const client = new AirbrakeClient({ ...baseConfig, maxRetries: 2 });
    const result = await client.request('GET', '/api/v4/projects');
    expect(result).toEqual({ projects: [] });
  });

  it('surfaces final 5xx after exhausting retries', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .times(3)
      .reply(500, { message: 'boom' });

    const client = new AirbrakeClient({ ...baseConfig, maxRetries: 2 });
    await expect(client.request('GET', '/api/v4/projects')).rejects.toMatchObject({ status: 500 });
  });

  it('wraps fetch failures as AirbrakeNetworkError', async () => {
    nock('https://api.airbrake.io').get('/api/v4/projects').replyWithError('ECONNRESET');
    const client = new AirbrakeClient({ ...baseConfig, maxRetries: 0 });
    await expect(client.request('GET', '/api/v4/projects')).rejects.toBeInstanceOf(
      AirbrakeNetworkError,
    );
  });

  it('returns null for empty 204 responses', async () => {
    nock('https://api.airbrake.io').delete('/api/v4/projects/1/groups/2').reply(204);
    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('DELETE', '/api/v4/projects/1/groups/2');
    expect(result).toBeNull();
  });

  it('parses huge Retry-After dates but clamping is applied in request()', () => {
    // A server-supplied year-9999 date parses to ~253 trillion ms. The cap in
    // request() must clamp this so the client doesn't stall forever holding
    // the bearer token.
    const huge = parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT');
    expect(huge).not.toBeNull();
    expect(huge!).toBeGreaterThan(MAX_RETRY_DELAY_MS);
    // The clamp formula used in client.request:
    expect(Math.min(MAX_RETRY_DELAY_MS, huge!)).toBe(MAX_RETRY_DELAY_MS);
  });

  it('rejects oversized response body via Content-Length without retrying', async () => {
    // Only one interceptor: a retry would hit nock's "no match" and surface
    // as AirbrakeNetworkError instead.
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .reply(200, 'x', { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
    const client = new AirbrakeClient({ ...baseConfig, maxRetries: 2 });
    await expect(client.request('GET', '/api/v4/projects')).rejects.toMatchObject({
      name: 'AirbrakeApiError',
      status: 200,
    });
  });

  describe('request timeout', () => {
    const PROJECTS = '/api/v4/projects';
    const api = (): nock.Scope => nock('https://api.airbrake.io');
    const client = (timeoutMs: number, maxRetries: number): AirbrakeClient =>
      new AirbrakeClient({ ...baseConfig, timeoutMs, maxRetries });
    const failure = (c: AirbrakeClient, path: string = PROJECTS): Promise<unknown> =>
      c.request('GET', path).then(
        () => expect.fail('expected the request to reject'),
        (e: unknown) => e,
      );

    // A body that sends a partial JSON chunk and then never ends — the
    // "headers arrive, then the server stalls mid-body" failure mode.
    const stalledBody = (): PassThrough => {
      const s = new PassThrough();
      s.write('{"projects":[');
      return s;
    };

    afterEach(() => {
      // Drop nock's pending `.delay()` timers so they don't try to answer a
      // request the client has already aborted.
      nock.abortPendingRequests();
      vi.restoreAllMocks();
    });

    it('applies the deadline to a body that stalls after the headers', async () => {
      api().get(PROJECTS).reply(200, stalledBody);
      const started = Date.now();
      const err = await failure(client(200, 0));
      expect(err).toBeInstanceOf(AirbrakeNetworkError);
      expect(err).not.toBeInstanceOf(AirbrakeApiError);
      expect((err as Error).message).toBe(
        'Airbrake network error on GET /api/v4/projects: ' +
          'request timed out after 200ms while reading the HTTP 200 response body',
      );
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('retries a body-stage timeout and returns the subsequent success', async () => {
      const scope = api()
        .get(PROJECTS)
        .reply(200, stalledBody)
        .get(PROJECTS)
        .reply(200, { projects: [{ id: 1 }] });
      await expect(client(200, 1).request('GET', PROJECTS)).resolves.toEqual({
        projects: [{ id: 1 }],
      });
      expect(scope.isDone()).toBe(true);
    });

    it('never retries a POST whose body read failed: the server already answered', async () => {
      // Headers arrived, so the request was certainly applied; a body-stage
      // failure is ambiguous and must go through the method-aware policy.
      const scope = api().post('/api/v4/projects/1/deploys').reply(201, stalledBody);
      const err = await client(150, 2)
        .request('POST', '/api/v4/projects/1/deploys', { body: { environment: 'production' } })
        .then(
          () => expect.fail('expected the request to reject'),
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(AirbrakeNetworkError);
      expect((err as Error).message).toMatch(
        /while reading the HTTP 201 response body \(not retried: resending POST is unsafe/,
      );
      expect(scope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('never treats a body-stage failure as "not sent", whatever its error code', async () => {
      // A connect-phase code in the cause chain would otherwise classify as
      // 'not-sent' and re-send the POST; once headers arrived it was sent.
      const connectLike = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const scope = api()
        .post('/api/v4/projects/1/deploys')
        .reply(201, () => {
          const s = stalledBody();
          setTimeout(() => s.destroy(connectLike), 20);
          return s;
        });
      const err = await client(5000, 2)
        .request('POST', '/api/v4/projects/1/deploys', { body: {} })
        .then(
          () => expect.fail('expected the request to reject'),
          (e: unknown) => e,
        );
      // The error is the first attempt's: a re-sent POST would surface nock's
      // "No match for request" from the second attempt instead.
      expect((err as Error).message).toMatch(
        /while reading the HTTP 201 response body \(not retried: resending POST is unsafe/,
      );
      expect(scope.isDone()).toBe(true);
    });

    it('surfaces a body-stage timeout after exhausting retries', async () => {
      const scope = api().get(PROJECTS).times(2).reply(200, stalledBody);
      const err = await failure(client(150, 1));
      expect((err as Error).message).toMatch(/request timed out after 150ms/);
      expect(scope.isDone()).toBe(true);
    });

    it('keeps the HTTP status in the error when a final error response stalls', async () => {
      api().get(PROJECTS).reply(503, stalledBody);
      const err = await failure(client(150, 0));
      expect(err).toBeInstanceOf(AirbrakeNetworkError);
      expect((err as Error).message).toMatch(
        /timed out after 150ms while reading the HTTP 503 response body/,
      );
    });

    it('cancels the unread body of a retried 5xx without waiting for it', async () => {
      // The 503 body stalls forever; the retry must not wait for it (it is
      // cancelled, not read), so this resolves well inside the 2s deadline.
      api()
        .get(PROJECTS)
        .reply(503, stalledBody, { 'Retry-After': '0' })
        .get(PROJECTS)
        .reply(200, { projects: [] });
      const cancelSpy = vi.spyOn(ReadableStream.prototype, 'cancel');
      const started = Date.now();
      await expect(client(2000, 1).request('GET', PROJECTS)).resolves.toEqual({ projects: [] });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('reports a header-stage timeout with the configured duration', async () => {
      api().get(PROJECTS).delay(5000).reply(200, { projects: [] });
      const err = await failure(client(200, 0));
      expect(err).toBeInstanceOf(AirbrakeNetworkError);
      expect((err as Error).message).toBe(
        'Airbrake network error on GET /api/v4/projects: request timed out after 200ms',
      );
    });

    it('wraps a connection failure mid-body as AirbrakeNetworkError', async () => {
      api()
        .get(PROJECTS)
        .reply(200, () => {
          const s = stalledBody();
          setTimeout(() => s.destroy(new Error('socket hang up')), 20);
          return s;
        });
      const err = await failure(client(5000, 0));
      expect(err).toBeInstanceOf(AirbrakeNetworkError);
      expect(err).not.toBeInstanceOf(AirbrakeApiError);
      expect((err as Error).message).toMatch(/while reading the HTTP 200 response body/);
      expect((err as Error).message).not.toMatch(/timed out/);
    });

    it('still succeeds when a slow body completes within the deadline', async () => {
      api()
        .get(PROJECTS)
        .delayBody(100)
        .reply(200, { projects: [{ id: 2 }] });
      await expect(client(1000, 0).request('GET', PROJECTS)).resolves.toEqual({
        projects: [{ id: 2 }],
      });
    });

    describe('abort timer lifecycle', () => {
      // A distinctive timeout value identifies the client's abort timers among
      // any other timers nock or undici schedule.
      const TRACKED_MS = 377;
      let setSpy: { mock: { calls: unknown[][]; results: { value: unknown }[] } };
      let clearSpy: { mock: { calls: unknown[][] } };
      const armed = (): unknown[] =>
        setSpy.mock.results
          .filter((_, i) => setSpy.mock.calls[i]?.[1] === TRACKED_MS)
          .map((r) => r.value);
      const isCleared = (timer: unknown): boolean =>
        clearSpy.mock.calls.some((c) => c[0] === timer);

      beforeEach(() => {
        setSpy = vi.spyOn(globalThis, 'setTimeout');
        clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      });

      it('clears every attempt timer on success, error, retry and timeout paths', async () => {
        api()
          .get(PROJECTS)
          .reply(503, '', { 'Retry-After': '0' })
          .get(PROJECTS)
          .reply(200, { projects: [] })
          .get('/api/v4/projects/1')
          .reply(404, { message: 'nope' })
          .get('/api/v4/projects/2')
          .replyWithError('ECONNRESET')
          .get('/api/v4/projects/3')
          .reply(200, stalledBody);
        const c = client(TRACKED_MS, 1);

        await c.request('GET', PROJECTS); // 503 then 200
        await failure(c, '/api/v4/projects/1'); // 404
        await failure(c, '/api/v4/projects/2'); // ECONNRESET, then "no match" on retry
        await failure(c, '/api/v4/projects/3'); // body timeout, then "no match" on retry

        expect(armed()).toHaveLength(7);
        for (const timer of armed()) expect(isCleared(timer)).toBe(true);
      });

      it('keeps the deadline armed until the body has been fully read', async () => {
        let clearedBeforeBodyEnd: boolean | undefined;
        api()
          .get(PROJECTS)
          .reply(200, () => {
            const s = stalledBody();
            setTimeout(() => {
              clearedBeforeBodyEnd = isCleared(armed()[0]);
              s.end(']}');
            }, 50);
            return s;
          });
        await expect(client(TRACKED_MS, 0).request('GET', PROJECTS)).resolves.toEqual({
          projects: [],
        });
        expect(clearedBeforeBodyEnd).toBe(false);
        expect(armed()).toHaveLength(1);
        expect(isCleared(armed()[0])).toBe(true);
      });
    });
  });

  describe('readBodyWithLimit helper', () => {
    it('reads bodies under the cap', async () => {
      const body = 'hello';
      const resp = new Response(body);
      const out = await readBodyWithLimit(resp, 1024);
      expect(out).toBe(body);
    });

    it('rejects bodies that exceed the streamed cap', async () => {
      const tinyCap = 16;
      const big = 'a'.repeat(tinyCap + 1);
      const resp = new Response(big);
      await expect(readBodyWithLimit(resp, tinyCap)).rejects.toThrow(/exceeds 16 bytes/);
    });

    it('signals the cap with ResponseTooLargeError (mapped to AirbrakeApiError, not a network error)', async () => {
      const resp = new Response('a'.repeat(32));
      await expect(readBodyWithLimit(resp, 16)).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it('rejects upfront on oversized Content-Length', async () => {
      // Build a response whose Content-Length declares too many bytes.
      const resp = new Response('x', { headers: { 'content-length': '999' } });
      await expect(readBodyWithLimit(resp, 100)).rejects.toThrow(/Content-Length/);
    });

    it('handles null body without throwing', async () => {
      const resp = new Response(null, { status: 204 });
      const out = await readBodyWithLimit(resp, 1024);
      expect(out).toBe('');
    });
  });

  describe('parseRetryAfter helper', () => {
    it('parses integer seconds', () => {
      expect(parseRetryAfter('5')).toBe(5000);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('parses HTTP-date relative to now', () => {
      const now = Date.parse('2026-05-23T12:00:00Z');
      expect(parseRetryAfter('Sat, 23 May 2026 12:00:10 GMT', now)).toBe(10_000);
    });

    it('clamps past HTTP-dates to 0', () => {
      const now = Date.parse('2026-05-23T12:00:00Z');
      expect(parseRetryAfter('Sat, 23 May 2026 11:00:00 GMT', now)).toBe(0);
    });

    it('returns null for absent or unparseable values', () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter('')).toBeNull();
      expect(parseRetryAfter('not-a-date')).toBeNull();
    });

    it('treats whitespace-only as no number and no date', () => {
      expect(parseRetryAfter('   ')).toBeNull();
    });
  });

  describe('backoffMs helper', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns 50%–100% of 2^attempt * baseMs', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(backoffMs(0, 200)).toBe(100); // 200 * 0.5 + 0 = 100
      expect(backoffMs(2, 200)).toBe(400); // 800 * 0.5 + 0 = 400

      vi.spyOn(Math, 'random').mockReturnValue(1);
      expect(backoffMs(0, 200)).toBe(200); // 200 * 0.5 + 1 * 100 = 200
      expect(backoffMs(2, 200)).toBe(800); // 800 * 0.5 + 1 * 400 = 800
    });

    it('grows exponentially with attempt count', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const d0 = backoffMs(0, 100);
      const d1 = backoffMs(1, 100);
      const d2 = backoffMs(2, 100);
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
    });
  });

  it('sends raw string body without JSON.stringify-ing', async () => {
    const rawBody =
      '--BOUNDARY\r\nContent-Disposition: form-data; name="file"\r\n\r\nhello\r\n--BOUNDARY--';
    nock('https://api.airbrake.io', {
      reqheaders: { 'content-type': 'multipart/form-data; boundary=BOUNDARY' },
    })
      .post('/api/v4/projects/1/sourcemaps', rawBody)
      .reply(201, { sourcemap: { id: 'sm_1' } });
    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('POST', '/api/v4/projects/1/sourcemaps', {
      body: rawBody,
      headers: { 'content-type': 'multipart/form-data; boundary=BOUNDARY' },
    });
    expect(result).toEqual({ sourcemap: { id: 'sm_1' } });
  });

  it('supports custom headers and no-auth mode (for notify path)', async () => {
    nock('https://api.airbrake.io', { reqheaders: { 'x-custom': 'v' } })
      .post('/api/v3/projects/1/notices')
      .query({ key: 'nk_abc' })
      .reply(201, { id: 'n_1' });
    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('POST', '/api/v3/projects/1/notices', {
      query: { key: 'nk_abc' },
      body: { errors: [] },
      headers: { 'x-custom': 'v' },
      auth: 'none',
    });
    expect(result).toEqual({ id: 'n_1' });
  });

  it('strips case-variant Authorization from user headers and uses real bearer', async () => {
    // Without sanitization, { Authorization: 'attacker', ... } and our
    // lowercase `authorization` would both reach `new Headers(...)` and be
    // concatenated as "attacker, Bearer tok_abc" — leaking attacker content
    // into the outbound auth header. With sanitization, only the real bearer
    // is sent.
    nock('https://api.airbrake.io', {
      reqheaders: { authorization: (v) => v === 'Bearer tok_abc' },
    })
      .get('/api/v4/projects')
      .reply(200, { projects: [] });
    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects', {
      headers: { Authorization: 'attacker', authorization: 'also-attacker' },
    });
    expect(result).toEqual({ projects: [] });
  });

  it('strips Host and Cookie from user headers', async () => {
    nock('https://api.airbrake.io', {
      badheaders: ['cookie'],
    })
      .get('/api/v4/projects')
      .reply(200, { projects: [] });
    const client = new AirbrakeClient(baseConfig);
    const result = await client.request('GET', '/api/v4/projects', {
      headers: { Cookie: 'session=evil', Host: 'evil.example.com' },
    });
    expect(result).toEqual({ projects: [] });
  });
});
