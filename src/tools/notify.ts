import { z } from 'zod';
import { AirbrakeConfigError } from '../client/errors.js';
import { projectId } from './schemas.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('notify'),
    project_id: projectId,
    payload: z.looseObject({ errors: z.array(z.record(z.string(), z.unknown())) }),
  }),
]);

export const notifyTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_notify',
  title: 'Send a notice to Airbrake (Notifier API)',
  description:
    'Send a notice (error report) TO Airbrake via the Notifier API. Requires AIRBRAKE_PROJECT_KEYS[project_id] to be set. Disabled when AIRBRAKE_READ_ONLY is set. Returns the raw Airbrake JSON payload — no data is removed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    // Every call records a new notice occurrence.
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    const key = ctx.config.projectKeys[String(parsed.project_id)];
    if (!key) {
      throw new AirbrakeConfigError(
        `AIRBRAKE_PROJECT_KEYS is missing an entry for project ${parsed.project_id}. Set AIRBRAKE_PROJECT_KEYS='{"${parsed.project_id}":"<notifier_key>"}'.`,
      );
    }
    return ctx.client.request('POST', `/api/v3/projects/${parsed.project_id}/notices`, {
      query: { key },
      body: parsed.payload,
      auth: 'none',
    });
  },
};
