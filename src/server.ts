import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AirbrakeClient } from './client/airbrake.js';
import { loadConfig } from './config.js';
import { allTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';

// MCP clients (notably Claude) reject tool inputSchemas that use top-level
// `anyOf` / `oneOf` / `allOf`. Zod's `discriminatedUnion` compiles to
// `{anyOf: [...]}`, so we flatten the branches into a single object schema:
// all properties unioned, the `action` discriminator becomes an enum, and
// `required` is the intersection across branches (since branch-specific
// requireds aren't enforceable at the top level). Runtime validation still
// happens inside each tool handler via `inputSchema.parse(input)`.

type JsonObject = Record<string, unknown>;

function mergeAnyOf(branches: unknown[]): JsonObject {
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
        properties[name] = JSON.parse(JSON.stringify(propSchema));
        continue;
      }
      if (name === 'action') {
        const existing = properties[name] as JsonObject;
        const incoming = propSchema as JsonObject;
        const incomingVal = incoming.const;
        if (incomingVal === undefined) continue;
        if (Array.isArray(existing.enum)) {
          if (!existing.enum.includes(incomingVal)) existing.enum.push(incomingVal);
        } else if (existing.const !== undefined) {
          const old = existing.const;
          delete existing.const;
          existing.enum = [old, incomingVal];
        }
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

export function toMcpInputSchema(schema: z.ZodTypeAny): JsonObject {
  const json = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonObject;
  if (Array.isArray(json.anyOf)) return mergeAnyOf(json.anyOf);
  if (json.type === 'object') return json;
  return { type: 'object', ...json };
}

export async function createServer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<Server> {
  const config = loadConfig(env);
  const client = new AirbrakeClient(config);
  const ctx: ToolContext = { client, config };

  const server = new Server(
    { name: 'airbrake-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toMcpInputSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(ctx, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
