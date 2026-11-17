import { z } from 'zod';
import { projectId, snowflakeId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const groupRef = z.object({
  project_id: projectId,
  group_id: snowflakeId,
});

// Each action PUTs to a state sub-resource of the group. These are state
// toggles — repeating one leaves the group in the same state — hence
// idempotent and non-destructive.
const STATE_PATHS = {
  mute: 'muted',
  unmute: 'unmuted',
  resolve: 'resolved',
  unresolve: 'unresolved',
} as const;

type StateAction = keyof typeof STATE_PATHS;

const inputSchema = groupRef.extend({
  action: z
    .enum(Object.keys(STATE_PATHS) as [StateAction, ...StateAction[]])
    .describe('State change to apply to the group'),
});

export const groupsUpdateTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_groups_update',
  title: 'Update Airbrake error group state',
  description:
    'Change the state of an Airbrake error group: mute, unmute, resolve, unresolve (PUT, no body). resolve/unresolve follow the mute/unmute PUT convention but are not in the public docs — fall back to airbrake_request if they fail on your instance. group_id MUST be passed as a string (19-digit snowflake). Disabled when AIRBRAKE_READ_ONLY is set. Returns the raw Airbrake JSON payload — no data is removed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    return ctx.client.request(
      'PUT',
      `/api/v4/projects/${parsed.project_id}/groups/${parsed.group_id}/${STATE_PATHS[parsed.action]}`,
    );
  },
};
