import { z } from 'zod';
import { PAGINATION_HINT, withPagination } from '../client/pagination.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
import type { ToolDefinition } from './types.js';

// ---- get_stats time bounds -------------------------------------------------
// Airbrake's "Show group statistics" docs show `time__gte` as Unix seconds
// (e.g. 1699485224), while this tool has always sent ISO 8601 strings (and
// its response's `time` array is ISO). Both are allowed and forwarded
// verbatim — values are converted to milliseconds only locally, to validate
// them and their order.

// 9999-12-31T23:59:59Z. Rejects present-day Unix *milliseconds* passed by
// mistake (anything from 1978 onwards in ms exceeds it).
const MAX_UNIX_SECONDS = 253_402_300_799;

// Calendar date, optionally followed by a time (`T`, `t` or space) with
// optional fraction and optional `Z` / `±HH:MM` / `±HHMM` offset.
const ISO_8601 =
  /^(\d{4})-(\d\d)-(\d\d)(?:[Tt ](\d\d):(\d\d)(?::(\d\d)(\.\d{1,9})?)?(?:[Zz]|([+-])(\d\d):?(\d\d))?)?$/;

/**
 * Epoch ms for an ISO 8601 string, or NaN if it is malformed or names an
 * impossible instant (Feb 30, 24:00, 23:59:60, +24:00). Parsed by hand rather
 * than with Date.parse so offset-less values are read as UTC regardless of
 * the host time zone.
 */
function isoToMs(value: string): number {
  const m = ISO_8601.exec(value);
  if (!m) return NaN;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '0', sign, oh = '0', om = '0'] = m;
  if (Number(oh) > 23 || Number(om) > 59) return NaN;
  const t = new Date(0);
  t.setUTCFullYear(Number(y), Number(mo) - 1, Number(d)); // no 0–99 → 19xx mapping
  t.setUTCHours(Number(h), Number(mi), Number(s), Number(frac) * 1000);
  // Out-of-range fields roll over silently, so require an exact round-trip.
  if (t.toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return NaN;
  const offsetMinutes = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  return t.getTime() - offsetMinutes * 60_000;
}

function unixSecondsToMs(seconds: number): number {
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_UNIX_SECONDS
    ? seconds * 1000
    : NaN;
}

/**
 * Epoch ms for a time bound, or NaN if it is not a valid one — so the
 * ordering check stays silent on bounds that already failed validation.
 * Digit-only strings are Unix seconds (some clients stringify every argument).
 */
function statsTimeToMs(value: number | string): number {
  if (typeof value === 'number') return unixSecondsToMs(value);
  return /^\d+$/.test(value) ? unixSecondsToMs(Number(value)) : isoToMs(value);
}

function statsTime(bound: string) {
  return z
    .union([
      z.number().int().min(0).max(MAX_UNIX_SECONDS, 'must be Unix seconds, not milliseconds'),
      z.string().refine((v) => !Number.isNaN(statsTimeToMs(v)), {
        message:
          'must be an ISO 8601 timestamp (e.g. 2026-05-17T00:00:00Z) or Unix seconds (not milliseconds)',
      }),
    ])
    .describe(
      `${bound}. Either Unix seconds as an integer (e.g. 1699485224, the format shown in Airbrake's docs; a digit-only string is read the same way) or an ISO 8601 string (e.g. 2026-05-17T00:00:00Z). Sent to Airbrake exactly as given.`,
    );
}

const groupRef = z.object({
  project_id: projectId,
  group_id: snowflakeId,
});

const inputSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('list'),
        project_id: projectId,
        environment: z.string().optional(),
        resolved: z.boolean().optional(),
        muted: z.boolean().optional(),
        archived: z.boolean().optional(),
        deploy_id: snowflakeId.optional(),
        start_time: z.string().optional().describe('ISO 8601 timestamp lower bound'),
        end_time: z.string().optional().describe('ISO 8601 timestamp upper bound'),
        order: z
          .enum(['last_notice', 'notice_count', 'weight', 'created'])
          .optional()
          .describe('Sort order for the result set'),
        query: z.string().optional(),
      })
      .extend(pageSchema.shape),
    z.object({ action: z.literal('get') }).extend(groupRef.shape),
    z
      .object({
        action: z.literal('get_stats'),
        time__gte: statsTime('Inclusive lower bound (required for get_stats)'),
        time__lt: statsTime(
          'Exclusive upper bound (optional; omit to let Airbrake default to the current time)',
        ).optional(),
        period: z
          .enum(['minute', 'hour', 'day'])
          .describe(
            "Bucket granularity (required for get_stats). Airbrake's docs list `minute` and `hour`; `day` is not in the public docs and is kept for backward compatibility (use `hour` if your instance rejects it).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Maximum number of buckets to return (optional; Airbrake defaults to 100)'),
      })
      .extend(groupRef.shape),
    z.object({ action: z.literal('resolve') }).extend(groupRef.shape),
    z.object({ action: z.literal('unresolve') }).extend(groupRef.shape),
    z.object({ action: z.literal('mute') }).extend(groupRef.shape),
    z.object({ action: z.literal('unmute') }).extend(groupRef.shape),
    z.object({ action: z.literal('delete') }).extend(groupRef.shape),
  ])
  // Cross-field check on the whole union: discriminatedUnion branches must be
  // plain objects, so a per-branch refine is not possible.
  .superRefine((v, ctx) => {
    if (v.action !== 'get_stats' || v.time__lt === undefined) return;
    if (statsTimeToMs(v.time__gte) >= statsTimeToMs(v.time__lt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['time__lt'],
        message: `time__gte (${v.time__gte}) must be earlier than time__lt (${v.time__lt})`,
      });
    }
  });

export const groupsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_groups',
  description: `Airbrake error groups (issues). Actions: list with filters, get, mute, unmute, delete, get_stats (v5 time-series; requires time__gte and period, optional time__lt (defaults to now) and limit; times are Unix seconds or ISO 8601). resolve/unresolve follow the mute/unmute PUT convention but are not in the public docs — fall back to airbrake_request if they fail on your instance. group_id and deploy_id MUST be passed as strings (they are 19-digit snowflakes that lose precision as JS numbers). ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed.`,
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const query: Record<string, string | number | boolean | undefined> = {
          page: parsed.page,
          per_page: parsed.per_page,
          environment: parsed.environment,
          query: parsed.query,
          start_time: parsed.start_time,
          end_time: parsed.end_time,
          order: parsed.order,
        };
        if (parsed.deploy_id !== undefined) query.deploy_id = parsed.deploy_id;
        if (parsed.resolved !== undefined) query.resolved = parsed.resolved;
        if (parsed.muted !== undefined) query.muted = parsed.muted;
        if (parsed.archived !== undefined) query.archived = parsed.archived;
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/groups`,
          { query },
        )) as Record<string, unknown>;
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}`,
        );
      case 'get_stats':
        // Omitted time__lt / limit stay undefined and are dropped by the
        // client's query builder, so Airbrake applies its own defaults.
        return ctx.client.request(
          'GET',
          `/api/v5/projects/${parsed.project_id}/groups/${parsed.group_id}/stats`,
          {
            query: {
              time__gte: parsed.time__gte,
              time__lt: parsed.time__lt,
              period: parsed.period,
              limit: parsed.limit,
            },
          },
        );
      case 'mute':
        return ctx.client.request(
          'PUT',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/muted`,
        );
      case 'unmute':
        return ctx.client.request(
          'PUT',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/unmuted`,
        );
      case 'resolve':
        return ctx.client.request(
          'PUT',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/resolved`,
        );
      case 'unresolve':
        return ctx.client.request(
          'PUT',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/unresolved`,
        );
      case 'delete':
        return ctx.client.request(
          'DELETE',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}`,
        );
    }
  },
};
