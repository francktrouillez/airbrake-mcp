// End-to-end coverage of the retry policy: the built binary over stdio,
// against the local mock Airbrake. Non-idempotent requests (POST/PATCH/DELETE)
// must reach the server exactly once on 5xx / network failures, while 429 and
// refused connections are retried for every method and GET/PUT keep retrying
// on 5xx.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake, type RouteHandler } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const PROJECT = 42;
const GROUP_ID = '3741526488590376432';
const GROUP_PATH = `/api/v4/projects/${PROJECT}/groups/${GROUP_ID}`;
const NOTICES_PATH = `/api/v3/projects/${PROJECT}/notices`;
const DEPLOYS_PATH = `/api/v4/projects/${PROJECT}/deploys`;

// `retry-after: 0` keeps any (incorrect) retry instantaneous, so a regression
// shows up as an extra recorded request rather than a slow test.
const fastFail = (status: number) => ({ status, headers: { 'retry-after': '0' } });

// Drop the TCP connection without sending a response: the client sees a
// network error after the server has already received (and could have acted
// on) the request.
const destroyConnection: RouteHandler = (_req, res) => {
  res.destroy();
  return undefined;
};

const NOTICE = { errors: [{ type: 'Error', message: 'boom', backtrace: [] }] };

describe('e2e: retry policy', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: 'e2e-user-token',
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ [String(PROJECT)]: 'notifier-key-42' }),
      AIRBRAKE_MAX_RETRIES: '2',
      AIRBRAKE_TIMEOUT_MS: '3000',
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

  describe('non-idempotent methods are sent exactly once on 5xx / network errors', () => {
    const REQUEST_PATH = `/api/v4/projects/${PROJECT}/things/1`;
    const DROPPED = 'dropped connection';
    const DELETE_GROUP = { action: 'delete', project_id: PROJECT, group_id: GROUP_ID };
    const cases = [
      {
        tool: 'airbrake_notify',
        args: { action: 'notify', project_id: PROJECT, payload: NOTICE },
        method: 'POST',
        path: NOTICES_PATH,
        failure: 503,
      },
      {
        tool: 'airbrake_deploys',
        args: { action: 'create', project_id: PROJECT, deploy: { revision: 'abc123' } },
        method: 'POST',
        path: DEPLOYS_PATH,
        failure: DROPPED,
      },
      {
        tool: 'airbrake_groups',
        args: DELETE_GROUP,
        method: 'DELETE',
        path: GROUP_PATH,
        failure: 502,
      },
      {
        tool: 'airbrake_groups',
        args: DELETE_GROUP,
        method: 'DELETE',
        path: GROUP_PATH,
        failure: DROPPED,
      },
      {
        tool: 'airbrake_request',
        args: { method: 'POST', path: REQUEST_PATH, body: { a: 1 } },
        method: 'POST',
        path: REQUEST_PATH,
        failure: 503,
      },
      {
        tool: 'airbrake_request',
        args: { method: 'PATCH', path: REQUEST_PATH, body: { a: 1 } },
        method: 'PATCH',
        path: REQUEST_PATH,
        failure: 500,
      },
    ] as const;

    it.each(cases)(
      '$tool ($method) with $failure → isError, exactly 1 request, "may have been applied"',
      async ({ tool, args, method, path, failure }) => {
        mock.on(method, path, failure === DROPPED ? destroyConnection : fastFail(failure));
        const res = await mcp.call(tool, args);
        expect(res.isError).toBe(true);
        expect(res.text).toContain(
          failure === DROPPED ? `network error on ${method}` : `API error ${failure} on ${method}`,
        );
        expect(res.text).toContain(
          `(not retried: resending ${method} is unsafe; the request may have been applied)`,
        );
        expect(mock.find(method, path)).toHaveLength(1);
      },
    );
  });

  describe('idempotent methods still retry', () => {
    it('airbrake_groups get (GET) 503 then 200 → success after 2 requests', async () => {
      mock.on('GET', GROUP_PATH, fastFail(503), 1);
      mock.on('GET', GROUP_PATH, { body: { group: { id: GROUP_ID } } });
      const res = await mcp.call('airbrake_groups', {
        action: 'get',
        project_id: PROJECT,
        group_id: GROUP_ID,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ group: { id: GROUP_ID } });
      expect(mock.find('GET', GROUP_PATH)).toHaveLength(2);
    });

    it('airbrake_groups get (GET) with the connection destroyed then 200 → success', async () => {
      mock.on('GET', GROUP_PATH, destroyConnection, 1);
      mock.on('GET', GROUP_PATH, { body: { group: { id: GROUP_ID } } });
      const res = await mcp.call('airbrake_groups', {
        action: 'get',
        project_id: PROJECT,
        group_id: GROUP_ID,
      });
      expect(res.isError).toBe(false);
      expect(mock.find('GET', GROUP_PATH)).toHaveLength(2);
    });

    it('airbrake_groups mute (PUT) 500 then 204 → success after 2 requests', async () => {
      const path = `${GROUP_PATH}/muted`;
      mock.on('PUT', path, fastFail(500), 1);
      mock.on('PUT', path, { status: 204 });
      const res = await mcp.call('airbrake_groups', {
        action: 'mute',
        project_id: PROJECT,
        group_id: GROUP_ID,
      });
      expect(res.isError).toBe(false);
      expect(mock.find('PUT', path)).toHaveLength(2);
    });

    it('GET gives up after maxRetries (3 requests total) on persistent 503', async () => {
      mock.on('GET', GROUP_PATH, fastFail(503));
      const res = await mcp.call('airbrake_groups', {
        action: 'get',
        project_id: PROJECT,
        group_id: GROUP_ID,
      });
      expect(res.isError).toBe(true);
      expect(mock.find('GET', GROUP_PATH)).toHaveLength(3);
    });
  });

  describe('429 is retried for every method', () => {
    it('airbrake_notify (POST) 429 (retry-after 0) then 201 → success after 2 requests', async () => {
      mock.on('POST', NOTICES_PATH, fastFail(429), 1);
      mock.on('POST', NOTICES_PATH, { status: 201, body: { id: 'abc-123' } });
      const res = await mcp.call('airbrake_notify', {
        action: 'notify',
        project_id: PROJECT,
        payload: NOTICE,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ id: 'abc-123' });
      const reqs = mock.find('POST', NOTICES_PATH);
      expect(reqs).toHaveLength(2);
      expect(JSON.parse(reqs[1]!.body)).toEqual(NOTICE);
    });

    it('airbrake_groups delete (DELETE) 429 then 204 → success after 2 requests', async () => {
      mock.on('DELETE', GROUP_PATH, fastFail(429), 1);
      mock.on('DELETE', GROUP_PATH, { status: 204 });
      const res = await mcp.call('airbrake_groups', {
        action: 'delete',
        project_id: PROJECT,
        group_id: GROUP_ID,
      });
      expect(res.isError).toBe(false);
      expect(mock.find('DELETE', GROUP_PATH)).toHaveLength(2);
    });
  });
});

