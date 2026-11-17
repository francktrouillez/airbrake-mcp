// Self-tests for the mock Airbrake server, so harness bugs fail loudly here
// instead of surfacing as confusing timeouts in feature e2e tests.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake } from './helpers/mock-airbrake.js';

describe('MockAirbrake', () => {
  const mock = new MockAirbrake();

  beforeAll(async () => {
    await mock.start();
  });
  afterAll(() => mock.stop());
  afterEach(() => mock.reset());

  it('answers 500 and records a harness fault when a route handler throws', async () => {
    mock.on('GET', '/boom', () => {
      throw new Error('kaboom');
    });
    const res = await fetch(`${mock.url}/boom`);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/kaboom/);
    expect(() => mock.assertNoUnhandled()).toThrow(/GET \/boom threw: kaboom/);
  });

  it('records unmatched requests as harness faults', async () => {
    expect((await fetch(`${mock.url}/nope`)).status).toBe(404);
    expect(() => mock.assertNoUnhandled()).toThrow(/no route for GET \/nope/);
    mock.reset();
    expect(() => mock.assertNoUnhandled()).not.toThrow();
  });

  it('stop() closes a stalled response instead of hanging', async () => {
    const stalled = await new MockAirbrake().start();
    try {
      stalled.on('GET', '/stall', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        return undefined;
      });
      const res = await fetch(`${stalled.url}/stall`);
      const body = res.text().catch((err: unknown) => err);
      await stalled.stop();
      expect(await body).toBeInstanceOf(Error);
    } finally {
      await stalled.stop(); // no-op when already stopped
    }
  });

  it('matches /g regex routes on every request, not alternately', async () => {
    mock.on('GET', /\/groups\/\d+/g, { body: { ok: true } });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${mock.url}/groups/${i}`)).status).toBe(200);
    }
    expect(mock.find('GET', /\/groups\/\d+/g)).toHaveLength(3);
  });

  it('does not duplicate a caller-supplied Content-Type', async () => {
    mock.on('GET', '/ct', {
      headers: { 'Content-Type': 'application/problem+json' },
      body: { a: 1 },
    });
    const res = await fetch(`${mock.url}/ct`);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('consumes counted routes in order', async () => {
    mock.on('GET', '/seq', { status: 503 }, 1);
    mock.on('GET', '/seq', { body: { ok: true } });
    expect((await fetch(`${mock.url}/seq`)).status).toBe(503);
    expect((await fetch(`${mock.url}/seq`)).status).toBe(200);
    expect(() => mock.assertNoUnhandled()).not.toThrow();
  });
});
