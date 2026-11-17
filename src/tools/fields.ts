// `fields` projection for list actions. Airbrake list items (notably notices,
// with full backtraces/context/params) are large; `fields` lets a caller keep
// only the top-level keys it needs. Pure and immutable: the input payload and
// its items are never modified.

import { z } from 'zod';
import { withPagination, type PaginationMeta } from '../client/pagination.js';

const MAX_FIELDS = 50;

type JsonRecord = Record<string, unknown>;

/** Optional `fields` projection accepted by every list-type action. */
export const fieldsSchema = z
  .array(z.string().min(1, 'field names must be non-empty'))
  .min(1, 'fields must list at least one key (omit it for the full payload)')
  .max(MAX_FIELDS, `fields accepts at most ${MAX_FIELDS} keys`)
  .optional()
  .describe(
    'List actions only: keep just these top-level keys (exact names as Airbrake returns them, e.g. ["id","createdAt"]) on each listed item. Omit for the full payload.',
  );

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Object.fromEntries defines own data properties, so a field named
// `__proto__` is copied as data instead of re-pointing the prototype.
function pickKeys(item: JsonRecord, fields: readonly string[]): JsonRecord {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(item, field))
      .map((field) => [field, item[field]]),
  );
}

/**
 * Reduce each object inside every top-level array of `payload` to the given
 * top-level keys (missing keys are omitted). Non-array properties such as
 * `count` are kept as-is. Without `fields` the payload is returned unchanged.
 */
export function projectFields(
  payload: JsonRecord,
  fields: readonly string[] | undefined,
): JsonRecord {
  // Guard: payloads arrive as `unknown` cast to a record, so null is possible.
  if (fields === undefined || !isPlainObject(payload)) return payload;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) => (isPlainObject(item) ? pickKeys(item, fields) : item))
        : value,
    ]),
  );
}

export interface ListParams {
  page: number;
  per_page: number;
  fields?: readonly string[] | undefined;
}

/** Shared list post-processing: project `fields`, then attach `_pagination`. */
export function listResult(
  payload: JsonRecord,
  params: ListParams,
): JsonRecord & { _pagination?: PaginationMeta } {
  return withPagination(projectFields(payload, params.fields), {
    page: params.page,
    perPage: params.per_page,
  });
}
