import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { createServer } from '../src/server.js';
import { AirbrakeClient } from '../src/client/airbrake.js';
import {
  EXPECTED_READ_ONLY_ANNOTATIONS,
  WRITE_CALLS,
  WRITE_TOOLS,
  EXPECTED_ANNOTATIONS,
} from './fixtures/tool-annotations.js';
import { inProcessServer } from './helpers/server-handlers.js';

const RO_ENV = { AIRBRAKE_USER_TOKEN: 'tok', AIRBRAKE_READ_ONLY: '1' };
const GROUP_ID = '4338045234182207507';

describe('AIRBRAKE_READ_ONLY', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => vi.restoreAllMocks());

  it('lists only read-only tools plus a GET-only airbrake_request', async () => {
    const server = await inProcessServer(RO_ENV);
    const tools = await server.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_READ_ONLY_ANNOTATIONS));
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject(EXPECTED_READ_ONLY_ANNOTATIONS[t.name]!);
    }
  });

  it('advertises airbrake_request with method enum ["GET"] only', async () => {
    const server = await inProcessServer(RO_ENV);
    const req = (await server.listTools()).find((t) => t.name === 'airbrake_request')!;
    const props = req.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.method?.enum).toEqual(['GET']);
    expect(req.description).toMatch(/GET/);
  });

  it('normal mode still advertises every method for airbrake_request', async () => {
    const server = await inProcessServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const tools = await server.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
    const req = tools.find((t) => t.name === 'airbrake_request')!;
    const props = req.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.method?.enum).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
  });

  it.each(WRITE_TOOLS)('refuses %s in the call handler without any HTTP', async (name) => {
    const spy = vi.spyOn(AirbrakeClient.prototype, 'request');
    const server = await inProcessServer({
      ...RO_ENV,
      AIRBRAKE_PROJECT_KEYS: JSON.stringify({ '42': 'k' }),
    });
    const res = await server.call(name, WRITE_CALLS[name]);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(`${name} is disabled: AIRBRAKE_READ_ONLY is set`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects airbrake_request POST without any HTTP', async () => {
    const spy = vi.spyOn(AirbrakeClient.prototype, 'request');
    const server = await inProcessServer(RO_ENV);
    const res = await server.call('airbrake_request', {
      method: 'POST',
      path: '/api/v4/projects/1/deploys',
      body: {},
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/AIRBRAKE_READ_ONLY/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows airbrake_request GET', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1')
      .reply(200, { project: { id: 1 } });
    const server = await inProcessServer(RO_ENV);
    const res = await server.call('airbrake_request', {
      method: 'GET',
      path: '/api/v4/projects/1',
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ project: { id: 1 } });
  });

  it('allows read-only tools', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}`)
      .reply(200, { group: { id: GROUP_ID } });
    const server = await inProcessServer(RO_ENV);
    const res = await server.call('airbrake_groups', {
      action: 'get',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBeUndefined();
  });

  it('still reports unknown tools as unknown (not "disabled")', async () => {
    const server = await inProcessServer(RO_ENV);
    const res = await server.call('airbrake_nope');
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/unknown tool/);
  });

  it('writes a one-line stderr notice at startup', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    await createServer(RO_ENV);
    const notices = writes.filter((s) => /read-only mode/i.test(s));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/AIRBRAKE_READ_ONLY/);
    expect(notices[0]!.trimEnd().split('\n')).toHaveLength(1);
  });

  it('fails to start on an invalid value', async () => {
    await expect(createServer({ ...RO_ENV, AIRBRAKE_READ_ONLY: 'maybe' })).rejects.toThrow(
      /AIRBRAKE_READ_ONLY/,
    );
  });

  it('write tools work normally when read-only mode is off', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/42/groups/3741526488590376432/muted`)
      .reply(200, { group: { id: GROUP_ID, muted: true } });
    const server = await inProcessServer({ AIRBRAKE_USER_TOKEN: 'tok', AIRBRAKE_READ_ONLY: '0' });
    const res = await server.call('airbrake_groups_update', WRITE_CALLS.airbrake_groups_update);
    expect(res.isError).toBeUndefined();
  });
});
