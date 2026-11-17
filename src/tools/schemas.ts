// Shared zod building blocks for tool input schemas. Reusing one instance
// across fields/tools is safe because zod schemas are immutable AND because
// toMcpInputSchema (src/server.ts) uses `$refStrategy: 'none'` — with the
// default strategy, repeated instances would be emitted as `$ref`s. These
// shapes are part of the public `tools/list` surface (see
// test/e2e/tool-schemas.e2e.test.ts and test/tools/schemas.test.ts).

import { z } from 'zod';

/** Airbrake project IDs: positive integers, passed as JSON numbers. */
export const projectId = z.number().int().positive();

/**
 * Airbrake group/notice/deploy IDs are 19-digit snowflakes (sourcemap IDs
 * may be too) that exceed Number.MAX_SAFE_INTEGER. They MUST be passed as
 * strings — the JSON number representation loses precision (the last 3-5
 * digits get rounded to zero) and the lookup 404s. The /^\d+$/ regex also
 * blocks path traversal: these IDs are interpolated raw into URL paths and
 * fetch normalizes `..` segments, so an unconstrained string would let a
 * jailbroken LLM redirect destructive verbs to arbitrary URL paths.
 */
export const snowflakeId = z
  .string()
  .regex(/^\d+$/, 'must be a numeric snowflake ID (digits only)');

/**
 * Notice UUIDs returned by Airbrake are alphanumerics + hyphens; restrict
 * to that shape so `..` / `/` cannot escape the path segment (same
 * raw-interpolation risk as snowflakeId above).
 */
export const noticeUuid = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, 'must contain only alphanumerics and hyphens');

/** Pagination params for list endpoints, merged into each list action. */
export const pageSchema = z.object({
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
});

/** Required v5 time-series window, shared by group stats and APM stats. */
export const statsTimeRange = z.object({
  time__gte: z.string().describe('ISO 8601 timestamp lower bound (required)'),
  time__lt: z.string().describe('ISO 8601 timestamp upper bound (required)'),
  period: z.enum(['minute', 'hour', 'day']).describe('Bucket granularity (required)'),
});
