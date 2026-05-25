import { z } from 'zod';
import { withPagination } from '../client/pagination.js';
import type { ToolDefinition } from './types.js';

const pageSchema = z.object({
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
});

// Airbrake group/deploy IDs are 19-digit snowflakes that exceed
// Number.MAX_SAFE_INTEGER. They MUST be passed as strings — the JSON
// number representation loses precision (the last 3-5 digits get rounded
// to zero) and the lookup 404s. We accept only string here so the LLM
// is forced to quote the value in its tool call.
const snowflakeId = z.string().min(1);

const groupRef = z.object({
  project_id: z.number().int().positive(),
  group_id: snowflakeId,
});

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      project_id: z.number().int().positive(),
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
    .merge(pageSchema),
  z.object({ action: z.literal('get') }).merge(groupRef),
  z
    .object({
      action: z.literal('get_stats'),
      time__gte: z.string().describe('ISO 8601 timestamp lower bound (required)'),
      time__lt: z.string().describe('ISO 8601 timestamp upper bound (required)'),
      period: z.enum(['minute', 'hour', 'day']).describe('Bucket granularity (required)'),
    })
    .merge(groupRef),
  z.object({ action: z.literal('resolve') }).merge(groupRef),
  z.object({ action: z.literal('unresolve') }).merge(groupRef),
  z.object({ action: z.literal('mute') }).merge(groupRef),
  z.object({ action: z.literal('unmute') }).merge(groupRef),
  z.object({ action: z.literal('delete') }).merge(groupRef),
]);

export const groupsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_groups',
  description:
    'Airbrake error groups (issues). Actions: list with filters, get, mute, unmute, delete, get_stats (v5 time-series; requires time__gte/time__lt/period). resolve/unresolve follow the mute/unmute PUT convention but are not in the public docs — fall back to airbrake_request if they fail on your instance. group_id and deploy_id MUST be passed as strings (they are 19-digit snowflakes that lose precision as JS numbers). Returns the raw Airbrake JSON payload — no data is removed.',
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
        return ctx.client.request(
          'GET',
          `/api/v5/projects/${parsed.project_id}/groups/${parsed.group_id}/stats`,
          {
            query: {
              time__gte: parsed.time__gte,
              time__lt: parsed.time__lt,
              period: parsed.period,
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
