import { describe, it, expect } from 'vitest';
import { withPagination } from '../../src/client/pagination.js';

describe('withPagination', () => {
  it('attaches _pagination based on input page/per_page', () => {
    const result = withPagination({ projects: [{ id: 1 }] }, { page: 2, perPage: 50 });
    expect(result.projects).toEqual([{ id: 1 }]);
    expect(result._pagination).toEqual({ page: 2, per_page: 50 });
  });

  it('passes through total/count if Airbrake returned it', () => {
    const result = withPagination({ projects: [], count: 0 }, { page: 1, perPage: 50 });
    expect(result._pagination).toEqual({ page: 1, per_page: 50, count: 0 });
  });

  it('returns payload unchanged when not paginating', () => {
    const result = withPagination({ project: { id: 1 } }, null);
    expect(result).toEqual({ project: { id: 1 } });
    expect((result as Record<string, unknown>)._pagination).toBeUndefined();
  });
});
