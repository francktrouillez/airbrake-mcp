export interface PaginationInput {
  page: number;
  perPage: number;
}

export interface PaginationMeta {
  page: number;
  per_page: number;
  count?: number;
}

export function withPagination<T extends Record<string, unknown>>(
  payload: T,
  input: PaginationInput | null,
): T & { _pagination?: PaginationMeta } {
  if (!input) return payload;
  const meta: PaginationMeta = { page: input.page, per_page: input.perPage };
  if (typeof payload.count === 'number') meta.count = payload.count;
  return { ...payload, _pagination: meta };
}
