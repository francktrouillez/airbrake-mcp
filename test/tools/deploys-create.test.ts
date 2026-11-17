import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { deploysCreateTool } from '../../src/tools/deploys-create.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
  readOnly: false,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

describe('airbrake_deploys_create', () => {
  beforeEach(() => nock.cleanAll());

  it('POSTs the deploy fields at the TOP LEVEL of the body (no { deploy: ... } wrapper)', async () => {
    // Verified against live Airbrake: the wrapped payload silently creates
    // an empty deploy marker; the flat payload persists all fields.
    nock('https://api.airbrake.io')
      .post('/api/v4/projects/1/deploys', { environment: 'prod', revision: 'abc123' })
      .reply(201, { id: '6' });
    const r = await deploysCreateTool.handler(ctx(), {
      project_id: 1,
      deploy: { environment: 'prod', revision: 'abc123' },
    });
    expect(r).toEqual({ id: '6' });
  });

  it('requires a deploy object', async () => {
    await expect(
      // @ts-expect-error: deploy is required
      deploysCreateTool.handler(ctx(), { project_id: 1 }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive project_id', async () => {
    await expect(
      deploysCreateTool.handler(ctx(), { project_id: 0, deploy: { environment: 'prod' } }),
    ).rejects.toThrow();
  });
});
