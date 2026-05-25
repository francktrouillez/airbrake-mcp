import { z } from 'zod';
import { withPagination } from '../client/pagination.js';
import type { ToolDefinition } from './types.js';

const pageSchema = z.object({
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
});

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).merge(pageSchema),
  z.object({ action: z.literal('get'), project_id: z.number().int().positive() }),
  z
    .object({ action: z.literal('list_activities'), project_id: z.number().int().positive() })
    .merge(pageSchema),
]);

export const projectsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_projects',
  description:
    'Airbrake projects: list, get, list_activities (audit log). Project updates are intentionally NOT modeled here — the /api/v4/projects/:id update endpoint requires dashboard-session credentials, not Personal API tokens, and returns 401 for all tokens our MCP supports. Use the Airbrake dashboard to change project settings. Returns the raw Airbrake JSON payload — no data is removed.',
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request('GET', '/api/v4/projects', {
          query: { page: parsed.page, per_page: parsed.per_page },
        })) as Record<string, unknown>;
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
      }
      case 'get':
        return ctx.client.request('GET', `/api/v4/projects/${parsed.project_id}`);
      case 'list_activities': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/activities`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
      }
    }
  },
};
