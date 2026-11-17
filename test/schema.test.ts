import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatToolError, toMcpInputSchema } from '../src/server.js';
import { allTools } from '../src/tools/index.js';
import { groupsTool } from '../src/tools/groups.js';
import { performanceTool } from '../src/tools/performance.js';
import { requestTool } from '../src/tools/request.js';
import { allKeys } from './helpers/json-schema.js';

type Json = Record<string, unknown>;

const page = {
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
};

function props(schema: Json): Record<string, Json> {
  return schema.properties as Record<string, Json>;
}

describe('toMcpInputSchema — flattening zod 4 unions', () => {
  it('sanity: zod 4 emits discriminatedUnion as top-level oneOf with const discriminators', () => {
    const raw = z.toJSONSchema(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('a') }),
        z.object({ action: z.literal('b') }),
      ]),
    ) as Json;
    expect(Array.isArray(raw.oneOf)).toBe(true);
    expect((raw.oneOf as Json[])[0].properties).toMatchObject({ action: { const: 'a' } });
  });

  it('flattens a discriminatedUnion (oneOf) into one closed object schema', () => {
    const schema = toMcpInputSchema(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('list'), project_id: z.number().int() }).extend(page),
        z.object({ action: z.literal('get'), project_id: z.number().int(), id: z.string() }),
        z.object({ action: z.literal('delete'), project_id: z.number().int(), id: z.string() }),
      ]),
    );
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('allOf');
    expect(schema.additionalProperties).toBe(false);
    expect(props(schema).action).toEqual({ type: 'string', enum: ['list', 'get', 'delete'] });
    expect(Object.keys(props(schema))).toEqual(['action', 'project_id', 'page', 'per_page', 'id']);
    // `id` is required in 2 of 3 branches only, so it is not required at the top.
    expect(schema.required).toEqual(['action', 'project_id']);
  });

  it('flattens a plain z.union of objects (anyOf) the same way', () => {
    const raw = z.toJSONSchema(
      z.union([z.object({ action: z.literal('x') }), z.object({ action: z.literal('y') })]),
    ) as Json;
    expect(Array.isArray(raw.anyOf)).toBe(true);

    const schema = toMcpInputSchema(
      z.union([
        z.object({ action: z.literal('x'), a: z.string() }),
        z.object({ action: z.literal('y'), b: z.string() }),
      ]),
    );
    expect(schema).not.toHaveProperty('anyOf');
    expect(props(schema).action.enum).toEqual(['x', 'y']);
    expect(schema.required).toEqual(['action']);
  });

  it('merges enum-valued discriminators (multi-value literal / z.enum) with const ones, deduplicated', () => {
    const schema = toMcpInputSchema(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal(['a', 'b']) }),
        z.object({ action: z.literal('c') }),
        z.object({ action: z.enum(['b', 'd']) }),
        z.object({ action: z.literal('a') }),
      ]),
    );
    expect(props(schema).action).toEqual({ type: 'string', enum: ['a', 'b', 'c', 'd'] });
  });

  it('uses the union’s real discriminator key, not just `action`', () => {
    const schema = toMcpInputSchema(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), action: z.literal('x') }),
        z.object({ kind: z.literal('b'), action: z.literal('y') }),
      ]),
    );
    expect(props(schema).kind).toEqual({ type: 'string', enum: ['a', 'b'] });
    // Non-discriminator properties stay first-branch-wins (pre-existing behaviour).
    expect(props(schema).action).toEqual({ type: 'string', const: 'x' });
  });

  it('keeps the discriminator open when any branch leaves it open', () => {
    const openFirst = toMcpInputSchema(
      z.union([z.object({ action: z.string() }), z.object({ action: z.literal('x') })]),
    );
    expect(props(openFirst).action).toEqual({ type: 'string' });
    const openLast = toMcpInputSchema(
      z.union([z.object({ action: z.literal('x') }), z.object({ action: z.string() })]),
    );
    expect(props(openLast).action).toEqual({ type: 'string' });
  });

  it('keeps a single-branch discriminator as `const` (matches the zod 3 output)', () => {
    const schema = toMcpInputSchema(
      z.discriminatedUnion('action', [z.object({ action: z.literal('notify'), n: z.number() })]),
    );
    expect(props(schema).action).toEqual({ type: 'string', const: 'notify' });
    expect(schema.required).toEqual(['action', 'n']);
  });

  it('does not mark defaulted fields as required (io: "input")', () => {
    const schema = toMcpInputSchema(
      z.discriminatedUnion('action', [z.object({ action: z.literal('list') }).extend(page)]),
    );
    expect(schema.required).toEqual(['action']);
    expect(props(schema).page).toEqual({ type: 'integer', exclusiveMinimum: 0, default: 1 });
    expect(props(schema).per_page).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
    });
  });

  it('omits `required` entirely when no field is required in every branch', () => {
    const schema = toMcpInputSchema(
      z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    );
    expect(schema).not.toHaveProperty('required');
  });
});

