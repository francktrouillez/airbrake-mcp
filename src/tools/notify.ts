import { z } from 'zod';
import { AirbrakeConfigError } from '../client/errors.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('notify'),
    project_id: z.number().int().positive(),
    payload: z.object({ errors: z.array(z.record(z.unknown())) }).passthrough(),
  }),
]);

export const notifyTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_notify',
  description:
    'Send a notice (error report) TO Airbrake via the Notifier API. Requires AIRBRAKE_PROJECT_KEYS[project_id] to be set. Returns the raw Airbrake JSON payload — no data is removed.',
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
