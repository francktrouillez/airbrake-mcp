import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { projectsTool } from '../../src/tools/projects.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

describe('airbrake_projects', () => {
  beforeEach(() => nock.cleanAll());

  it('list → GET /api/v4/projects with pagination', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .query({ page: '2', per_page: '25' })
      .reply(200, { projects: [] });
    const r = await projectsTool.handler(ctx(), { action: 'list', page: 2, per_page: 25 });
    expect(r).toMatchObject({ projects: [], _pagination: { page: 2, per_page: 25 } });
  });

  it('list → reports has_more/next_page/total_pages from count', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .query({ page: '1', per_page: '2' })
      .reply(200, { projects: [{ id: 1 }, { id: 2 }], count: 5 });
    const r = await projectsTool.handler(ctx(), { action: 'list', page: 1, per_page: 2 });
    expect(r).toMatchObject({
      _pagination: { page: 1, per_page: 2, count: 5, has_more: true, next_page: 2, total_pages: 3 },
    });
  });

  it('list_activities → estimates has_more when count is absent', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/42/activities')
      .query({ page: '3', per_page: '2' })
      .reply(200, { activities: [{ id: 1 }, { id: 2 }] });
    const r = await projectsTool.handler(ctx(), {
      action: 'list_activities',
      project_id: 42,
      page: 3,
      per_page: 2,
    });
    expect(r).toMatchObject({
      _pagination: {
        page: 3,
        per_page: 2,
        has_more: true,
        next_page: 4,
        has_more_is_estimate: true,
      },
    });
  });

  it('get → GET /api/v4/projects/:id', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/42')
      .reply(200, { project: { id: 42 } });
    const r = await projectsTool.handler(ctx(), { action: 'get', project_id: 42 });
    expect(r).toEqual({ project: { id: 42 } });
  });

  it('list_activities → GET /api/v4/projects/:id/activities', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/42/activities')
      .query({ page: '1', per_page: '50' })
      .reply(200, { activities: [{ id: 1, kind: 'group_resolved' }] });
    const r = await projectsTool.handler(ctx(), { action: 'list_activities', project_id: 42 });
    expect(r).toMatchObject({
      activities: [{ id: 1, kind: 'group_resolved' }],
      _pagination: { page: 1, per_page: 50 },
    });
  });

  it('does not expose an update action (endpoint requires dashboard session)', () => {
    const actions = (
      projectsTool.inputSchema._def.options as Array<{ shape: { action: { value: string } } }>
    ).map((opt) => opt.shape.action.value);
    expect(actions).not.toContain('update');
  });
});
