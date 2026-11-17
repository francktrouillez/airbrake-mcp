import { z } from 'zod';
import { projectId, snowflakeId } from './schemas.js';
import type { ToolDefinition } from './types.js';

// Discriminated on `resource` so each branch can require its own ID. The
// branches are strict objects: on a destructive verb an extra, ignored ID
// (e.g. group_id on a sourcemap delete) most likely means the caller is
// confused about what they are deleting, so refuse rather than guess.
const inputSchema = z.discriminatedUnion('resource', [
  z.strictObject({
    resource: z.literal('group'),
    project_id: projectId,
    group_id: snowflakeId.describe('Required when resource is "group"; omit otherwise'),
  }),
  z.strictObject({
    resource: z.literal('sourcemap'),
    project_id: projectId,
    sourcemap_id: snowflakeId.describe('Required when resource is "sourcemap"; omit otherwise'),
  }),
]);

export const deleteTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_delete',
  title: 'Delete an Airbrake error group or source map',
  description:
    'Permanently delete an Airbrake resource. resource "group" requires group_id (deletes the error group and its notices); resource "sourcemap" requires sourcemap_id. Pass only the ID for the chosen resource — omit the other one (it is rejected, not ignored). IDs MUST be passed as strings (19-digit snowflakes). Irreversible. Disabled when AIRBRAKE_READ_ONLY is set. Returns the raw Airbrake JSON payload (usually null for 204).',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // Deleting an already-deleted resource has no further effect.
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.resource) {
      case 'group':
        return ctx.client.request(
          'DELETE',
          `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}`,
        );
      case 'sourcemap':
        return ctx.client.request(
          'DELETE',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
    }
  },
};
