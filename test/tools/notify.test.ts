import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { notifyTool } from '../../src/tools/notify.js';

const baseCfg = {
  userToken: 'tok',
  projectKeys: { '1': 'nk_abc' },
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};

describe('airbrake_notify', () => {
  beforeEach(() => nock.cleanAll());

  it('notify → POST /api/v3/projects/:pid/notices?key=...', async () => {
    nock('https://api.airbrake.io')
      .post('/api/v3/projects/1/notices', { errors: [{ type: 'Boom', message: 'fail' }] })
      .query({ key: 'nk_abc' })
      .reply(201, { id: 'n_1', url: 'https://airbrake.io/...' });

    const ctx = { client: new AirbrakeClient(baseCfg), config: baseCfg };
    const r = await notifyTool.handler(ctx, {
      action: 'notify',
      project_id: 1,
      payload: { errors: [{ type: 'Boom', message: 'fail' }] },
    });
    expect(r).toEqual({ id: 'n_1', url: 'https://airbrake.io/...' });
  });

  it('fails with actionable error when project key is missing', async () => {
    const cfg = { ...baseCfg, projectKeys: {} };
    const ctx = { client: new AirbrakeClient(cfg), config: cfg };
    await expect(
      notifyTool.handler(ctx, { action: 'notify', project_id: 1, payload: { errors: [] } }),
    ).rejects.toThrow(/AIRBRAKE_PROJECT_KEYS/);
  });
});
