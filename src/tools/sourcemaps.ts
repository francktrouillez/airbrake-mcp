import { z } from 'zod';
import { PAGINATION_HINT, withPagination } from '../client/pagination.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), project_id: projectId }).extend(pageSchema.shape),
  z.object({
    action: z.literal('get'),
    project_id: projectId,
    sourcemap_id: snowflakeId,
  }),
  z.object({
    action: z.literal('delete'),
    project_id: projectId,
    sourcemap_id: snowflakeId,
  }),
]);

export const sourcemapsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_sourcemaps',
  description: `Airbrake source maps: list, get, delete. sourcemap_id MUST be passed as a string. Upload (POST) is multipart/form-data and not modeled here; use airbrake_request with a pre-formed multipart body and matching Content-Type. ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed.`,
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
      case 'delete':
        return ctx.client.request(
          'DELETE',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
    }
  },
};
