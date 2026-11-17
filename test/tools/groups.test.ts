import { describe, it, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { groupsTool } from '../../src/tools/groups.js';
import { toMcpInputSchema } from '../../src/server.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const GROUP_ID = '4338045234182207507';

describe('airbrake_groups', () => {
  beforeEach(() => nock.cleanAll());

  it('list with basic filters', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({ page: '1', per_page: '50', environment: 'prod', resolved: 'false' })
      .reply(200, { groups: [] });
    const r = await groupsTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      environment: 'prod',
      resolved: false,
    });
    expect(r).toMatchObject({ groups: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('list with string deploy_id and other filters', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({
        page: '1',
        per_page: '50',
        environment: 'prod',
        deploy_id: '4338294560506624262',
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-05-23T00:00:00Z',
        order: 'last_notice',
        archived: 'false',
      })
      .reply(200, { groups: [] });
    const r = await groupsTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      environment: 'prod',
      deploy_id: '4338294560506624262',
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-23T00:00:00Z',
      order: 'last_notice',
      archived: false,
    });
    expect(r).toMatchObject({ groups: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('list with count → has_more/next_page/total_pages', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/groups')
      .query({ page: '2', per_page: '50' })
      .reply(200, { groups: [{ id: '1' }], count: 120 });
    const r = await groupsTool.handler(ctx(), { action: 'list', project_id: 1, page: 2 });
    expect(r).toMatchObject({
      _pagination: {
        page: 2,
        per_page: 50,
        count: 120,
        has_more: true,
        next_page: 3,
        total_pages: 3,
      },
    });
  });

  it('get with string group_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}`)
      .reply(200, { group: { id: GROUP_ID } });
    const r = await groupsTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID } });
  });

  it('rejects numeric group_id (string-only schema)', async () => {
    await expect(
      groupsTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        // @ts-expect-error: schema is string-only; number rejection is asserted at runtime
        group_id: 12345,
      }),
    ).rejects.toThrow();
  });

  it('rejects path traversal in group_id', async () => {
    for (const bad of ['../../999', '123/../999', 'abc', '123abc', '../etc/passwd', '']) {
      await expect(
        groupsTool.handler(ctx(), { action: 'get', project_id: 1, group_id: bad }),
      ).rejects.toThrow(/snowflake/i);
    }
  });

  it('rejects path traversal in deploy_id filter', async () => {
    await expect(
      groupsTool.handler(ctx(), { action: 'list', project_id: 1, deploy_id: '../../999' }),
    ).rejects.toThrow(/snowflake/i);
  });

  it('get_stats → GET /api/v5/.../stats with required time params', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v5/projects/1/groups/${GROUP_ID}/stats`)
      .query({
        time__gte: '2026-05-17T00:00:00Z',
        time__lt: '2026-05-24T00:00:00Z',
        period: 'hour',
      })
      .reply(200, { accepted: [2], limited: [0] });
    const r = await groupsTool.handler(ctx(), {
      action: 'get_stats',
      project_id: 1,
      group_id: GROUP_ID,
      time__gte: '2026-05-17T00:00:00Z',
      time__lt: '2026-05-24T00:00:00Z',
      period: 'hour',
    });
    expect(r).toEqual({ accepted: [2], limited: [0] });
  });

  describe('get_stats parameter contract', () => {
    const STATS_PATH = `/api/v5/projects/1/groups/${GROUP_ID}/stats`;
    const base = { action: 'get_stats' as const, project_id: 1, group_id: GROUP_ID };

    type StatsArgs = Omit<
      Extract<Parameters<typeof groupsTool.handler>[1], { action: 'get_stats' }>,
      'action' | 'project_id' | 'group_id'
    >;

    // Every value must be forwarded verbatim, so the expected query is the
    // args stringified. nock's object `.query()` is an exact match, so each
    // case also proves that omitted params (time__lt, limit) are not sent.
    const acceptCases: [string, StatsArgs][] = [
      ['only time__gte (Unix) + period', { time__gte: 1699485224, period: 'hour' }],
      ['a Unix-seconds range', { time__gte: 1699485224, time__lt: 1699571624, period: 'minute' }],
      ['0 as a Unix-seconds lower bound', { time__gte: 0, period: 'day' }],
      [
        'Unix seconds as digit strings',
        { time__gte: '1699485224', time__lt: '1699571624', period: 'hour' },
      ],
      [
        'ISO strings (offset, fraction, date-only)',
        { time__gte: '2026-05-17T00:00:00.123+02:00', time__lt: '2026-05-24', period: 'hour' },
      ],
      [
        'RFC 3339 variants (space separator, lowercase z, ±HHMM offset)',
        { time__gte: '2026-05-17 00:00:00z', time__lt: '2026-05-17T05:00:00+0200', period: 'hour' },
      ],
      [
        'mixed formats when ordered correctly',
        { time__gte: 1699485224, time__lt: '2023-11-10T00:00:00Z', period: 'hour' },
      ],
      ['limit at its lower bound', { time__gte: 0, period: 'hour', limit: 1 }],
      [
        'limit at its upper bound',
        { time__gte: '2026-05-17T00:00:00Z', period: 'hour', limit: 1000 },
      ],
    ];

    for (const [label, args] of acceptCases) {
      it(`forwards ${label} verbatim`, async () => {
        const expectedQuery = Object.fromEntries(
          Object.entries(args).map(([k, v]) => [k, String(v)]),
        );
        nock('https://api.airbrake.io')
          .get(STATS_PATH)
          .query(expectedQuery)
          .reply(200, { accepted: [1] });
        await expect(groupsTool.handler(ctx(), { ...base, ...args })).resolves.toEqual({
          accepted: [1],
        });
      });
    }

    it('reports only the real problem when a bound is out of range', async () => {
      const err = await groupsTool
        .handler(ctx(), {
          ...base,
          time__gte: 1699485224000,
          time__lt: 1699485225,
          period: 'hour',
        })
        .catch((e: unknown) => e);
      expect(String(err)).toMatch(/not milliseconds/);
      expect(String(err)).not.toMatch(/earlier than/);
    });

    it('orders offset-less date-times as UTC regardless of the host time zone', async () => {
      vi.stubEnv('TZ', 'America/New_York');
      try {
        nock('https://api.airbrake.io').get(STATS_PATH).query(true).reply(200, {});
        // 00:00 (no offset, read as UTC) < 01:00Z. Date.parse would read it as
        // 04:00Z on this host and wrongly reject the range.
        await expect(
          groupsTool.handler(ctx(), {
            ...base,
            time__gte: '2026-05-17T00:00:00',
            time__lt: '2026-05-17T01:00:00Z',
            period: 'hour',
          }),
        ).resolves.toEqual({});
        await expect(
          groupsTool.handler(ctx(), {
            ...base,
            time__gte: '2026-05-17T02:00:00',
            time__lt: '2026-05-17T01:00:00Z',
            period: 'hour',
          }),
        ).rejects.toThrow(/earlier than/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    const rejectCases: [string, Record<string, unknown>][] = [
      ['missing time__gte', { period: 'hour' }],
      ['missing period', { time__gte: 1699485224 }],
      ['unknown period', { time__gte: 1699485224, period: 'week' }],
      ['natural-language time__gte', { time__gte: 'yesterday', period: 'hour' }],
      ['natural-language time__lt', { time__gte: 1699485224, time__lt: 'now', period: 'hour' }],
      ['empty string', { time__gte: '', period: 'hour' }],
      ['milliseconds as a digit string', { time__gte: '1699485224000', period: 'hour' }],
      ['impossible calendar date', { time__gte: '2026-02-30T00:00:00Z', period: 'hour' }],
      ['out-of-range month', { time__gte: '2026-13-01', period: 'hour' }],
      ['out-of-range hour', { time__gte: '2026-05-17T25:00:00Z', period: 'hour' }],
      ['hour 24', { time__gte: '2026-05-17T24:00:00Z', period: 'hour' }],
      ['leap second', { time__gte: '2026-05-17T23:59:60Z', period: 'hour' }],
      ['Feb 29 in a non-leap year', { time__gte: '2026-02-29', period: 'hour' }],
      ['out-of-range offset', { time__gte: '2026-05-17T00:00:00+24:00', period: 'hour' }],
      ['non-ISO date format', { time__gte: '05/17/2026', period: 'hour' }],
      ['RFC 2822 string', { time__gte: 'Sun, 17 May 2026 00:00:00 GMT', period: 'hour' }],
      ['negative Unix seconds', { time__gte: -1, period: 'hour' }],
      ['fractional Unix seconds', { time__gte: 1699485224.5, period: 'hour' }],
      ['milliseconds instead of seconds', { time__gte: 1699485224000, period: 'hour' }],
      ['boolean timestamp', { time__gte: true, period: 'hour' }],
      ['limit 0', { time__gte: 1699485224, period: 'hour', limit: 0 }],
      ['limit 1001', { time__gte: 1699485224, period: 'hour', limit: 1001 }],
      ['fractional limit', { time__gte: 1699485224, period: 'hour', limit: 2.5 }],
      ['string limit', { time__gte: 1699485224, period: 'hour', limit: '50' }],
      [
        'time__gte equal to time__lt',
        { time__gte: 1699485224, time__lt: 1699485224, period: 'hour' },
      ],
      [
        'time__gte after time__lt (ISO)',
        { time__gte: '2026-05-24T00:00:00Z', time__lt: '2026-05-17T00:00:00Z', period: 'hour' },
      ],
      [
        'time__gte after time__lt (mixed formats)',
        { time__gte: '2030-01-01T00:00:00Z', time__lt: 1699485224, period: 'hour' },
      ],
    ];

    for (const [label, args] of rejectCases) {
      it(`rejects ${label} with zero HTTP`, async () => {
        // Any request to the stats endpoint would consume this interceptor
        // and succeed — so a rejection plus an untouched scope proves the
        // input was refused before HTTP.
        const scope = nock('https://api.airbrake.io')
          .get(STATS_PATH)
          .query(true)
          .reply(200, { accepted: [] });
        await expect(
          // @ts-expect-error: deliberately invalid shapes asserted at runtime
          groupsTool.handler(ctx(), { ...base, ...args }),
        ).rejects.toThrow();
        expect(scope.isDone()).toBe(false);
      });
    }

    it('emits sane MCP JSON schemas for the get_stats properties', () => {
      const schema = toMcpInputSchema(groupsTool.inputSchema) as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      for (const name of ['time__gte', 'time__lt']) {
        expect(schema.properties[name]).toMatchObject({
          anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }],
        });
        expect(schema.properties[name]?.description).toMatch(/Unix seconds.*ISO 8601/);
      }
      expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
      expect(schema.properties.period).toMatchObject({ enum: ['minute', 'hour', 'day'] });
      expect(schema.required ?? []).not.toContain('time__lt');
      expect(schema.required ?? []).not.toContain('limit');
    });

    it('names the offending field in the ordering error', async () => {
      await expect(
        groupsTool.handler(ctx(), {
          ...base,
          time__gte: 1699485225,
          time__lt: 1699485224,
          period: 'hour',
        }),
      ).rejects.toThrow(/time__gte.*earlier than.*time__lt/);
    });
  });

  it.each([
    ['mute', 'airbrake_groups_update'],
    ['unmute', 'airbrake_groups_update'],
    ['resolve', 'airbrake_groups_update'],
    ['unresolve', 'airbrake_groups_update'],
    ['delete', 'airbrake_delete with resource "group"'],
  ])('rejects moved write action %j, pointing at %s, with no HTTP', async (action, target) => {
    await expect(
      groupsTool.handler(ctx(), {
        // @ts-expect-error: write actions were removed from the read-only tool
        action,
        project_id: 1,
        group_id: GROUP_ID,
      }),
    ).rejects.toThrow(`airbrake_groups no longer supports action "${action}": use ${target}`);
    expect(nock.pendingMocks()).toHaveLength(0);
  });
});
