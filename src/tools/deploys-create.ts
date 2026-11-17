import { z } from 'zod';
import { projectId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  project_id: projectId,
  deploy: z
    .record(z.string(), z.unknown())
    .describe(
      'Deploy fields, e.g. { environment, username, repository, revision, version }. Sent as the top-level POST body.',
    ),
});

export const deploysCreateTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_deploys_create',
  title: 'Create an Airbrake deploy marker',
  description:
    'Create an Airbrake deploy marker for a project. Each call creates a new deploy (not idempotent). Disabled when AIRBRAKE_READ_ONLY is set. Returns the raw Airbrake JSON payload — no data is removed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    // Airbrake's POST /deploys expects the deploy fields at the TOP LEVEL
    // of the body (not nested under a `deploy` key). Wrapping creates a
    // deploy with empty fields silently — confirmed against live API.
    return ctx.client.request('POST', `/api/v4/projects/${parsed.project_id}/deploys`, {
      body: parsed.deploy,
    });
  },
};
