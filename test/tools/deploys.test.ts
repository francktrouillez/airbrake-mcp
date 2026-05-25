import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { deploysTool } from '../../src/tools/deploys.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const DEPLOY_ID = '4338294560506624262';

describe('airbrake_deploys', () => {
  beforeEach(() => nock.cleanAll());

  it('list', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/deploys')
      .query({ page: '1', per_page: '50' })
      .reply(200, { deploys: [] });
    const r = await deploysTool.handler(ctx(), { action: 'list', project_id: 1 });
    expect(r).toMatchObject({ deploys: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('get with string deploy_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/deploys/${DEPLOY_ID}`)
      .reply(200, { deploy: { id: DEPLOY_ID } });
    const r = await deploysTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      deploy_id: DEPLOY_ID,
    });
    expect(r).toEqual({ deploy: { id: DEPLOY_ID } });
  });

  it('rejects numeric deploy_id (string-only schema)', async () => {
    await expect(
      deploysTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        // @ts-expect-error: schema is string-only; number rejection is asserted at runtime
        deploy_id: 12345,
      }),
    ).rejects.toThrow();
  });

  it('rejects path traversal in deploy_id', async () => {
    for (const bad of ['../../999', 'abc', '123/../999']) {
      await expect(
        deploysTool.handler(ctx(), { action: 'get', project_id: 1, deploy_id: bad }),
      ).rejects.toThrow(/snowflake/i);
    }
  });

  it('create → POST with FLAT body (no { deploy: ... } wrapper)', async () => {
    // Verified against live Airbrake: the wrapped payload silently creates
    // an empty deploy marker; the flat payload persists all fields.
    nock('https://api.airbrake.io')
      .post('/api/v4/projects/1/deploys', { environment: 'prod', revision: 'abc123' })
      .reply(201, { id: '6' });
    const r = await deploysTool.handler(ctx(), {
      action: 'create',
      project_id: 1,
      deploy: { environment: 'prod', revision: 'abc123' },
    });
    expect(r).toEqual({ id: '6' });
  });
});
