// AIRBRAKE_TIMEOUT_MS must bound the whole attempt — connect, headers and the
// full body read. These tests drive the built server against a mock that
// sends headers and then stalls mid-body, which used to hang the tool call.

import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake, type RouteHandler } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const TOKEN = 'e2e-user-token';
const TIMEOUT_MS = 500;
// Generous bound for "returned promptly": well above TIMEOUT_MS plus process
// and IPC overhead, well below a hang.
const PROMPT_MS = 4000;

/** Status + headers + a partial JSON chunk, then never ends the response. */
const stallMidBody: RouteHandler = (_req, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"project":{"id":');
  return undefined;
};

/** A complete body delivered in two chunks with a pause in between. */
function slowBody(pauseMs: number): RouteHandler {
  return (_req, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"project":');
    setTimeout(() => res.end('{"id":5}}'), pauseMs);
    return undefined;
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, elapsedMs: Date.now() - started };
}

describe.each([
  { retries: 0, label: 'retries disabled' },
  { retries: 1, label: 'one retry' },
])('e2e: request timeout covers the body read ($label)', ({ retries }) => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_MAX_RETRIES: String(retries),
      AIRBRAKE_TIMEOUT_MS: String(TIMEOUT_MS),
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await mock.stop();
  });

  afterEach(() => {
    try {
      mock.assertNoUnhandled();
    } finally {
      mock.reset();
    }
  });

  it('returns a timeout error when every attempt stalls mid-body', async () => {
    mock.on('GET', '/api/v4/projects/5', stallMidBody);
    const { value: res, elapsedMs } = await timed(() =>
      mcp.call('airbrake_projects', { action: 'get', project_id: 5 }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/network error/i);
    expect(res.text).toMatch(
      new RegExp(`timed out after ${TIMEOUT_MS}ms while reading the HTTP 200 response body`),
    );
    expect(res.text).not.toMatch(/API error 200/);
    expect(mock.find('GET', '/api/v4/projects/5')).toHaveLength(retries + 1);
    expect(elapsedMs).toBeLessThan(PROMPT_MS * (retries + 1));
  });

  it('succeeds when a slow body completes within the deadline', async () => {
    mock.on('GET', '/api/v4/projects/5', slowBody(TIMEOUT_MS / 5));
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 5 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ project: { id: 5 } });
    expect(mock.find('GET', '/api/v4/projects/5')).toHaveLength(1);
  });

  it('times out a slow body that overruns the deadline even though data keeps arriving', async () => {
    // Headers arrive instantly; the body would only finish after 3x the
    // deadline. The deadline is per attempt, not per chunk.
    mock.on('GET', '/api/v4/projects/5', slowBody(TIMEOUT_MS * 3));
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 5 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(new RegExp(`timed out after ${TIMEOUT_MS}ms`));
  });

  it('reports header-stage timeouts the same way', async () => {
    // Never writes anything at all.
    mock.on('GET', '/api/v4/projects/5', () => undefined);
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 5 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(new RegExp(`timed out after ${TIMEOUT_MS}ms`));
    expect(mock.find('GET', '/api/v4/projects/5')).toHaveLength(retries + 1);
  });

  it('keeps serving tool calls after a timed-out request', async () => {
    mock.on('GET', '/api/v4/projects/5', stallMidBody, retries + 1);
    await mcp.call('airbrake_projects', { action: 'get', project_id: 5 });
    mock.on('GET', '/api/v4/projects/6', { body: { project: { id: 6 } } });
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 6 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ project: { id: 6 } });
  });

  it.runIf(retries > 0)(
    'returns the healthy retry after the first attempt stalls mid-body',
    async () => {
      mock.on('GET', '/api/v4/projects/5', stallMidBody, 1);
      mock.on('GET', '/api/v4/projects/5', { body: { project: { id: 5, name: 'ok' } } });
      const { value: res, elapsedMs } = await timed(() =>
        mcp.call('airbrake_projects', { action: 'get', project_id: 5 }),
      );
      expect(res.isError).toBe(false);
      expect(res.json).toEqual({ project: { id: 5, name: 'ok' } });
      expect(mock.find('GET', '/api/v4/projects/5')).toHaveLength(2);
      expect(elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(elapsedMs).toBeLessThan(PROMPT_MS);
    },
  );
});
