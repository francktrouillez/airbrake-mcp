import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { assertNotMovedAction } from './moved-actions.js';
import { READ_ONLY_HINTS } from './read-only.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('list'), fields: fieldsSchema, project_id: projectId })
    .extend(pageSchema.shape),
  z.object({
    action: z.literal('get'),
    project_id: projectId,
    sourcemap_id: snowflakeId,
  }),
]);

const MOVED_ACTIONS = {
  delete: 'airbrake_delete with resource "sourcemap"',
  upload: 'airbrake_sourcemaps_upload',
};

export const sourcemapsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_sourcemaps',
  title: 'Read Airbrake source maps',
  description: `Read Airbrake source maps: list, get. Read-only — to upload a local source map use airbrake_sourcemaps_upload; to delete use airbrake_delete with resource "sourcemap". sourcemap_id MUST be passed as a string. ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list is given \`fields\` (keeps only those top-level keys per item).`,
  annotations: READ_ONLY_HINTS,
  inputSchema,
  handler: async (ctx, input) => {
    assertNotMovedAction('airbrake_sourcemaps', input, MOVED_ACTIONS, ctx.config.readOnly);
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return listResult(payload, parsed);
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
    }
  },
};
