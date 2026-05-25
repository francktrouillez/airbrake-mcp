import { z } from 'zod';
import type { RequestOptions } from '../client/airbrake.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z
    .string()
    .startsWith('/api/', 'path must start with /api/ (Airbrake API path)')
    .describe('Airbrake API path, e.g. /api/v4/projects/123/groups'),
  query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z
    .unknown()
    .optional()
    .describe(
      'Request body. Objects are JSON-serialized; strings are sent verbatim (use this for multipart/form-data or other non-JSON payloads — set the matching Content-Type in headers).',
    ),
  headers: z.record(z.string()).optional(),
  auth: z
    .enum(['bearer', 'none'])
    .optional()
    .describe(
      "'bearer' (default) sends AIRBRAKE_USER_TOKEN as Bearer auth. 'none' omits Authorization — required for project-key endpoints like the v3 notifier and iOS reports.",
    ),
});

export const requestTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_request',
  description:
    'Escape hatch: send a raw request to any Airbrake API endpoint. Use when no resource-specific tool covers what you need, or for project-key / multipart endpoints. Returns the raw Airbrake JSON payload — no data is removed.',
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    const opts: RequestOptions = {};
    if (parsed.query !== undefined) opts.query = parsed.query;
    if (parsed.body !== undefined) opts.body = parsed.body;
    if (parsed.headers !== undefined) opts.headers = parsed.headers;
    if (parsed.auth !== undefined) opts.auth = parsed.auth;
    return ctx.client.request(parsed.method, parsed.path, opts);
  },
};
