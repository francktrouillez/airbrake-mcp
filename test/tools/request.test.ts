import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { requestTool } from '../../src/tools/request.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};

describe('airbrake_request tool', () => {
  beforeEach(() => nock.cleanAll());

  it('forwards method + path verbatim', async () => {
    nock('https://api.airbrake.io').get('/api/v4/projects').reply(200, { projects: [] });
    const result = await requestTool.handler(
      { client: new AirbrakeClient(cfg), config: cfg },
      { method: 'GET', path: '/api/v4/projects' },
    );
    expect(result).toEqual({ projects: [] });
  });

  it('rejects paths that do not start with /api/', async () => {
    await expect(
      requestTool.handler(
        { client: new AirbrakeClient(cfg), config: cfg },
        // @ts-expect-error - testing zod-bypassed input
        { method: 'GET', path: '/etc/passwd' },
      ),
    ).rejects.toThrow(/path/);
  });

  it('forwards auth:none for project-key endpoints', async () => {
    nock('https://api.airbrake.io', { badheaders: ['authorization'] })
      .post('/api/v3/projects/1/notices')
      .query({ key: 'nk_abc' })
      .reply(201, { id: 'n_1' });
    const result = await requestTool.handler(
      { client: new AirbrakeClient(cfg), config: cfg },
      {
        method: 'POST',
        path: '/api/v3/projects/1/notices',
        query: { key: 'nk_abc' },
        body: { errors: [] },
        auth: 'none',
      },
    );
    expect(result).toEqual({ id: 'n_1' });
  });

  it('forwards query and body', async () => {
    nock('https://api.airbrake.io')
      .patch('/api/v4/projects/1/groups/2', { resolved: true })
      .query({ foo: 'bar' })
      .reply(200, { group: { id: 2, resolved: true } });
    const result = await requestTool.handler(
      { client: new AirbrakeClient(cfg), config: cfg },
      {
        method: 'PATCH',
        path: '/api/v4/projects/1/groups/2',
        query: { foo: 'bar' },
        body: { resolved: true },
      },
    );
    expect(result).toEqual({ group: { id: 2, resolved: true } });
  });
});
