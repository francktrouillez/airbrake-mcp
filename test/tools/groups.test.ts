import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { groupsTool } from '../../src/tools/groups.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const GROUP_ID = '4338045234182207507';

describe('airbrake_groups', () => {
  beforeEach(() => nock.cleanAll());

  it('list with basic filters', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({ page: '1', per_page: '50', environment: 'prod', resolved: 'false' })
      .reply(200, { groups: [] });
    const r = await groupsTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      environment: 'prod',
      resolved: false,
    });
    expect(r).toMatchObject({ groups: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('list with string deploy_id and other filters', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({
        page: '1',
        per_page: '50',
        environment: 'prod',
        deploy_id: '4338294560506624262',
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-05-23T00:00:00Z',
        order: 'last_notice',
        archived: 'false',
      })
      .reply(200, { groups: [] });
    const r = await groupsTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      environment: 'prod',
      deploy_id: '4338294560506624262',
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-23T00:00:00Z',
      order: 'last_notice',
      archived: false,
    });
    expect(r).toMatchObject({ groups: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('get with string group_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}`)
      .reply(200, { group: { id: GROUP_ID } });
    const r = await groupsTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID } });
  });

  it('rejects numeric group_id (string-only schema)', async () => {
    await expect(
      groupsTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        // @ts-expect-error: schema is string-only; number rejection is asserted at runtime
        group_id: 12345,
      }),
    ).rejects.toThrow();
  });

  it('get_stats → GET /api/v5/.../stats with required time params', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v5/projects/1/groups/${GROUP_ID}/stats`)
      .query({
        time__gte: '2026-05-17T00:00:00Z',
        time__lt: '2026-05-24T00:00:00Z',
        period: 'hour',
      })
      .reply(200, { accepted: [2], limited: [0] });
    const r = await groupsTool.handler(ctx(), {
      action: 'get_stats',
      project_id: 1,
      group_id: GROUP_ID,
      time__gte: '2026-05-17T00:00:00Z',
      time__lt: '2026-05-24T00:00:00Z',
      period: 'hour',
    });
    expect(r).toEqual({ accepted: [2], limited: [0] });
  });

  it('mute → PUT /muted with no body', async () => {
    nock('https://api.airbrake.io')
      .put(
        `/api/v4/projects/1/groups/${GROUP_ID}/muted`,
        (body) => body === '' || body === undefined,
      )
      .reply(200, { group: { id: GROUP_ID, muted: true } });
    const r = await groupsTool.handler(ctx(), {
      action: 'mute',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, muted: true } });
  });

  it('unmute → PUT /unmuted', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/unmuted`)
      .reply(200, { group: { id: GROUP_ID, muted: false } });
    const r = await groupsTool.handler(ctx(), {
      action: 'unmute',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, muted: false } });
  });

  it('resolve → PUT /resolved', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/resolved`)
      .reply(200, { group: { id: GROUP_ID, resolved: true } });
    const r = await groupsTool.handler(ctx(), {
      action: 'resolve',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, resolved: true } });
  });

  it('unresolve → PUT /unresolved', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/unresolved`)
      .reply(200, { group: { id: GROUP_ID, resolved: false } });
    const r = await groupsTool.handler(ctx(), {
      action: 'unresolve',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, resolved: false } });
  });

  it('delete → DELETE returns null', async () => {
    nock('https://api.airbrake.io').delete(`/api/v4/projects/1/groups/${GROUP_ID}`).reply(204);
    const r = await groupsTool.handler(ctx(), {
      action: 'delete',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toBeNull();
  });
});
