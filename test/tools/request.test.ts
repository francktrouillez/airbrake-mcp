import { describe, it, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { requestReadOnlyTool, requestTool } from '../../src/tools/request.js';
import { EXPECTED_READ_ONLY_ANNOTATIONS } from '../fixtures/tool-annotations.js';

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

  it('rejects path traversal that bypasses startsWith("/api/")', async () => {
    for (const bad of [
      '/api/../admin',
      '/api/v4/../../admin',
      '/api/x/../../../etc/passwd',
      '/api/%2e%2e/admin',
      '/api/%2E%2E/admin',
    ]) {
      await expect(
        requestTool.handler(
          { client: new AirbrakeClient(cfg), config: cfg },
          { method: 'GET', path: bad },
        ),
      ).rejects.toThrow(/traversal/i);
    }
  });

  it('rejects CR/LF in header values', async () => {
    await expect(
      requestTool.handler(
        { client: new AirbrakeClient(cfg), config: cfg },
        {
          method: 'GET',
          path: '/api/v4/projects',
          headers: { 'x-bad': 'value\r\nX-Injected: yes' },
        },
      ),
    ).rejects.toThrow(/CR or LF/);
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

  describe('GET-only tool (AIRBRAKE_READ_ONLY)', () => {
    const variant = requestReadOnlyTool;
    const roCfg = { ...cfg, readOnly: true };
    const roCtx = () => ({ client: new AirbrakeClient(roCfg), config: roCfg });

    it('keeps the tool name and is annotated read-only', () => {
      expect(variant.name).toBe(requestTool.name);
      expect(variant.annotations).toEqual(EXPECTED_READ_ONLY_ANNOTATIONS.airbrake_request);
    });

    it('allows GET', async () => {
      nock('https://api.airbrake.io').get('/api/v4/projects').reply(200, { projects: [] });
      const result = await variant.handler(roCtx(), { method: 'GET', path: '/api/v4/projects' });
      expect(result).toEqual({ projects: [] });
    });

    const expectNoHttp = async (input: Record<string, unknown>, error: RegExp): Promise<void> => {
      const ctx = roCtx();
      const spy = vi.spyOn(ctx.client, 'request');
      await expect(variant.handler(ctx, input)).rejects.toThrow(error);
      expect(spy).not.toHaveBeenCalled();
    };

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'delete', 'Post'])(
      'refuses write method %j, naming the setting, before any HTTP',
      async (method) => {
        await expectNoHttp(
          { method, path: '/api/v4/projects/1/groups/2' },
          new RegExp(`method ${method} is disabled: AIRBRAKE_READ_ONLY is set`),
        );
      },
    );

    it.each([['get'], ['HEAD'], [undefined]])(
      'reports malformed method %j as invalid input (not as read-only), with no HTTP',
      async (method) => {
        const ctx = roCtx();
        const spy = vi.spyOn(ctx.client, 'request');
        const err = await variant
          .handler(ctx, { method, path: '/api/v4/projects' })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/method/);
        expect((err as Error).message).not.toMatch(/AIRBRAKE_READ_ONLY/);
        expect(spy).not.toHaveBeenCalled();
      },
    );

    // These reach the client, whose read-only guard refuses them before
    // fetch; net connect is disabled so a broken guard fails loudly.
    const expectClientRefusal = async (
      input: Record<string, unknown>,
      error: RegExp,
    ): Promise<void> => {
      nock.disableNetConnect();
      try {
        await expect(variant.handler(roCtx(), input)).rejects.toThrow(error);
      } finally {
        nock.enableNetConnect();
      }
    };

    it.each(['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override'])(
      'refuses method-override header %j before any HTTP',
      async (header) => {
        await expectClientRefusal(
          { method: 'GET', path: '/api/v4/projects/1', headers: { [header]: 'DELETE' } },
          new RegExp(
            `method-override header ${header.toLowerCase()} is not allowed while AIRBRAKE_READ_ONLY is set`,
          ),
        );
      },
    );

    it('refuses a body (GET cannot carry one), naming the setting, before any HTTP', async () => {
      await expectNoHttp(
        { method: 'GET', path: '/api/v4/projects', body: {} },
        /airbrake_request body is disabled: AIRBRAKE_READ_ONLY is set/,
      );
    });

    it.each(['_method', '_METHOD'])(
      'refuses method-override query parameter %j before any HTTP',
      async (param) => {
        await expectClientRefusal(
          { method: 'GET', path: '/api/v4/projects/1', query: { [param]: 'DELETE' } },
          new RegExp(`query parameter ${param} is not allowed while AIRBRAKE_READ_ONLY is set`),
        );
      },
    );

    it('refuses a _method override smuggled into the path before any HTTP', async () => {
      await expectClientRefusal(
        { method: 'GET', path: '/api/v4/projects/1/groups/2?_method=DELETE' },
        /query parameter _method is not allowed while AIRBRAKE_READ_ONLY is set/,
      );
    });

    it('still forwards ordinary headers and query on GET', async () => {
      nock('https://api.airbrake.io', { reqheaders: { 'x-trace': 't1' } })
        .get('/api/v4/projects')
        .query({ page: '2' })
        .reply(200, { projects: [] });
      const result = await variant.handler(roCtx(), {
        method: 'GET',
        path: '/api/v4/projects',
        query: { page: 2 },
        headers: { 'X-Trace': 't1' },
      });
      expect(result).toEqual({ projects: [] });
    });

    it('still enforces the path traversal guard', async () => {
      await expect(
        variant.handler(roCtx(), { method: 'GET', path: '/api/%2e%2e/admin' }),
      ).rejects.toThrow(/traversal/i);
    });
  });
});
