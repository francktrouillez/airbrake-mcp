import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
import { assertNotMovedAction } from './moved-actions.js';
import { READ_ONLY_HINTS } from './read-only.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('list'), fields: fieldsSchema, project_id: projectId })
    .extend(pageSchema.shape),
  z.object({
    action: z.literal('get'),
    project_id: projectId,
    deploy_id: snowflakeId,
  }),
]);

const MOVED_ACTIONS = {
  create: 'airbrake_deploys_create',
};

export const deploysTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_deploys',
  title: 'Read Airbrake deploys',
  description: `Read Airbrake deploys: list, get. Read-only — to create a deploy marker use airbrake_deploys_create. deploy_id MUST be passed as a string (19-digit snowflake). ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list is given \`fields\` (keeps only those top-level keys per item).`,
  annotations: READ_ONLY_HINTS,
  inputSchema,
  handler: async (ctx, input) => {
    assertNotMovedAction('airbrake_deploys', input, MOVED_ACTIONS, ctx.config.readOnly);
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/deploys`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return listResult(payload, parsed);
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/deploys/${parsed.deploy_id}`,
        );
    }
  },
};
