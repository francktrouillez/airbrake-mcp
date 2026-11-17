import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AirbrakeClient } from './client/airbrake.js';
import { loadConfig } from './config.js';
import { allTools, readOnlyTools } from './tools/index.js';
import { READ_ONLY_DISABLED_SUFFIX, READ_ONLY_NOTICE } from './tools/read-only.js';
import type { ToolContext } from './tools/types.js';

// Read version from package.json at runtime so it can never drift from
// the published version. Resolution: `../package.json` from src/server.ts
// (dev via tsx) and from dist/server.js (published) both land on the
// package root's package.json, which npm always ships.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// MCP clients (notably Claude) reject tool inputSchemas that use top-level
// `anyOf` / `oneOf` / `allOf`. Zod 4's `discriminatedUnion` compiles to
// `{oneOf: [...]}` (a plain `z.union` to `{anyOf: [...]}`), so we flatten the
// branches into a single object schema: all properties unioned, the
// discriminator becomes an enum, and `required` is the intersection across
// branches (since branch-specific requireds aren't enforceable at the top
// level). Runtime validation still happens inside each tool handler via
// `inputSchema.parse(input)`.

type JsonObject = Record<string, unknown>;

// Values a discriminator branch accepts: zod emits a single literal as
// `const` and a multi-value literal / enum as `enum`. `undefined` means the
// branch leaves the field open (e.g. `z.string()`).
function literalValues(schema: JsonObject): unknown[] | undefined {
  if (schema.const !== undefined) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function mergeDiscriminator(existing: JsonObject, incoming: JsonObject): JsonObject {
  const a = literalValues(existing);
  const b = literalValues(incoming);
  // An open branch accepts any value, so the merged field must stay open too.
  if (!a) return existing;
  if (!b) return incoming;
  const values = [...new Set([...a, ...b])];
  const rest = Object.fromEntries(
    Object.entries(existing).filter(([key]) => key !== 'const' && key !== 'enum'),
  );
  return values.length === 1 ? { ...rest, const: values[0] } : { ...rest, enum: values };
}

function mergeBranches(branches: unknown[], discriminator: string): JsonObject {
  const properties: JsonObject = {};
  const requiredCounts: Record<string, number> = {};
  let total = 0;
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') continue;
    const b = branch as JsonObject;
    if (b.type !== 'object') continue;
    total++;
    const branchProps = (b.properties as JsonObject | undefined) ?? {};
    for (const [name, propSchema] of Object.entries(branchProps)) {
      if (!(name in properties)) {
        properties[name] = propSchema;
      } else if (name === discriminator) {
        properties[name] = mergeDiscriminator(
          properties[name] as JsonObject,
          propSchema as JsonObject,
        );
      }
    }
    for (const name of (b.required as string[] | undefined) ?? []) {
      requiredCounts[name] = (requiredCounts[name] ?? 0) + 1;
    }
  }
  const required = Object.entries(requiredCounts)
    .filter(([, count]) => count === total)
    .map(([name]) => name);
  const result: JsonObject = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) result.required = required;
  return result;
}

// zod-internal `format` names for `.startsWith()` / `.endsWith()` /
// `.includes()`: not JSON Schema formats (strict validators reject unknown
// formats) and redundant with the `pattern` zod emits alongside them.
const ZOD_PSEUDO_FORMATS = new Set(['starts_with', 'ends_with', 'includes']);

// Per-node `z.toJSONSchema` hook that keeps the output semantically identical
// to what zod-to-json-schema produced for zod 3:
//   - closes strip-mode objects (`additionalProperties: false`), which zod 4
//     only does under `io: "output"`;
//   - drops zod-internal pseudo-formats (see above);
//   - drops the +/-Number.MAX_SAFE_INTEGER bounds `.int()` adds;
//   - drops `propertyNames: {type: "string"}` on records (JSON keys are
//     always strings).
function zod3CompatOverride(ctx: {
  zodSchema: { _zod: { def: unknown } };
  jsonSchema: JsonObject;
}): void {
  const def = ctx.zodSchema._zod.def as { type: string; catchall?: unknown };
  const json = ctx.jsonSchema;
  if (def.type === 'object' && def.catchall === undefined) {
    json.additionalProperties ??= false;
  }
  if (typeof json.format === 'string' && ZOD_PSEUDO_FORMATS.has(json.format)) delete json.format;
  if (json.type === 'integer') {
    if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
    if (json.minimum === Number.MIN_SAFE_INTEGER) delete json.minimum;
  }
  if (JSON.stringify(json.propertyNames) === '{"type":"string"}') delete json.propertyNames;
}

export function toMcpInputSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, {
    // Same dialect zod-to-json-schema produced (`jsonSchema7`).
    target: 'draft-07',
    // Describe what callers may SEND: defaulted fields (page/per_page) stay
    // optional instead of being marked required as in the output type.
    io: 'input',
    // Inline every subschema — MCP clients reject `$ref` / `definitions`.
    reused: 'inline',
    cycles: 'throw',
    // Fail loudly (at server startup, and in the unit tests over every tool)
    // rather than silently emitting `{}`, which would advertise "anything
    // goes" to the client.
    unrepresentable: 'throw',
    override: zod3CompatOverride,
  }) as JsonObject;
  const branches = Array.isArray(json.oneOf) ? json.oneOf : json.anyOf;
  if (Array.isArray(branches)) {
    const { discriminator } = schema._zod.def as { discriminator?: string };
    return mergeBranches(branches, discriminator ?? 'action');
  }
  if (json.type === 'object') return json;
  return { type: 'object', ...json };
}

export function formatToolError(toolName: string, err: unknown): string {
  if (err instanceof z.ZodError) {
    return `Invalid arguments for ${toolName}:\n${z.prettifyError(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function createServer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<Server> {
  const config = loadConfig(env);
  if (!config.userToken) {
    // Notify-only setups (only airbrake_notify, no management API) are
    // legitimate without a user token, so this is a warning rather than a
    // hard failure. But silently accepting empty token + management calls
    // means every request 401s with no startup signal — surface it once.
    process.stderr.write(
      'airbrake-mcp: warning: AIRBRAKE_USER_TOKEN is not set — management API calls will fail with 401 (notify-only setups can ignore this)\n',
    );
  }
  if (config.readOnly) process.stderr.write(READ_ONLY_NOTICE);
  const client = new AirbrakeClient(config);
  const ctx: ToolContext = { client, config };

  const server = new Server(
    { name: 'airbrake-mcp', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // The tool set is static: convert the schemas once, at startup, so a
  // schema zod cannot represent fails here instead of on every tools/list.
  const activeTools = config.readOnly ? readOnlyTools : allTools;
  const tools = activeTools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: toMcpInputSchema(t.inputSchema),
    annotations: { title: t.title, ...t.annotations },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = activeTools.find((t) => t.name === req.params.name);
    if (!tool) {
      // Enforced here, not just by hiding the tool from tools/list: a client
      // may call a tool by name without listing first.
      const known = allTools.some((t) => t.name === req.params.name);
      const text = known
        ? `${req.params.name} ${READ_ONLY_DISABLED_SUFFIX}`
        : `unknown tool: ${req.params.name}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    try {
      const result = await tool.handler(ctx, req.params.arguments ?? {});
      // Compact JSON: indentation costs tokens on every response and carries no
      // information for the model.
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: formatToolError(tool.name, err) }] };
    }
  });

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