describe('toMcpInputSchema — plain objects and zod 3 compatibility', () => {
  it('closes a top-level plain object and keeps its $schema/required', () => {
    const schema = toMcpInputSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(schema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('keeps an explicit additionalProperties on a loose top-level object', () => {
    const schema = toMcpInputSchema(z.looseObject({ a: z.string() }));
    expect(schema.additionalProperties).toEqual({});
  });

  // Each field is converted inside `z.object({ x: field })` and compared exactly.
  it.each<[string, z.ZodType, Json]>([
    [
      'startsWith drops the pseudo-format',
      z.string().startsWith('/api/'),
      { type: 'string', pattern: '^\\/api\\/.*' },
    ],
    [
      'endsWith drops the pseudo-format',
      z.string().endsWith('.js'),
      { type: 'string', pattern: '.*\\.js$' },
    ],
    [
      'includes drops the pseudo-format',
      z.string().includes('x'),
      { type: 'string', pattern: 'x' },
    ],
    [
      'real formats are kept',
      z.email(),
      expect.objectContaining({ type: 'string', format: 'email' }),
    ],
    ['.int() drops the safe-integer bounds', z.number().int(), { type: 'integer' }],
    [
      'explicit integer bounds are kept',
      z
        .number()
        .int()
        .min(-5)
        .max(Number.MAX_SAFE_INTEGER - 1),
      { type: 'integer', minimum: -5, maximum: Number.MAX_SAFE_INTEGER - 1 },
    ],
    [
      'non-integer MAX_SAFE_INTEGER bound is kept',
      z.number().max(Number.MAX_SAFE_INTEGER),
      { type: 'number', maximum: Number.MAX_SAFE_INTEGER },
    ],
    [
      'string-keyed records drop propertyNames (nested too)',
      z.record(z.string(), z.object({ inner: z.number().int() })),
      {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { inner: { type: 'integer' } },
          required: ['inner'],
          additionalProperties: false,
        },
      },
    ],
    [
      'records inside arrays drop propertyNames',
      z.array(z.record(z.string(), z.unknown())),
      { type: 'array', items: { type: 'object', additionalProperties: {} } },
    ],
    [
      'nested strip objects are closed (zod-to-json-schema did this at every depth)',
      z.object({ a: z.object({ b: z.string() }) }),
      {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: { b: { type: 'string' } },
            required: ['b'],
            additionalProperties: false,
          },
        },
        required: ['a'],
        additionalProperties: false,
      },
    ],
    [
      'nested loose objects stay open',
      z.looseObject({ a: z.string() }),
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: {},
      },
    ],
  ])('%s', (_name, field, expected) => {
    expect(props(toMcpInputSchema(z.object({ x: field }))).x).toEqual(expected);
  });

  it('only touches schema keywords, not properties whose NAME collides with one', () => {
    const schema = toMcpInputSchema(z.object({ format: z.string(), propertyNames: z.string() }));
    expect(props(schema).format).toEqual({ type: 'string' });
    expect(props(schema).propertyNames).toEqual({ type: 'string' });
  });

  it('inlines reused subschemas instead of emitting $ref/definitions', () => {
    const shared = z.object({ id: z.string() });
    const schema = toMcpInputSchema(z.object({ a: shared, b: shared }));
    const keys = allKeys(schema);
    for (const forbidden of ['$ref', '$defs', 'definitions']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(props(schema).b).toEqual(props(schema).a);
  });

  it('throws on unrepresentable types instead of silently advertising `{}`', () => {
    expect(() => toMcpInputSchema(z.object({ when: z.date() }))).toThrow();
  });

  it('wraps a non-object root in type: object without closing it (pre-existing fallback)', () => {
    const schema = toMcpInputSchema(z.any());
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('additionalProperties');
  });

  it('converts every real tool schema with no $ref/definitions/propertyNames anywhere', () => {
    for (const tool of allTools) {
      const schema = toMcpInputSchema(tool.inputSchema);
      expect(schema.type, tool.name).toBe('object');
      for (const k of ['anyOf', 'oneOf', 'allOf', '$ref']) {
        expect(schema, `${tool.name} has top-level ${k}`).not.toHaveProperty(k);
      }
      const keys = allKeys(schema);
      for (const k of ['$ref', '$defs', 'definitions', 'propertyNames']) {
        expect(keys.has(k), `${tool.name} contains ${k}`).toBe(false);
      }
      const required = (schema.required as string[] | undefined) ?? [];
      expect(required, `${tool.name} marks a defaulted field required`).not.toContain('page');
      expect(required).not.toContain('per_page');
    }
  });
});

describe('formatToolError', () => {
  function zodError(schema: z.ZodType, input: unknown): z.ZodError {
    const result = schema.safeParse(input);
    if (result.success) throw new Error('expected a validation failure');
    return result.error;
  }

  it('is concise, names the tool and the offending field, and is not a JSON dump', () => {
    const err = zodError(groupsTool.inputSchema, {
      action: 'get',
      project_id: 42,
      group_id: 3741526488590376,
    });
    const text = formatToolError('airbrake_groups', err);
    expect(text).toBe(
      'Invalid arguments for airbrake_groups:\n✖ Invalid input: expected string, received number\n  → at group_id',
    );
    expect(() => JSON.parse(text)).toThrow();
  });

  it('lists one entry per issue and keeps custom refinement messages', () => {
    const missing = formatToolError(
      'airbrake_performance',
      zodError(performanceTool.inputSchema, { action: 'queries_stats', project_id: 1 }),
    );
    for (const field of ['route', 'time__gte', 'time__lt', 'period']) {
      expect(missing).toContain(`at ${field}`);
    }
    const traversal = formatToolError(
      'airbrake_request',
      zodError(requestTool.inputSchema, { method: 'GET', path: '/api/v4/%2e%2e/admin' }),
    );
    expect(traversal).toMatch(/path must not contain "\.\." traversal[\s\S]*→ at path/);
  });

  it('leaves non-validation errors untouched', () => {
    expect(formatToolError('t', new Error('AIRBRAKE_PROJECT_KEYS is missing'))).toBe(
      'AIRBRAKE_PROJECT_KEYS is missing',
    );
    expect(formatToolError('t', 'plain string')).toBe('plain string');
  });
});
