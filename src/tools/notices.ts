import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { noticeUuid, pageSchema, projectId, snowflakeId } from './schemas.js';
import { READ_ONLY_HINTS } from './read-only.js';
import type { ToolDefinition } from './types.js';

// Notices carry full backtraces/context/params, so a smaller default keeps a
// single call from flooding the model's context. Bounds (max 200) stay shared.
const noticesPage = {
  ...pageSchema.shape,
  per_page: pageSchema.shape.per_page.unwrap().default(10),
};

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      fields: fieldsSchema,
      project_id: projectId,
      group_id: snowflakeId,
      version: z.string().optional().describe('Filter notices by deploy/app version'),
    })
    .extend(noticesPage),
  z.object({
    action: z.literal('get'),
    project_id: projectId,
    group_id: snowflakeId,
    notice_id: snowflakeId,
  }),
  z.object({
    action: z.literal('get_status'),
    project_id: projectId,
    notice_uuid: noticeUuid.describe('UUID returned when the notice was first reported'),
  }),
]);

export const noticesTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_notices',
  title: 'Read Airbrake notices',
  description: `Airbrake notices (individual error occurrences). list and get_status are documented; get hits an undocumented dashboard endpoint that currently works on hosted Airbrake. group_id and notice_id MUST be passed as strings (19-digit snowflakes). ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list is given \`fields\` (keeps only those top-level keys per item).`,
  inputSchema,
  annotations: READ_ONLY_HINTS,
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
        return listResult(payload, parsed);
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
