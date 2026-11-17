import { z } from 'zod';
import { PAGINATION_HINT } from '../client/pagination.js';
import { fieldsSchema, listResult } from './fields.js';
import { pageSchema, projectId, snowflakeId } from './schemas.js';
import {
  MAX_SOURCEMAP_SIZE_LABEL,
  loadSourceMapFile,
  type LoadedSourceMap,
} from './sourcemap-file.js';
import type { ToolContext, ToolDefinition } from './types.js';

/** Upper bound on the `name` / `pattern` multipart fields. */
export const MAX_SOURCEMAP_FIELD_LENGTH = 2048;
/**
 * Each upload attempt gets at least this long: a large map rarely uploads
 * within the default 15 s AIRBRAKE_TIMEOUT_MS. A single attempt stays under
 * the MCP SDK client's default 60 s request timeout (a 429 retry can still
 * exceed it). A larger configured timeout still wins.
 */
export const UPLOAD_MIN_TIMEOUT_MS = 55_000;

/**
 * Schema for the `name` and `pattern` multipart text fields. Values are
 * trimmed before the checks AND before sending: a stray leading/trailing
 * space would otherwise be stored and the map would never match its URL.
 */
export const sourcemapFieldSchema = z
  .string()
  .trim()
  .min(1, 'must be non-empty')
  .max(MAX_SOURCEMAP_FIELD_LENGTH, `must be at most ${MAX_SOURCEMAP_FIELD_LENGTH} characters`)
  .refine((v) => !/[\r\n]/.test(v), 'must not contain CR or LF');

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('list'), fields: fieldsSchema, project_id: projectId })
    .extend(pageSchema.shape),
  z.object({
    action: z.literal('get'),
    project_id: projectId,
    sourcemap_id: snowflakeId,
  }),
  z.object({
    action: z.literal('delete'),
    project_id: projectId,
    sourcemap_id: snowflakeId,
  }),
  z.object({
    action: z.literal('upload'),
    project_id: projectId,
    file_path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        `Absolute local path to the source map. Must end in .map and resolve (symlinks followed) to a regular *.map file of at most ${MAX_SOURCEMAP_SIZE_LABEL} containing source map v3 JSON.`,
      ),
    name: sourcemapFieldSchema.describe(
      'Minified file URL or name this map applies to, e.g. https://cdn.example.com/app.min.js',
    ),
    pattern: sourcemapFieldSchema
      .optional()
      .describe('Optional SQL LIKE pattern matching minified file URLs, e.g. %/app.min.js'),
  }),
]);

type UploadInput = Extract<z.infer<typeof inputSchema>, { action: 'upload' }>;

function buildUploadForm(map: LoadedSourceMap, input: UploadInput): FormData {
  const form = new FormData();
  form.append('file', new Blob([map.bytes], { type: 'application/json' }), map.fileName);
  form.append('name', input.name);
  if (input.pattern !== undefined) form.append('pattern', input.pattern);
  return form;
}

async function uploadSourceMap(ctx: ToolContext, input: UploadInput): Promise<unknown> {
  // All file checks complete before the request is built. The client never
  // re-sends a POST after a timeout, dropped connection or 5xx (Airbrake may
  // already have stored the map); its error says so, so the model can check
  // with `list` before uploading again.
  const map = await loadSourceMapFile(input.file_path);
  return ctx.client.request('POST', `/api/v4/projects/${input.project_id}/sourcemaps`, {
    body: buildUploadForm(map, input),
    minTimeoutMs: UPLOAD_MIN_TIMEOUT_MS,
  });
}

export const sourcemapsTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_sourcemaps',
  description: `Airbrake source maps: list, get, delete, upload. sourcemap_id MUST be passed as a string. upload reads a LOCAL source map from file_path (see its constraints; anything else is rejected before any request) and POSTs it as multipart/form-data with name (the minified file URL it applies to) and optional pattern (SQL LIKE pattern for minified file URLs). A failed upload is never re-sent automatically; if its error says it may have been applied, check list before uploading again. ${PAGINATION_HINT} Returns the raw Airbrake JSON payload — no data is removed unless list is given \`fields\` (keeps only those top-level keys per item).`,
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'list': {
        const payload = (await ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps`,
          { query: { page: parsed.page, per_page: parsed.per_page } },
        )) as Record<string, unknown>;
        return listResult(payload, parsed);
      }
      case 'get':
        return ctx.client.request(
          'GET',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
      case 'delete':
        return ctx.client.request(
          'DELETE',
          `/api/v4/projects/${parsed.project_id}/sourcemaps/${parsed.sourcemap_id}`,
        );
      case 'upload':
        return uploadSourceMap(ctx, parsed);
    }
  },
};
