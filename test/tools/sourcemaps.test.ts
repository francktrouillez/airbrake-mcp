import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { sourcemapsTool } from '../../src/tools/sourcemaps.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const SOURCEMAP_ID = '4338294560506624262';

describe('airbrake_sourcemaps', () => {
  beforeEach(() => nock.cleanAll());

  it('list → GET /api/v4/projects/:pid/sourcemaps', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/sourcemaps')
      .query({ page: '1', per_page: '50' })
      .reply(200, { sourcemaps: [] });
    const r = await sourcemapsTool.handler(ctx(), { action: 'list', project_id: 1 });
    expect(r).toMatchObject({ sourcemaps: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('get with string sourcemap_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/sourcemaps/${SOURCEMAP_ID}`)
      .reply(200, { sourcemap: { id: SOURCEMAP_ID } });
    const r = await sourcemapsTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(r).toEqual({ sourcemap: { id: SOURCEMAP_ID } });
  });

  it('delete with string sourcemap_id', async () => {
    nock('https://api.airbrake.io')
      .delete(`/api/v4/projects/1/sourcemaps/${SOURCEMAP_ID}`)
      .reply(204);
    const r = await sourcemapsTool.handler(ctx(), {
      action: 'delete',
      project_id: 1,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(r).toBeNull();
  });
});
