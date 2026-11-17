import { describe, it, expect } from 'vitest';
import { fieldsSchema, listResult, projectFields } from '../../src/tools/fields.js';

describe('projectFields', () => {
  it('returns the payload unchanged (same reference) when fields is undefined', () => {
    const payload = { groups: [{ id: '1', errors: [], context: {} }], count: 1 };
    expect(projectFields(payload, undefined)).toBe(payload);
  });

  it('reduces every item of every top-level array-of-objects to the given keys', () => {
    const payload = {
      groups: [
        { id: '1', errors: ['e1'], context: { env: 'prod' }, noticeCount: 3 },
        { id: '2', errors: ['e2'], context: { env: 'dev' }, noticeCount: 4 },
      ],
      deploys: [{ id: 'd1', revision: 'abc', errors: 'x' }],
    };
    expect(projectFields(payload, ['id', 'errors'])).toEqual({
      groups: [
        { id: '1', errors: ['e1'] },
        { id: '2', errors: ['e2'] },
      ],
      deploys: [{ id: 'd1', errors: 'x' }],
    });
  });

  it('keeps non-array top-level properties untouched', () => {
    const meta = { nested: { deep: true } };
    const payload = { notices: [{ id: '1', backtrace: [] }], count: 7, page: 1, meta };
    const result = projectFields(payload, ['id']);
    expect(result.count).toBe(7);
    expect(result.page).toBe(1);
    expect(result.meta).toBe(meta);
    expect(result.notices).toEqual([{ id: '1' }]);
  });

  it('leaves non-object array items as-is', () => {
    const payload = { mixed: [1, 'two', null, ['nested'], { id: 'x', drop: true }], tags: ['a'] };
    expect(projectFields(payload, ['id'])).toEqual({
      mixed: [1, 'two', null, ['nested'], { id: 'x' }],
      tags: ['a'],
    });
  });

  it('omits unknown fields rather than adding undefined keys', () => {
    const result = projectFields({ projects: [{ id: 1, name: 'p' }] }, ['id', 'nope']);
    expect(result.projects).toEqual([{ id: 1 }]);
    expect(Object.keys((result.projects as object[])[0]!)).toEqual(['id']);
  });

  it('keeps keys whose value is null/undefined/falsy when requested', () => {
    const result = projectFields({ groups: [{ id: '1', resolved: false, muted: null }] }, [
      'resolved',
      'muted',
    ]);
    expect(result.groups).toEqual([{ resolved: false, muted: null }]);
  });

  it('does not mutate the input payload or its items', () => {
    const item = { id: '1', errors: ['e'], context: { a: 1 } };
    const payload = { groups: [item], count: 1 };
    const snapshot = structuredClone(payload);
    const result = projectFields(payload, ['id']);
    expect(payload).toEqual(snapshot);
    expect(payload.groups[0]).toBe(item);
    expect(result).not.toBe(payload);
    expect(result.groups).not.toBe(payload.groups);
  });

  it('does not pick up inherited properties', () => {
    const item = Object.create({ inherited: 'x' }) as Record<string, unknown>;
    item.id = '1';
    expect(projectFields({ groups: [item] }, ['id', 'inherited']).groups).toEqual([{ id: '1' }]);
  });

  it('treats a __proto__ field name as plain data (no prototype change)', () => {
    const payload = JSON.parse('{"groups":[{"id":"1","__proto__":{"polluted":true}}]}') as Record<
      string,
      unknown
    >;
    const [item] = projectFields(payload, ['id', '__proto__']).groups as Record<string, unknown>[];
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(item, '__proto__')).toBe(true);
    expect((item as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('returns a non-object payload as-is', () => {
    expect(projectFields(null as unknown as Record<string, unknown>, ['id'])).toBeNull();
  });
});

describe('listResult', () => {
  it('projects first, then attaches _pagination (count survives)', () => {
    const payload = { groups: [{ id: '1', errors: [], context: {} }], count: 12 };
    const result = listResult(payload, { page: 2, per_page: 10, fields: ['id'] });
    expect(result.groups).toEqual([{ id: '1' }]);
    expect(result.count).toBe(12);
    expect(result._pagination).toMatchObject({ page: 2, per_page: 10, count: 12 });
    expect(payload.groups[0]).toEqual({ id: '1', errors: [], context: {} });
  });

  it('keeps the raw payload when fields is omitted', () => {
    const payload = { groups: [{ id: '1', errors: [] }] };
    const result = listResult(payload, { page: 1, per_page: 50 });
    expect(result.groups).toBe(payload.groups);
    expect(result._pagination).toMatchObject({ page: 1, per_page: 50 });
  });
});

describe('fieldsSchema', () => {
  it.each([
    ['empty array', []],
    ['empty string', ['']],
    ['more than 50', Array.from({ length: 51 }, (_, i) => `f${i}`)],
    ['non-string', [1]],
    ['not an array', 'id'],
  ])('rejects %s', (_label, fields) => {
    expect(fieldsSchema.safeParse(fields).success).toBe(false);
  });

  it('accepts undefined, one key, and exactly 50 keys', () => {
    expect(fieldsSchema.safeParse(undefined).success).toBe(true);
    expect(fieldsSchema.safeParse(['id']).success).toBe(true);
    expect(fieldsSchema.safeParse(Array.from({ length: 50 }, (_, i) => `f${i}`)).success).toBe(
      true,
    );
  });
});
