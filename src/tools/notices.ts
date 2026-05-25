import { z } from 'zod';
import { withPagination } from '../client/pagination.js';
import type { ToolDefinition } from './types.js';

const pageSchema = z.object({
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
});

// Group/notice IDs are 19-digit snowflakes — must be strings (see groups.ts).
const snowflakeId = z.string().min(1);

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      project_id: z.number().int().positive(),
      group_id: snowflakeId,
      version: z.string().optional().describe('Filter notices by deploy/app version'),
    })
    .merge(pageSchema),
  z.object({
    action: z.literal('get'),
    project_id: z.number().int().positive(),
    group_id: snowflakeId,
    notice_id: snowflakeId,
  }),
  z.object({
    action: z.literal('get_status'),
    project_id: z.number().int().positive(),
    notice_uuid: z.string().min(1).describe('UUID returned when the notice was first reported'),
  }),
]);

export const noticesTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_notices',
  description:
    'Airbrake notices (individual error occurrences). list and get_status are documented; get hits an undocumented dashboard endpoint that currently works on hosted Airbrake. group_id and notice_id MUST be passed as strings (19-digit snowflakes). Returns the raw Airbrake JSON payload — no data is removed.',
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const query: Record<string, string | number | boolean | undefined> = {
          page: parsed.page,
          per_page: parsed.per_page,
          version: parsed.version,
        };
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/notices`,
          { query },
        )) as Record<string, unknown>;
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/notices/${parsed.notice_id}`,
        );
      case 'get_status':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/notice-status/${parsed.notice_uuid}`,
        );
    }
  },
};
