export interface PaginationInput {
  page: number;
  perPage: number;
}

/**
 * Pagination metadata attached to list results as `_pagination`.
 *
 * `page` and `per_page` are unchanged from earlier releases; `count` is passed
 * through when Airbrake returned a finite, non-negative number. The remaining
 * fields tell the model whether to fetch another page without doing arithmetic:
 * - `has_more` / `next_page` (`next_page` only when `has_more` is true). With
 *   `count`, `has_more` compares the items actually served so far
 *   (`(page - 1) * per_page + list.length`) against it.
 * - `total_pages` when `count` is present (assumes `per_page` was honoured).
 * - `has_more_is_estimate: true` when `count` was absent and `has_more` was
 *   inferred from the length of the primary list (a full page ⇒ maybe more).
 * When neither `count` nor a list is available, `has_more` is omitted.
 */
export interface PaginationMeta {
  page: number;
  per_page: number;
  count?: number;
  has_more?: boolean;
  next_page?: number;
  total_pages?: number;
  has_more_is_estimate?: true;
}

/** One phrase appended to the description of every tool with a list action. */
export const PAGINATION_HINT = 'List results include `_pagination.has_more`/`next_page`.';

type PageInfo = Omit<PaginationMeta, 'page' | 'per_page'>;

/** First top-level array property of the payload, ignoring `_pagination`. */
function primaryList(payload: Record<string, unknown>): readonly unknown[] | undefined {
  for (const [key, value] of Object.entries(payload)) {
    if (key !== '_pagination' && Array.isArray(value)) return value;
  }
  return undefined;
}

/** Airbrake's `count`, if it is a usable total (finite and non-negative). */
function totalCount(payload: Record<string, unknown>): number | undefined {
  const { count } = payload;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : undefined;
}

function nextPage(hasMore: boolean, page: number): Pick<PaginationMeta, 'has_more' | 'next_page'> {
  return hasMore ? { has_more: true, next_page: page + 1 } : { has_more: false };
}

function pageInfo(payload: Record<string, unknown>, { page, perPage }: PaginationInput): PageInfo {
  const count = totalCount(payload);
  const list = primaryList(payload);
  if (count !== undefined) {
    // Count items actually served, not requested: if Airbrake capped per_page,
    // a short page still reports more rather than silently skipping the rest.
    const served = (page - 1) * perPage + (list ? list.length : perPage);
    return {
      count,
      ...nextPage(served < count, page),
      total_pages: Math.ceil(count / perPage),
    };
  }
  if (!list) return {};
  return { ...nextPage(list.length >= perPage, page), has_more_is_estimate: true };
}

export function withPagination<T extends Record<string, unknown>>(
  payload: T,
  input: PaginationInput | null,
): T & { _pagination?: PaginationMeta } {
  // The client returns null for 204 / empty bodies: nothing to annotate.
  if (!input || payload === null || typeof payload !== 'object') return payload;
  const meta: PaginationMeta = {
    page: input.page,
    per_page: input.perPage,
    ...pageInfo(payload, input),
  };
  return { ...payload, _pagination: meta };
}
