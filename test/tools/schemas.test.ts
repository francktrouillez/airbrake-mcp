import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allTools } from '../../src/tools/index.js';
import {
  noticeUuid,
  pageSchema,
  projectId,
  snowflakeId,
  statsTimeRange,
} from '../../src/tools/schemas.js';

const SNOWFLAKE_MSG = 'must be a numeric snowflake ID (digits only)';
const UUID_MSG = 'must contain only alphanumerics and hyphens';

describe('schemas: snowflakeId', () => {
  it('accepts 19-digit strings beyond Number.MAX_SAFE_INTEGER verbatim', () => {
    for (const id of ['3741526488590376432', '4338294560506624262', '9999999999999999999']) {
      expect(snowflakeId.parse(id)).toBe(id);
    }
    expect(snowflakeId.parse('1')).toBe('1');
  });

  it('rejects JSON numbers (precision loss)', () => {
    expect(snowflakeId.safeParse(Number('3741526488590376432')).success).toBe(false);
    expect(snowflakeId.safeParse(42).success).toBe(false);
  });

  it.each([
    ['..'],
    ['../../999'],
    ['123/../999'],
    ['/'],
    ['123/456'],
    ['%2e%2e'],
    [''],
    ['+123'],
    ['-123'],
    [' 123'],
    ['123 '],
    ['12 34'],
    ['123\n'],
    ['1e5'],
    ['12.5'],
    ['abc'],
  ])('rejects %j with the canonical message', (bad) => {
    const r = snowflakeId.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(SNOWFLAKE_MSG);
  });

  it('rejects null / undefined / objects', () => {
    for (const bad of [null, undefined, {}, ['1']]) {
      expect(snowflakeId.safeParse(bad).success).toBe(false);
    }
  });
});

describe('schemas: noticeUuid', () => {
  it('accepts alphanumerics and hyphens', () => {
    for (const id of ['abc-123', '0f8fad5b-d9cb-469f-a165-70867728950e', 'ABC', '1']) {
      expect(noticeUuid.parse(id)).toBe(id);
    }
  });

  it.each([['..'], ['../x'], ['a/b'], ['/'], ['a\\b'], ['a.b'], [''], [' a'], ['a%2f']])(
    'rejects %j with the canonical message',
    (bad) => {
      const r = noticeUuid.safeParse(bad);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toBe(UUID_MSG);
    },
  );

  it('rejects non-strings', () => {
    expect(noticeUuid.safeParse(123).success).toBe(false);
  });
});

describe('schemas: projectId', () => {
  it('accepts positive integers', () => {
    for (const id of [1, 42, 123456789]) expect(projectId.parse(id)).toBe(id);
  });

  it.each([[0], [-1], [1.5], ['42'], [null], [Number.NaN], [Infinity]])('rejects %j', (bad) => {
    expect(projectId.safeParse(bad).success).toBe(false);
  });
});

describe('schemas: pageSchema', () => {
  it('defaults page=1 and per_page=50', () => {
    expect(pageSchema.parse({})).toEqual({ page: 1, per_page: 50 });
  });

  it('accepts the per_page bounds 1 and 200', () => {
    expect(pageSchema.parse({ page: 3, per_page: 1 })).toEqual({ page: 3, per_page: 1 });
    expect(pageSchema.parse({ per_page: 200 })).toEqual({ page: 1, per_page: 200 });
  });

  it.each([
    [{ page: 0 }],
    [{ page: -1 }],
    [{ page: 1.5 }],
    [{ page: '2' }],
    [{ per_page: 0 }],
    [{ per_page: 201 }],
    [{ per_page: 10.5 }],
    [{ per_page: '50' }],
  ])('rejects %j', (bad) => {
    expect(pageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('schemas: statsTimeRange', () => {
  const ok = { time__gte: '2026-01-01T00:00:00Z', time__lt: '2026-01-02T00:00:00Z' };

  it('requires time__gte, time__lt and period', () => {
    expect(statsTimeRange.parse({ ...ok, period: 'hour' })).toEqual({ ...ok, period: 'hour' });
    for (const key of ['time__gte', 'time__lt', 'period'] as const) {
      const input = { ...ok, period: 'day', [key]: undefined };
      expect(statsTimeRange.safeParse(input).success, key).toBe(false);
    }
  });

  it('only allows minute|hour|day periods', () => {
    for (const p of ['minute', 'hour', 'day']) {
      expect(statsTimeRange.safeParse({ ...ok, period: p }).success).toBe(true);
    }
    expect(statsTimeRange.safeParse({ ...ok, period: 'week' }).success).toBe(false);
  });
});

// Wiring: walk EVERY branch of EVERY tool and check each well-known field
// accepts/rejects exactly what its shared schema does. This auto-discovers
// new actions, and covers the later union branches that tools/list cannot
// show (mergeAnyOf keeps only the first branch's copy of a property).
describe('schemas: wired into every tool branch', () => {
  const shared: Record<string, z.ZodTypeAny> = {
    project_id: projectId,
    group_id: snowflakeId,
    notice_id: snowflakeId,
    deploy_id: snowflakeId,
    sourcemap_id: snowflakeId,
    notice_uuid: noticeUuid,
    ...pageSchema.shape,
    ...statsTimeRange.shape,
  };
  // Branch fields that are legitimately looser (optional) than the shared schema.
  const optionalFields = new Set(['airbrake_groups.list.deploy_id']);
  const corpus: unknown[] = [
    undefined,
    ...['3741526488590376432', Number('3741526488590376432'), '../x', '..', '', '1/2'],
    ...['abc-123', 'a/b', 42, 0, -1, 1.5, '42', 1, 200, 201, '50', null],
    ...['minute', 'hour', 'day', 'week', '2026-01-01T00:00:00Z'],
  ];

  const branches = allTools.flatMap((tool) => {
    const schema = tool.inputSchema as z.ZodTypeAny;
    const options: readonly z.AnyZodObject[] =
      schema instanceof z.ZodDiscriminatedUnion ? schema.options : [schema as z.AnyZodObject];
    return options.map((o) => ({ label: `${tool.name}.${o.shape.action?.value ?? '-'}`, o }));
  });

  const seenFields = new Set<string>();
  const seenPaths = new Set<string>();
  for (const { label, o } of branches) {
    for (const [field, shape] of Object.entries(shared)) {
      const actual = o.shape[field] as z.ZodTypeAny | undefined;
      if (!actual) continue;
      const path = `${label}.${field}`;
      seenFields.add(field);
      seenPaths.add(path);
      const expected = optionalFields.has(path) ? shape.optional() : shape;
      it(path, () => {
        for (const v of corpus) {
          expect(actual.safeParse(v).success, String(JSON.stringify(v))).toBe(
            expected.safeParse(v).success,
          );
        }
      });
    }
  }

  it('found every shared field, and every optionalFields entry still exists', () => {
    expect([...seenFields].sort()).toEqual(Object.keys(shared).sort());
    expect([...optionalFields].filter((p) => !seenPaths.has(p))).toEqual([]);
  });

  it('leaves no *_id field outside the shared validators', () => {
    const unchecked = branches.flatMap(({ label, o }) =>
      Object.keys(o.shape)
        .filter((k) => k.endsWith('_id') && !(k in shared))
        .map((k) => `${label}.${k}`),
    );
    expect(unchecked).toEqual([]);
  });
});
