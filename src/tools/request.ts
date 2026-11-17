import { z } from 'zod';
import type { RequestOptions } from '../client/airbrake.js';
import { READ_ONLY_DISABLED_SUFFIX, READ_ONLY_HINTS } from './read-only.js';
import type { ToolContext, ToolDefinition } from './types.js';

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

const ALL_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
const WRITE_METHODS: ReadonlySet<string> = new Set(ALL_METHODS.filter((m) => m !== 'GET'));

const inputSchema = z.object({
  method: z.enum(ALL_METHODS),
  path: pathSchema,
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z
    .unknown()
    .optional()
    .describe(
      'Request body. Objects are JSON-serialized; strings are sent verbatim (use this for multipart/form-data or other non-JSON payloads — set the matching Content-Type in headers).',
    ),
  headers: z.record(z.string(), headerValueSchema).optional(),
  auth: z
    .enum(['bearer', 'none'])
    .optional()
    .describe(
      "'bearer' (default) sends AIRBRAKE_USER_TOKEN as Bearer auth. 'none' omits Authorization — required for project-key endpoints like the v3 notifier and iOS reports.",
    ),
});

// GET-only and body-less (fetch rejects a GET with a body). Strict so a
// stray `body` is refused rather than silently dropped.
const readOnlyInputSchema = inputSchema
  .omit({ body: true })
  .extend({ method: z.enum(['GET']) })
  .strict();

function send(ctx: ToolContext, parsed: z.infer<typeof inputSchema>): Promise<unknown> {
  const opts: RequestOptions = {};
  if (parsed.query !== undefined) opts.query = parsed.query;
  if (parsed.body !== undefined) opts.body = parsed.body;
  if (parsed.headers !== undefined) opts.headers = parsed.headers;
  if (parsed.auth !== undefined) opts.auth = parsed.auth;
  return ctx.client.request(parsed.method, parsed.path, opts);
}

function readOnlyRefusal(what: string): Error {
  return new Error(`airbrake_request ${what} ${READ_ONLY_DISABLED_SUFFIX}`);
}

const DESCRIPTION =
  'Escape hatch: send a raw request to any Airbrake API endpoint. Use when no resource-specific tool covers what you need, or for project-key / multipart endpoints. Returns the raw Airbrake JSON payload — no data is removed.';

export const requestTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_request',
  title: 'Raw Airbrake API request',
  description: DESCRIPTION,
  // Conservative: the method is caller-chosen, so assume the worst.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => send(ctx, inputSchema.parse(input)),
};

/**
 * Replaces `requestTool` when AIRBRAKE_READ_ONLY is set: same name, GET-only
 * schema and read-only hints. Write methods and bodies are refused before
 * schema parsing so the error names the setting rather than a generic zod
 * error; malformed input still gets the zod error.
 */
export const requestReadOnlyTool: ToolDefinition<typeof readOnlyInputSchema> = {
  name: 'airbrake_request',
  title: 'Raw Airbrake API request (GET only)',
  description: `${DESCRIPTION} AIRBRAKE_READ_ONLY is set: only GET (without a body) is allowed.`,
  annotations: READ_ONLY_HINTS,
  inputSchema: readOnlyInputSchema,
  handler: async (ctx, input) => {
    const raw = (input ?? {}) as { method?: unknown; body?: unknown };
    if (typeof raw.method === 'string' && WRITE_METHODS.has(raw.method.toUpperCase())) {
      throw readOnlyRefusal(`method ${raw.method}`);
    }
    if (raw.body !== undefined) throw readOnlyRefusal('body');
    // Method-override headers / `_method` (in query or path) are refused by
    // the client's read-only guard, which sees the final URL and headers.
    return send(ctx, readOnlyInputSchema.parse(input));
  },
};
