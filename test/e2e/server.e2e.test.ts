// Baseline end-to-end coverage: the built binary, real stdio JSON-RPC via the
// MCP SDK client, real HTTP to a local mock Airbrake.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAirbrake } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const TOKEN = 'e2e-user-token';

describe('e2e: built server over stdio', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ '42': 'notifier-key-42' }),
      AIRBRAKE_MAX_RETRIES: '2',
      AIRBRAKE_TIMEOUT_MS: '3000',
    });
  });

  afterAll(async () => {
    try {
      await mcp?.close();
    } finally {
      await mock.stop();
    }
  });

  afterEach(() => {
    try {
      mock.assertNoUnhandled();
    } finally {
      mock.reset();
    }
  });

  it('completes the MCP handshake and reports name/version', () => {
    const info = mcp.client.getServerVersion();
    expect(info?.name).toBe('airbrake-mcp');
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists tools whose input schemas satisfy MCP constraints', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.name).toMatch(/^airbrake_/);
      expect(t.inputSchema.type).toBe('object');
      for (const forbidden of ['anyOf', 'oneOf', 'allOf', '$ref']) {
        expect(t.inputSchema, `${t.name} has top-level ${forbidden}`).not.toHaveProperty(forbidden);
      }
    }
  });

  it('routes a read call to Airbrake with bearer auth and returns the payload', async () => {
    mock.on('GET', '/api/v4/projects', { body: { projects: [{ id: 1, name: 'p' }], count: 1 } });
    const res = await mcp.call('airbrake_projects', { action: 'list' });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ projects: [{ id: 1, name: 'p' }] });
    const [req] = mock.find('GET', '/api/v4/projects');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.query.page).toBe('1');
  });

  it('preserves 19-digit snowflake IDs in the request path', async () => {
    const groupId = '3741526488590376432';
    mock.on('GET', `/api/v4/projects/42/groups/${groupId}`, { body: { group: { id: groupId } } });
    const res = await mcp.call('airbrake_groups', {
      action: 'get',
      project_id: 42,
      group_id: groupId,
    });
    expect(res.isError).toBe(false);
    expect(mock.find('GET', `/api/v4/projects/42/groups/${groupId}`)).toHaveLength(1);
  });

  it('sends notices with the project key and no Authorization header', async () => {
    mock.on('POST', '/api/v3/projects/42/notices', {
      status: 201,
      body: { id: 'abc-123', url: 'https://airbrake.io/x' },
    });
    const payload = { errors: [{ type: 'Error', message: 'boom', backtrace: [] }] };
    const res = await mcp.call('airbrake_notify', { action: 'notify', project_id: 42, payload });
    expect(res.isError).toBe(false);
    const [req] = mock.find('POST', '/api/v3/projects/42/notices');
    expect(req?.query.key).toBe('notifier-key-42');
    expect(req?.headers.authorization).toBeUndefined();
    expect(JSON.parse(req!.body)).toEqual(payload);
  });

  it('surfaces Airbrake 4xx responses as tool errors', async () => {
    mock.on('GET', '/api/v4/projects/7', { status: 404, body: { message: 'not found' } });
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 7 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/404/);
  });

  it('retries a 503 and returns the eventual success', async () => {
    mock.on('GET', '/api/v4/projects/9', { status: 503, headers: { 'retry-after': '0' } }, 1);
    mock.on('GET', '/api/v4/projects/9', { body: { project: { id: 9 } } });
    const res = await mcp.call('airbrake_projects', { action: 'get', project_id: 9 });
    expect(res.isError).toBe(false);
    expect(mock.find('GET', '/api/v4/projects/9')).toHaveLength(2);
  });

  it('rejects invalid input before any HTTP request is made', async () => {
    const res = await mcp.call('airbrake_groups', {
      action: 'delete',
      project_id: 42,
      group_id: '../../admin',
    });
    expect(res.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('blocks path traversal in the airbrake_request escape hatch', async () => {
    const res = await mcp.call('airbrake_request', {
      method: 'GET',
      path: '/api/v4/%2e%2e/%2e%2e/admin',
    });
    expect(res.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('returns isError for an unknown tool', async () => {
    const res = await mcp.call('airbrake_does_not_exist');
    expect(res.isError).toBe(true);
  });
});

describe('e2e: startup configuration', () => {
  it('surfaces the server’s own stderr when startup fails', async () => {
    await expect(startMcp({ AIRBRAKE_HOST: 'ftp://example.invalid' })).rejects.toThrow(
      /AIRBRAKE_HOST must use http: or https:/,
    );
  });

  it('warns on stderr when AIRBRAKE_USER_TOKEN is missing but still serves tools', async () => {
    const mock = await new MockAirbrake().start();
    let mcp: McpHarness | undefined;
    try {
      mcp = await startMcp({ AIRBRAKE_HOST: mock.url });
      const { tools } = await mcp.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      // stderr travels on a separate pipe from the JSON-RPC stdout stream, so
      // it may land after the handshake resolves — poll instead of racing.
      await vi.waitFor(() => expect(mcp!.stderr()).toMatch(/AIRBRAKE_USER_TOKEN is not set/));
      const res = await mcp.call('airbrake_projects', { action: 'list' });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/AIRBRAKE_USER_TOKEN/);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mcp?.close();
      await mock.stop();
    }
  });
});
