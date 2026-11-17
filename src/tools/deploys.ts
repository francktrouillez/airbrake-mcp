import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
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
  z.object({
    action: z.literal('create'),
    project_id: projectId,
    deploy: z.record(z.string(), z.unknown()),
  }),
]);

export const deploysTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_deploys',
  description: `Airbrake deploys: list, get, or create a deploy marker. deploy_id MUST be passed as a string (19-digit snowflake). ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list is given \`fields\` (keeps only those top-level keys per item).`,
  inputSchema,
  handler: async (ctx, input) => {
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
      case 'create':
        // Airbrake's POST /deploys expects the deploy fields at the TOP LEVEL
        // of the body (not nested under a `deploy` key). Wrapping creates a
        // deploy with empty fields silently — confirmed against live API.
        return ctx.client.request('POST', `/api/v4/projects/${parsed.project_id}/deploys`, {
          body: parsed.deploy,
        });
    }
  },
};
