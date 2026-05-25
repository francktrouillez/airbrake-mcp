import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { performanceTool } from '../../src/tools/performance.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const baseTime = {
  time__gte: '2026-05-17T00:00:00Z',
  time__lt: '2026-05-24T00:00:00Z',
  period: 'hour' as const,
};

describe('airbrake_performance', () => {
  beforeEach(() => nock.cleanAll());

  it('routes_stats → GET /api/v5/projects/:pid/routes-stats (route optional)', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v5/projects/1/routes-stats')
      .query({ ...baseTime, environment: 'staging' })
      .reply(200, { time: [], total: { count: [] } });
    const r = await performanceTool.handler(ctx(), {
      action: 'routes_stats',
      project_id: 1,
      ...baseTime,
      environment: 'staging',
    });
    expect(r).toEqual({ time: [], total: { count: [] } });
  });

  it('queries_stats → GET /api/v5/projects/:pid/queries-stats with required route', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v5/projects/1/queries-stats')
      .query({ ...baseTime, route: '/api/items' })
      .reply(200, { stat: { count: [] }, time: [] });
    const r = await performanceTool.handler(ctx(), {
      action: 'queries_stats',
      project_id: 1,
      ...baseTime,
      route: '/api/items',
    });
    expect(r).toEqual({ stat: { count: [] }, time: [] });
  });

  it('queries_stats rejects missing route', async () => {
    await expect(
      performanceTool.handler(ctx(), {
        // @ts-expect-error - missing required `route`
        action: 'queries_stats',
        project_id: 1,
        ...baseTime,
      }),
    ).rejects.toThrow();
  });

  it('queues_stats → GET /api/v5/projects/:pid/queues-stats with required queue', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v5/projects/1/queues-stats')
      .query({ ...baseTime, queue: 'default' })
      .reply(200, { stat: { count: [] }, time: [] });
    const r = await performanceTool.handler(ctx(), {
      action: 'queues_stats',
      project_id: 1,
      ...baseTime,
      queue: 'default',
    });
    expect(r).toEqual({ stat: { count: [] }, time: [] });
  });

  it('queues_stats rejects missing queue', async () => {
    await expect(
      performanceTool.handler(ctx(), {
        // @ts-expect-error - missing required `queue`
        action: 'queues_stats',
        project_id: 1,
        ...baseTime,
      }),
    ).rejects.toThrow();
  });

  it('does not expose routes_breakdowns (PUT-only on server)', () => {
    const actions = (
      performanceTool.inputSchema._def.options as Array<{ shape: { action: { value: string } } }>
    ).map((opt) => opt.shape.action.value);
    expect(actions).not.toContain('routes_breakdowns');
  });
});
