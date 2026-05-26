import { z } from 'zod';
import type { RequestOptions } from '../client/airbrake.js';
import type { ToolDefinition } from './types.js';

// The URL is built by raw string concatenation (`${host}${path}${query}`) and
// then handed to fetch, which normalizes `..` segments per WHATWG URL parsing.
// A guard like `startsWith('/api/')` is satisfied by `/api/x/../../admin` —
// after normalization the request hits `/admin` with the bearer token attached.
// Reject any `..` segment after percent-decoding to close the bypass.
const pathSchema = z
  .string()
  .startsWith('/api/', 'path must start with /api/ (Airbrake API path)')
  .refine((p) => {
    try {
      const decoded = decodeURIComponent(p);
      return !decoded.split(/[/\\]/).includes('..');
    } catch {
      return false;
    }
  }, 'path must not contain ".." traversal (raw or percent-encoded)')
  .describe('Airbrake API path, e.g. /api/v4/projects/123/groups');

// Header values must not contain CR or LF. Node's fetch rejects these at
// request time, but a schema-level check gives a clearer error and prevents
// the malformed value from ever reaching the network layer.
const headerValueSchema = z
  .string()
  .refine((v) => !/[\r\n]/.test(v), 'header values must not contain CR or LF');

const inputSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: pathSchema,
  query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z
    .unknown()
    .optional()
    .describe(
      'Request body. Objects are JSON-serialized; strings are sent verbatim (use this for multipart/form-data or other non-JSON payloads — set the matching Content-Type in headers).',
    ),
  headers: z.record(headerValueSchema).optional(),
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
