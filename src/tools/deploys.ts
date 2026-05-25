import { z } from 'zod';
import { withPagination } from '../client/pagination.js';
import type { ToolDefinition } from './types.js';

const pageSchema = z.object({
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(200).default(50),
});

// Deploy IDs are 19-digit snowflakes — must be strings (see groups.ts).
// Digits-only regex prevents path traversal via URL-normalized `..` segments.
const snowflakeId = z.string().regex(/^\d+$/, 'must be a numeric snowflake ID (digits only)');

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('list'), project_id: z.number().int().positive() })
    .merge(pageSchema),
  z.object({
    action: z.literal('get'),
    project_id: z.number().int().positive(),
    deploy_id: snowflakeId,
  }),
  z.object({
    action: z.literal('create'),
    project_id: z.number().int().positive(),
    deploy: z.record(z.unknown()),
  }),
]);

export const deploysTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_deploys',
  description:
    'Airbrake deploys: list, get, or create a deploy marker. deploy_id MUST be passed as a string (19-digit snowflake). Returns the raw Airbrake JSON payload — no data is removed.',
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
        return withPagination(payload, { page: parsed.page, perPage: parsed.per_page });
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
