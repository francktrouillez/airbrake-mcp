import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { pageSchema, projectId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), fields: fieldsSchema }).extend(pageSchema.shape),
  z.object({ action: z.literal('get'), project_id: projectId }),
  z
    .object({ action: z.literal('list_activities'), fields: fieldsSchema, project_id: projectId })
    .extend(pageSchema.shape),
]);

export const projectsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_projects',
  description: `Airbrake projects: list, get, list_activities (audit log). Project updates are intentionally NOT modeled here — the /api/v4/projects/:id update endpoint requires dashboard-session credentials, not Personal API tokens, and returns 401 for all tokens our MCP supports. Use the Airbrake dashboard to change project settings. ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list/list_activities is given \`fields\` (keeps only those top-level keys per item).`,
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request('GET', '/api/v4/projects', {
          query: { page: parsed.page, per_page: parsed.per_page },
        })) as Record<string, unknown>;
        return listResult(payload, parsed);
      }
      case 'get':
        return ctx.client.request('GET', `/api/v4/projects/${parsed.project_id}`);
      case 'list_activities': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/activities`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return listResult(payload, parsed);
      }
    }
  },
};
