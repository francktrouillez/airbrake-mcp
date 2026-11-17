import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { AirbrakeConfigError } from '../../src/client/errors.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};

// Backstop under the tool filter: even a tool wrongly annotated read-only
// cannot write while AIRBRAKE_READ_ONLY is set.
describe('AirbrakeClient read-only backstop', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
  });
  afterEach(() => nock.enableNetConnect());

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'refuses %s before any HTTP when readOnly is set',
    async (method) => {
      const client = new AirbrakeClient({ ...cfg, readOnly: true });
      const err = await client
        .request(method, '/api/v4/projects/1/groups/2')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AirbrakeConfigError);
      expect((err as Error).message).toBe(
        `${method} /api/v4/projects/1/groups/2 refused: AIRBRAKE_READ_ONLY is set`,
      );
      expect(nock.pendingMocks()).toHaveLength(0);
    },
  );

  it.each([
    [
      { headers: { 'X-HTTP-Method-Override': 'DELETE' } },
      '/api/v4/projects/1',
      /header x-http-method-override/,
    ],
    [{ headers: { 'x-method-override': 'PUT' } }, '/api/v4/projects/1', /header x-method-override/],
    [{ query: { _method: 'DELETE' } }, '/api/v4/projects/1', /query parameter _method/],
    [{}, '/api/v4/projects/1?_method=DELETE', /query parameter _method/],
    [{}, '/api/v4/projects/1?page=1&_METHOD=DELETE', /query parameter _METHOD/],
  ])('refuses a GET with a method override (%j %s) before any HTTP', async (opts, path, error) => {
    const client = new AirbrakeClient({ ...cfg, readOnly: true });
    const err = await client.request('GET', path, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirbrakeConfigError);
    expect((err as Error).message).toMatch(error);
    expect((err as Error).message).toMatch(/is not allowed while AIRBRAKE_READ_ONLY is set$/);
  });

  it('does not inspect overrides when readOnly is off', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1')
      .query({ _method: 'DELETE' })
      .reply(200, { project: { id: 1 } });
    const client = new AirbrakeClient({ ...cfg, readOnly: false });
    await expect(
      client.request('GET', '/api/v4/projects/1', { query: { _method: 'DELETE' } }),
    ).resolves.toEqual({ project: { id: 1 } });
  });

  it('allows GET when readOnly is set', async () => {
    nock('https://api.airbrake.io').get('/api/v4/projects').reply(200, { projects: [] });
    const client = new AirbrakeClient({ ...cfg, readOnly: true });
    await expect(client.request('GET', '/api/v4/projects')).resolves.toEqual({ projects: [] });
  });

  it('allows writes when readOnly is off', async () => {
    nock('https://api.airbrake.io').delete('/api/v4/projects/1/groups/2').reply(204);
    const client = new AirbrakeClient({ ...cfg, readOnly: false });
    await expect(client.request('DELETE', '/api/v4/projects/1/groups/2')).resolves.toBeNull();
  });
});
