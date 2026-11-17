// End-to-end coverage for `airbrake_groups` `get_stats`: the built binary over
// real stdio, asserting the exact query string Airbrake receives and that
// invalid inputs never reach the network.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const PROJECT_ID = 42;
const GROUP_ID = '3741526488590376432';
const STATS_PATH = `/api/v5/projects/${PROJECT_ID}/groups/${GROUP_ID}/stats`;
const STATS_BODY = {
  time: ['2023-11-08T23:00:00Z', '2023-11-09T00:00:00Z'],
  accepted: [3, 1],
  limited: [0, 0],
};

const statsArgs = (extra: Record<string, unknown>): Record<string, unknown> => ({
  action: 'get_stats',
  project_id: PROJECT_ID,
  group_id: GROUP_ID,
  ...extra,
});

describe('e2e: airbrake_groups get_stats', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: 'e2e-user-token',
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_MAX_RETRIES: '0',
      AIRBRAKE_TIMEOUT_MS: '3000',
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await mock.stop();
  });

  afterEach(() => {
    try {
      mock.assertNoUnhandled();
    } finally {
      mock.reset();
    }
  });

  it('sends only time__gte (Unix seconds) and period when time__lt is omitted', async () => {
    mock.on('GET', STATS_PATH, { body: STATS_BODY });
    const res = await mcp.call(
      'airbrake_groups',
      statsArgs({ time__gte: 1699485224, period: 'hour' }),
    );
    expect(res.isError).toBe(false);
    expect(res.json).toEqual(STATS_BODY);
    const reqs = mock.find('GET', STATS_PATH);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toEqual({ time__gte: '1699485224', period: 'hour' });
  });

  it('forwards an ISO 8601 range and limit verbatim', async () => {
    mock.on('GET', STATS_PATH, { body: STATS_BODY });
    const res = await mcp.call(
      'airbrake_groups',
      statsArgs({
        time__gte: '2026-05-17T00:00:00Z',
        time__lt: '2026-05-24T00:00:00+02:00',
        period: 'minute',
        limit: 50,
      }),
    );
    expect(res.isError).toBe(false);
    const [req] = mock.find('GET', STATS_PATH);
    expect(req?.query).toEqual({
      time__gte: '2026-05-17T00:00:00Z',
      time__lt: '2026-05-24T00:00:00+02:00',
      period: 'minute',
      limit: '50',
    });
  });

  // One case per validation path; the exhaustive input matrix lives in the
  // unit suite (test/tools/groups.test.ts). The reversed-range path is
  // covered by the next test.
  const invalid: [string, Record<string, unknown>][] = [
    ['an invalid ISO string', { time__gte: 'yesterday', period: 'hour' }],
    ['an impossible calendar date', { time__gte: '2026-02-30T00:00:00Z', period: 'hour' }],
    ['Unix milliseconds', { time__gte: 1699485224000, period: 'hour' }],
    ['limit out of range', { time__gte: 1699485224, period: 'hour', limit: 1001 }],
    ['an unknown period', { time__gte: 1699485224, period: 'week' }],
    ['a missing time__gte', { period: 'hour' }],
  ];

  for (const [label, args] of invalid) {
    it(`rejects ${label} with isError and zero requests`, async () => {
      mock.on('GET', STATS_PATH, { body: STATS_BODY });
      const res = await mcp.call('airbrake_groups', statsArgs(args));
      expect(res.isError).toBe(true);
      expect(mock.requests).toHaveLength(0);
    });
  }

  it('explains a reversed range in the error text', async () => {
    const res = await mcp.call(
      'airbrake_groups',
      statsArgs({
        time__gte: '2026-05-24T00:00:00Z',
        time__lt: '2026-05-17T00:00:00Z',
        period: 'hour',
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/time__gte .* must be earlier than time__lt/);
    expect(mock.requests).toHaveLength(0);
  });

  it('advertises time__lt and limit as optional, well-formed properties in tools/list', async () => {
    const { tools } = await mcp.client.listTools();
    const groups = tools.find((t) => t.name === 'airbrake_groups');
    expect(groups).toBeDefined();
    const schema = groups!.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const required = schema.required ?? [];
    expect(required).not.toContain('time__lt');
    expect(required).not.toContain('limit');
    for (const name of ['time__gte', 'time__lt']) {
      expect(schema.properties[name]).toMatchObject({
        anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }],
      });
    }
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
    expect(schema.properties.period).toMatchObject({
      type: 'string',
      enum: ['minute', 'hour', 'day'],
    });
    expect(groups!.description).toMatch(/time__lt \(defaults to now\)/);
  });
});
