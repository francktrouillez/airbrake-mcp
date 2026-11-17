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

  it('list without count → has_more is an estimate from the deploys array', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/deploys')
      .query({ page: '1', per_page: '1' })
      .reply(200, { deploys: [{ id: DEPLOY_ID }] });
    const r = await deploysTool.handler(ctx(), { action: 'list', project_id: 1, per_page: 1 });
    expect(r).toMatchObject({
      _pagination: {
        page: 1,
        per_page: 1,
        has_more: true,
        next_page: 2,
        has_more_is_estimate: true,
      },
    });
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

  it('no longer accepts the create action (moved to airbrake_deploys_create)', async () => {
    await expect(
      deploysTool.handler(ctx(), {
        // @ts-expect-error: create was removed from the read-only tool
        action: 'create',
        project_id: 1,
        deploy: { environment: 'prod' },
      }),
    ).rejects.toThrow(
      'airbrake_deploys no longer supports action "create": use airbrake_deploys_create',
    );
  });
});
