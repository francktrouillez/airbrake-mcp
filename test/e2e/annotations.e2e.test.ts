// Tool annotations + the regrouped write tools, end to end: the built binary
// over real stdio, real HTTP to the local mock Airbrake.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_ANNOTATIONS } from '../fixtures/tool-annotations.js';
import { MockAirbrake } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const TOKEN = 'e2e-user-token';
const GROUP_ID = '3741526488590376432';
const SOURCEMAP_ID = '4338294560506624262';

describe('e2e: tool annotations (normal mode)', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
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

  it('lists exactly the intended tools, in order', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
  });

  it('every tool carries a title and annotations matching the intended table', async () => {
    const { tools } = await mcp.client.listTools();
    for (const t of tools) {
      expect(t.title, `${t.name} title`).toMatch(/\S/);
      expect(t.annotations, `${t.name} annotations`).toEqual({
        title: t.title,
        ...EXPECTED_ANNOTATIONS[t.name],
      });
    }
  });

  it('airbrake_request advertises every HTTP method in normal mode', async () => {
    const { tools } = await mcp.client.listTools();
    const req = tools.find((t) => t.name === 'airbrake_request')!;
    const props = req.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.method?.enum).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
  });

  it('airbrake_delete exposes the `resource` discriminator as an enum', async () => {
    const { tools } = await mcp.client.listTools();
    const del = tools.find((t) => t.name === 'airbrake_delete')!;
    const props = del.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.resource?.enum).toEqual(['group', 'sourcemap']);
    expect(del.inputSchema.required).toEqual(expect.arrayContaining(['resource', 'project_id']));
  });

  it.each([
    ['mute', 'muted'],
    ['unmute', 'unmuted'],
    ['resolve', 'resolved'],
    ['unresolve', 'unresolved'],
  ])('airbrake_groups_update %s → PUT .../%s', async (action, suffix) => {
    const path = `/api/v4/projects/42/groups/${GROUP_ID}/${suffix}`;
    mock.on('PUT', path, { body: { group: { id: GROUP_ID } } });
    const res = await mcp.call('airbrake_groups_update', {
      action,
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(false);
    expect(mock.requests).toHaveLength(1);
    const [req] = mock.find('PUT', path);
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.body).toBe('');
  });

  it('airbrake_delete group → DELETE /groups/:id', async () => {
    const path = `/api/v4/projects/42/groups/${GROUP_ID}`;
    mock.on('DELETE', path, { status: 204 });
    const res = await mcp.call('airbrake_delete', {
      resource: 'group',
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(false);
    expect(mock.requests).toHaveLength(1);
    expect(mock.find('DELETE', path)).toHaveLength(1);
  });

  it('airbrake_delete sourcemap → DELETE /sourcemaps/:id', async () => {
    const path = `/api/v4/projects/42/sourcemaps/${SOURCEMAP_ID}`;
    mock.on('DELETE', path, { status: 204 });
    const res = await mcp.call('airbrake_delete', {
      resource: 'sourcemap',
      project_id: 42,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(res.isError).toBe(false);
    expect(mock.requests).toHaveLength(1);
    expect(mock.find('DELETE', path)).toHaveLength(1);
  });

  it('airbrake_delete refuses the wrong ID for the resource, with no HTTP', async () => {
    const res = await mcp.call('airbrake_delete', {
      resource: 'sourcemap',
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/sourcemap_id/);
    expect(mock.requests).toHaveLength(0);
  });

  it('airbrake_delete blocks path traversal, with no HTTP', async () => {
    const res = await mcp.call('airbrake_delete', {
      resource: 'sourcemap',
      project_id: 42,
      sourcemap_id: '../../admin',
    });
    expect(res.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('airbrake_deploys_create → POST /deploys with the fields at the top level', async () => {
    mock.on('POST', '/api/v4/projects/42/deploys', { status: 201, body: { id: '6' } });
    const deploy = { environment: 'production', revision: 'abc123', username: 'ci' };
    const res = await mcp.call('airbrake_deploys_create', { project_id: 42, deploy });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: '6' });
    const [req] = mock.find('POST', '/api/v4/projects/42/deploys');
    expect(JSON.parse(req!.body)).toEqual(deploy);
  });

  it('old write actions on the read tools are rejected with no HTTP', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['airbrake_groups', { action: 'mute', project_id: 42, group_id: GROUP_ID }],
      ['airbrake_groups', { action: 'delete', project_id: 42, group_id: GROUP_ID }],
      ['airbrake_deploys', { action: 'create', project_id: 42, deploy: {} }],
      ['airbrake_sourcemaps', { action: 'delete', project_id: 42, sourcemap_id: SOURCEMAP_ID }],
    ];
    for (const [name, args] of calls) {
      const res = await mcp.call(name, args);
      expect(res.isError, `${name} ${String(args.action)}`).toBe(true);
      expect(res.text).toMatch(
        /no longer supports action .*: use airbrake_(groups_update|delete|deploys_create)/,
      );
    }
    expect(mock.requests).toHaveLength(0);
  });
});
