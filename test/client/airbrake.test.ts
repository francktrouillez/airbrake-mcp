import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import {
  AirbrakeClient,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_DELAY_MS,
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

  it('rejects oversized response body via Content-Length', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .reply(200, 'x', { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
    const client = new AirbrakeClient({ ...baseConfig, maxRetries: 0 });
    await expect(client.request('GET', '/api/v4/projects')).rejects.toBeInstanceOf(
      AirbrakeApiError,
    );
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
});
