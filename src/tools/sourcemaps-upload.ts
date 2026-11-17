import { z } from 'zod';
import { projectId } from './schemas.js';
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

const inputSchema = z.object({
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
});

type UploadInput = z.infer<typeof inputSchema>;

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
  // with airbrake_sourcemaps list before uploading again.
  const map = await loadSourceMapFile(input.file_path);
  return ctx.client.request('POST', `/api/v4/projects/${input.project_id}/sourcemaps`, {
    body: buildUploadForm(map, input),
    minTimeoutMs: UPLOAD_MIN_TIMEOUT_MS,
  });
}

export const sourcemapsUploadTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_sourcemaps_upload',
  title: 'Upload an Airbrake source map',
  description:
    'Upload a LOCAL source map to an Airbrake project: reads file_path (see its constraints; anything else is rejected before any request) and POSTs it as multipart/form-data with name (the minified file URL it applies to) and optional pattern (SQL LIKE pattern for minified file URLs). Each call stores a new map (not idempotent); a failed upload is never re-sent automatically — if its error says it may have been applied, check airbrake_sourcemaps list before uploading again. Disabled when AIRBRAKE_READ_ONLY is set. Returns the raw Airbrake JSON payload — no data is removed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema,
  handler: async (ctx, input) => uploadSourceMap(ctx, inputSchema.parse(input)),
};
