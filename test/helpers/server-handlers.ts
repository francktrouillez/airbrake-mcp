import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

export interface InProcessServer {
  listTools: () => Promise<ListedTool[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
}

// The SDK stores handlers on a private `_requestHandlers` map keyed by method
// string (same approach as test/integration.test.ts).
function getHandler(server: unknown, method: string): Handler {
  const map = (server as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const handler = map.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler;
}

export async function inProcessServer(
  env: Record<string, string | undefined>,
): Promise<InProcessServer> {
  const server = await createServer(env);
  const list = getHandler(server, ListToolsRequestSchema.shape.method.value);
  const call = getHandler(server, CallToolRequestSchema.shape.method.value);
  return {
    listTools: async () => {
      const res = (await list({ method: 'tools/list', params: {} }, {})) as {
        tools: ListedTool[];
      };
      return res.tools;
    },
    call: async (name, args = {}) =>
      (await call({ method: 'tools/call', params: { name, arguments: args } }, {})) as CallResult,
  };
}
