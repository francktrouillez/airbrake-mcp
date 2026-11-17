import { z } from 'zod';
import { withPagination } from '../client/pagination.js';
import { pageSchema, projectId, snowflakeId, statsTimeRange } from './schemas.js';
import type { ToolDefinition } from './types.js';

const groupRef = z.object({
  project_id: projectId,
  group_id: snowflakeId,
});

const inputSchema = z.discriminatedUnion('action', [
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
    .object({ action: z.literal('get_stats') })
    .extend(statsTimeRange.shape)
    .extend(groupRef.shape),
  z.object({ action: z.literal('resolve') }).extend(groupRef.shape),
  z.object({ action: z.literal('unresolve') }).extend(groupRef.shape),
  z.object({ action: z.literal('mute') }).extend(groupRef.shape),
  z.object({ action: z.literal('unmute') }).extend(groupRef.shape),
  z.object({ action: z.literal('delete') }).extend(groupRef.shape),
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