// A refused connection means nothing reached the server, so even POST is
// safe to retry. Uses a real closed port, so the error comes from the OS.
describe('e2e: connect failures are retried for every method', () => {
  let port = 0;
  let mcp: McpHarness;
  let late: Server | null = null;

  beforeAll(async () => {
    // Reserve a free port, then close it so connections are refused.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    mcp = await startMcp({
      AIRBRAKE_HOST: `http://127.0.0.1:${port}`,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ [String(PROJECT)]: 'notifier-key-42' }),
      // Attempts at ~0, >=125, >=375 and >=875ms: wide margin for the late server.
      AIRBRAKE_MAX_RETRIES: '3',
      AIRBRAKE_TIMEOUT_MS: '3000',
    });
  });

  afterAll(async () => {
    await mcp?.close();
    late?.closeAllConnections();
    await new Promise<void>((resolve) => (late ? late.close(() => resolve()) : resolve()));
  });

  it('airbrake_notify to a refused port → isError saying the request was not sent', async () => {
    const res = await mcp.call('airbrake_notify', {
      action: 'notify',
      project_id: PROJECT,
      payload: NOTICE,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/network error on POST/);
    expect(res.text).toMatch(/connection failed; the request was not sent/);
    expect(res.text).not.toMatch(/may have been applied/);
  });

  it('airbrake_notify recovers once the server comes up between retries', async () => {
    // The first attempt is refused; the server starts listening at 150ms,
    // well before the last retry (>= 875ms after the first attempt).
    const posts: string[] = [];
    let listenError: Error | undefined;
    late = createServer((req, res) => {
      posts.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'late-1' }));
      });
    });
    const server = late;
    // EADDRINUSE (another process took the freed port) fails clearly below.
    server.once('error', (err) => (listenError = err));
    const timer = setTimeout(() => server.listen(port, '127.0.0.1'), 150);
    try {
      const res = await mcp.call('airbrake_notify', {
        action: 'notify',
        project_id: PROJECT,
        payload: NOTICE,
      });
      expect(listenError).toBeUndefined();
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ id: 'late-1' });
      expect(posts).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });
});

// AIRBRAKE_TIMEOUT_MS fires while the server may still be processing: an
// ambiguous failure, so only idempotent methods are re-sent.
describe('e2e: client timeouts', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;
  // Accept the request and never answer; mock.stop() destroys the socket.
  const stall: RouteHandler = () => undefined;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: 'e2e-user-token',
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ [String(PROJECT)]: 'notifier-key-42' }),
      AIRBRAKE_MAX_RETRIES: '2',
      AIRBRAKE_TIMEOUT_MS: '300',
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

  it('airbrake_notify (POST) timing out → isError, exactly 1 request, "may have been applied"', async () => {
    mock.on('POST', NOTICES_PATH, stall);
    const res = await mcp.call('airbrake_notify', {
      action: 'notify',
      project_id: PROJECT,
      payload: NOTICE,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('network error on POST');
    expect(res.text).toContain(
      '(not retried: resending POST is unsafe; the request may have been applied)',
    );
    expect(mock.find('POST', NOTICES_PATH)).toHaveLength(1);
  });

  it('airbrake_groups get (GET) timing out is retried, then succeeds', async () => {
    mock.on('GET', GROUP_PATH, stall, 1);
    mock.on('GET', GROUP_PATH, { body: { group: { id: GROUP_ID } } });
    const res = await mcp.call('airbrake_groups', {
      action: 'get',
      project_id: PROJECT,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(false);
    expect(mock.find('GET', GROUP_PATH)).toHaveLength(2);
  });
});
