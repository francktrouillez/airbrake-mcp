import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toMcpInputSchema } from '../src/server.js';

describe('toMcpInputSchema discriminated-union flattening', () => {
  it('folds a non-`action` discriminator into an enum', () => {
    const schema = z.discriminatedUnion('resource', [
      z.object({ resource: z.literal('a'), a_id: z.string() }),
      z.object({ resource: z.literal('b'), b_id: z.string() }),
      z.object({ resource: z.literal('c'), b_id: z.string() }),
    ]);
    const json = toMcpInputSchema(schema);
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.resource).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
    expect(json.required).toEqual(['resource']);
    expect(json.anyOf).toBeUndefined();
  });

  it('still finds the discriminator when the union is wrapped (ZodEffects)', () => {
    const schema = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('list') }),
        z.object({ action: z.literal('get'), id: z.string() }),
      ])
      .superRefine(() => undefined);
    const props = toMcpInputSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(props.action?.enum).toEqual(['list', 'get']);
  });

  it('only merges the discriminator, not other per-branch literals', () => {
    const schema = z.discriminatedUnion('action', [
      z.object({ action: z.literal('x'), period: z.literal('day') }),
      z.object({ action: z.literal('y'), period: z.literal('hour') }),
    ]);
    const props = toMcpInputSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(props.action?.enum).toEqual(['x', 'y']);
    // First-seen schema kept as-is; no loose cross-branch enum invented.
    expect(props.period).toEqual({ type: 'string', const: 'day' });
  });
});
