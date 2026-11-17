import { describe, it, expect } from 'vitest';
import { withPagination } from '../../src/client/pagination.js';

const items = (n: number): Array<{ id: number }> =>
  Array.from({ length: n }, (_, i) => ({ id: i }));

describe('withPagination', () => {
  it('attaches _pagination based on input page/per_page', () => {
    const result = withPagination({ projects: [{ id: 1 }] }, { page: 2, perPage: 50 });
    expect(result.projects).toEqual([{ id: 1 }]);
    expect(result._pagination).toEqual({
      page: 2,
      per_page: 50,
      has_more: false,
      has_more_is_estimate: true,
    });
  });

  it('passes through count and reports zero pages when count is 0', () => {
    const result = withPagination({ projects: [], count: 0 }, { page: 1, perPage: 50 });
    expect(result._pagination).toEqual({
      page: 1,
      per_page: 50,
      count: 0,
      has_more: false,
      total_pages: 0,
    });
  });

  it('returns payload unchanged when not paginating', () => {
    const result = withPagination({ project: { id: 1 } }, null);
    expect(result).toEqual({ project: { id: 1 } });
    expect((result as Record<string, unknown>)._pagination).toBeUndefined();
  });

  it('returns a null payload (204 / empty body) unchanged instead of throwing', () => {
    const payload = null as unknown as Record<string, unknown>;
    expect(withPagination(payload, { page: 1, perPage: 50 })).toBeNull();
  });

  describe('when count is present', () => {
    it('reports no more pages when count equals page * per_page exactly', () => {
      const result = withPagination({ groups: items(50), count: 100 }, { page: 2, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 2,
        per_page: 50,
        count: 100,
        has_more: false,
        total_pages: 2,
      });
    });

    it('reports more pages when count is one above page * per_page', () => {
      const result = withPagination({ groups: items(50), count: 101 }, { page: 2, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 2,
        per_page: 50,
        count: 101,
        has_more: true,
        next_page: 3,
        total_pages: 3,
      });
    });

    it('reports no more on the last partial page', () => {
      const result = withPagination({ groups: items(20), count: 120 }, { page: 3, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 3,
        per_page: 50,
        count: 120,
        has_more: false,
        total_pages: 3,
      });
    });

    it('reports no more for a page beyond the end', () => {
      const result = withPagination({ groups: [], count: 120 }, { page: 7, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 7,
        per_page: 50,
        count: 120,
        has_more: false,
        total_pages: 3,
      });
    });

    it('trusts count over the array length', () => {
      // A short page with a larger count still has more: count is authoritative.
      const result = withPagination({ groups: items(3), count: 500 }, { page: 1, perPage: 50 });
      expect(result._pagination).toMatchObject({ has_more: true, next_page: 2, total_pages: 10 });
      expect(result._pagination).not.toHaveProperty('has_more_is_estimate');
    });

    it('falls back to page * per_page < count when there is no array', () => {
      const more = withPagination({ count: 51 }, { page: 1, perPage: 50 });
      expect(more._pagination).toEqual({
        page: 1,
        per_page: 50,
        count: 51,
        has_more: true,
        next_page: 2,
        total_pages: 2,
      });
      const none = withPagination({ count: 50 }, { page: 1, perPage: 50 });
      expect(none._pagination).toMatchObject({ has_more: false });
    });

    describe('when Airbrake serves fewer items than per_page', () => {
      it('reports more on a capped page (per_page 50, 20 served, count 60)', () => {
        const result = withPagination({ groups: items(20), count: 60 }, { page: 1, perPage: 50 });
        expect(result._pagination).toEqual({
          page: 1,
          per_page: 50,
          count: 60,
          has_more: true,
          next_page: 2,
          total_pages: 2,
        });
      });

      it('reports no more when the served items reach count exactly', () => {
        // Page 2 of 50 serves the final 10 of 60: (2 - 1) * 50 + 10 === 60.
        const result = withPagination({ groups: items(10), count: 60 }, { page: 2, perPage: 50 });
        expect(result._pagination).toMatchObject({ has_more: false, total_pages: 2 });
        expect(result._pagination).not.toHaveProperty('next_page');
      });

      it('reports more on a short page that is one item short of count', () => {
        const result = withPagination({ groups: items(9), count: 60 }, { page: 2, perPage: 50 });
        expect(result._pagination).toMatchObject({ has_more: true, next_page: 3 });
      });

      it('reports no more on an empty page past the served items', () => {
        const result = withPagination({ groups: [], count: 60 }, { page: 3, perPage: 50 });
        expect(result._pagination).toEqual({
          page: 3,
          per_page: 50,
          count: 60,
          has_more: false,
          total_pages: 2,
        });
      });

      it('reports more on an empty first page when count says items exist', () => {
        // Errs towards one extra fetch rather than declaring the listing done.
        const result = withPagination({ groups: [], count: 5 }, { page: 1, perPage: 50 });
        expect(result._pagination).toMatchObject({ has_more: true, next_page: 2 });
      });
    });
  });

  describe('when count is absent', () => {
    it('estimates more pages when the primary list is full', () => {
      const result = withPagination({ deploys: items(50) }, { page: 1, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 1,
        per_page: 50,
        has_more: true,
        next_page: 2,
        has_more_is_estimate: true,
      });
    });

    it('estimates no more pages when the primary list is short', () => {
      const result = withPagination({ deploys: items(49) }, { page: 4, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 4,
        per_page: 50,
        has_more: false,
        has_more_is_estimate: true,
      });
    });

    it('estimates no more pages for an empty list', () => {
      const result = withPagination({ notices: [] }, { page: 1, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 1,
        per_page: 50,
        has_more: false,
        has_more_is_estimate: true,
      });
    });

    it('uses the first top-level array, skipping non-array properties', () => {
      const result = withPagination(
        { meta: { x: 1 }, label: 'a', activities: items(10), other: items(99) },
        { page: 1, perPage: 10 },
      );
      expect(result._pagination).toMatchObject({ has_more: true, next_page: 2 });
    });

    it('ignores a pre-existing _pagination array when picking the primary list', () => {
      const result = withPagination(
        { _pagination: items(5), projects: items(2) } as Record<string, unknown>,
        { page: 1, perPage: 5 },
      );
      expect(result._pagination).toEqual({
        page: 1,
        per_page: 5,
        has_more: false,
        has_more_is_estimate: true,
      });
    });

    it('omits has_more/next_page entirely when no array is found', () => {
      const result = withPagination({ project: { id: 1 } }, { page: 1, perPage: 50 });
      expect(result._pagination).toEqual({ page: 1, per_page: 50 });
    });

    it.each([
      ['string', '120'],
      ['null', null],
      ['Infinity (JSON.parse of 1e999)', Infinity],
      ['NaN', NaN],
      ['negative', -5],
    ])('treats a %s count as absent and uses the list heuristic', (_label, count) => {
      const result = withPagination({ groups: items(50), count }, { page: 1, perPage: 50 });
      expect(result._pagination).toEqual({
        page: 1,
        per_page: 50,
        has_more: true,
        next_page: 2,
        has_more_is_estimate: true,
      });
    });
  });

  it('does not mutate the input payload', () => {
    const list = items(50);
    const payload = { groups: list, count: 120 };
    const snapshot = structuredClone(payload);
    const result = withPagination(payload, { page: 1, perPage: 50 });
    expect(payload).toEqual(snapshot);
    expect(payload).not.toHaveProperty('_pagination');
    expect(result).not.toBe(payload);
    expect(result.groups).toBe(list);
  });
});
