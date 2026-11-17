// AIRBRAKE_READ_ONLY end to end: the built binary over real stdio, real HTTP
// to the local mock Airbrake. The key property is that refused calls never
// reach the network — the mock must record zero requests.

import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_READ_ONLY_ANNOTATIONS,
  WRITE_CALLS,
  WRITE_TOOLS,
} from '../fixtures/tool-annotations.js';
import { MockAirbrake } from './helpers/mock-airbrake.js';
import { SERVER_BIN, startMcp, type McpHarness } from './helpers/mcp-harness.js';

const TOKEN = 'e2e-user-token';
const GROUP_ID = '3741526488590376432';
const SOURCEMAP_ID = '4338294560506624262';

describe('e2e: AIRBRAKE_READ_ONLY=1', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ '42': 'notifier-key-42' }),
      AIRBRAKE_READ_ONLY: '1',
      AIRBRAKE_MAX_RETRIES: '0',
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

  it('writes a one-line read-only notice to stderr at startup', async () => {
    // stderr is a separate pipe from JSON-RPC stdout; poll rather than race.
    await vi.waitFor(() => expect(mcp.stderr()).toMatch(/read-only mode/i));
    const notices = mcp
      .stderr()
      .split('\n')
      .filter((l) => /read-only mode/i.test(l));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/AIRBRAKE_READ_ONLY/);
  });

  it('lists only the read-only tools plus airbrake_request', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_READ_ONLY_ANNOTATIONS));
  });

  it('every listed tool is annotated read-only and non-destructive', async () => {
    const { tools } = await mcp.client.listTools();
    for (const t of tools) {
      expect(t.annotations, t.name).toEqual({
        title: t.title,
        ...EXPECTED_READ_ONLY_ANNOTATIONS[t.name],
      });
    }
  });

  it('advertises airbrake_request with method enum ["GET"]', async () => {
    const { tools } = await mcp.client.listTools();
    const req = tools.find((t) => t.name === 'airbrake_request')!;
    const props = req.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.method?.enum).toEqual(['GET']);
    expect(req.title).toMatch(/GET only/);
  });

  it.each(WRITE_TOOLS)('refuses %s with isError and zero HTTP requests', async (name) => {
    const res = await mcp.call(name, WRITE_CALLS[name]);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(`${name} is disabled: AIRBRAKE_READ_ONLY is set`);
    expect(mock.requests).toHaveLength(0);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects airbrake_request %s with zero HTTP requests',
    async (method) => {
      const res = await mcp.call('airbrake_request', {
        method,
        path: `/api/v4/projects/42/groups/${GROUP_ID}`,
        body: { resolved: true },
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/AIRBRAKE_READ_ONLY/);
      expect(mock.requests).toHaveLength(0);
    },
  );

  it('rejects a GET carrying a method-override header, with zero HTTP requests', async () => {
    const res = await mcp.call('airbrake_request', {
      method: 'GET',
      path: `/api/v4/projects/42/groups/${GROUP_ID}`,
      headers: { 'X-HTTP-Method-Override': 'DELETE' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(
      /method-override header x-http-method-override is not allowed while AIRBRAKE_READ_ONLY is set/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects a GET with a body, with zero HTTP requests', async () => {
    const res = await mcp.call('airbrake_request', {
      method: 'GET',
      path: '/api/v4/projects/42',
      body: { resolved: true },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/body is disabled: AIRBRAKE_READ_ONLY is set/);
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects a GET carrying a _method query override, with zero HTTP requests', async () => {
    const res = await mcp.call('airbrake_request', {
      method: 'GET',
      path: `/api/v4/projects/42/groups/${GROUP_ID}`,
      query: { _method: 'DELETE' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/_method is not allowed while AIRBRAKE_READ_ONLY is set/);
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects a _method override smuggled into the path, with zero HTTP requests', async () => {
    const res = await mcp.call('airbrake_request', {
      method: 'GET',
      path: `/api/v4/projects/42/groups/${GROUP_ID}?_method=DELETE`,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/_method is not allowed while AIRBRAKE_READ_ONLY is set/);
    expect(mock.requests).toHaveLength(0);
  });

  it('points a moved action at its replacement and says it is disabled', async () => {
    const res = await mcp.call('airbrake_groups', {
      action: 'delete',
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      'airbrake_groups no longer supports action "delete": it moved to airbrake_delete with resource "group", which is disabled: AIRBRAKE_READ_ONLY is set',
    );
    expect(mock.requests).toHaveLength(0);
  });

  it('allows airbrake_request GET', async () => {
    mock.on('GET', '/api/v4/projects/42', { body: { project: { id: 42 } } });
    const res = await mcp.call('airbrake_request', { method: 'GET', path: '/api/v4/projects/42' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ project: { id: 42 } });
    const [req] = mock.find('GET', '/api/v4/projects/42');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('still serves read-only resource tools', async () => {
    mock.on('GET', `/api/v4/projects/42/sourcemaps/${SOURCEMAP_ID}`, {
      body: { sourcemap: { id: SOURCEMAP_ID } },
    });
    const res = await mcp.call('airbrake_sourcemaps', {
      action: 'get',
      project_id: 42,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(res.isError).toBe(false);
    expect(mock.requests).toHaveLength(1);
  });
});

describe('e2e: AIRBRAKE_READ_ONLY validation', () => {
  it('accepts "false" and serves every tool with no read-only notice', async () => {
    const mock = await new MockAirbrake().start();
    const mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_READ_ONLY: 'false',
    });
    try {
      const { tools } = await mcp.client.listTools();
      for (const w of WRITE_TOOLS) expect(tools.map((t) => t.name)).toContain(w);
      expect(mcp.stderr()).not.toMatch(/read-only mode/i);
    } finally {
      await mcp.close();
      await mock.stop();
    }
  });

  it('exits non-zero with a clear stderr message when AIRBRAKE_READ_ONLY=maybe', async () => {
    const child = spawn(process.execPath, [SERVER_BIN], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AIRBRAKE_USER_TOKEN: TOKEN,
        AIRBRAKE_READ_ONLY: 'maybe',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/failed to start: AIRBRAKE_READ_ONLY must be one of/);
  });
});
