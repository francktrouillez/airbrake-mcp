import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';

// The SDK stores handlers on a private `_requestHandlers` map keyed by method string.
// If the SDK ever removes this internal, switch to driving an in-memory transport pair.
function getHandler(
  server: unknown,
  method: string,
): (req: unknown, extra: unknown) => Promise<unknown> {
  const map = (
    server as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = map.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler;
}

describe('MCP server integration', () => {
  beforeEach(() => nock.cleanAll());

  it('lists all 8 tools', async () => {
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, ListToolsRequestSchema.shape.method.value);
    const result = (await handler({ method: 'tools/list', params: {} }, {})) as {
      tools: { name: string }[];
    };
    const names = result.tools.map((t) => t.name);
    expect(names).toHaveLength(8);
    expect(names).toContain('airbrake_request');
    expect(names).toContain('airbrake_notify');
    expect(names).toContain('airbrake_sourcemaps');
    // Removed tools must stay removed.
    for (const removed of [
      'airbrake_account',
      'airbrake_comments',
      'airbrake_bookmarks',
      'airbrake_iframes',
      'airbrake_tokens',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('every tool inputSchema satisfies MCP constraints', async () => {
    // MCP / Claude requires:
    //   1. Top-level `type: "object"`
    //   2. No top-level `anyOf` / `oneOf` / `allOf`
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, ListToolsRequestSchema.shape.method.value);
    const result = (await handler({ method: 'tools/list', params: {} }, {})) as {
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };
    for (const t of result.tools) {
      expect(t.inputSchema.type, `tool ${t.name} missing type:"object"`).toBe('object');
      expect(t.inputSchema.anyOf, `tool ${t.name} has top-level anyOf`).toBeUndefined();
      expect(t.inputSchema.oneOf, `tool ${t.name} has top-level oneOf`).toBeUndefined();
      expect(t.inputSchema.allOf, `tool ${t.name} has top-level allOf`).toBeUndefined();
    }
  });

  it('discriminated-union tools expose `action` as an enum at the top level', async () => {
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, ListToolsRequestSchema.shape.method.value);
    const result = (await handler({ method: 'tools/list', params: {} }, {})) as {
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };
    const groups = result.tools.find((t) => t.name === 'airbrake_groups')!;
    const props = groups.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(
      expect.arrayContaining(['list', 'get', 'mute', 'unmute', 'resolve', 'unresolve', 'delete']),
    );
  });

  it('routes a tool call to the handler', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .query(true)
      .reply(200, { projects: [{ id: 1, name: 'p' }] });
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, CallToolRequestSchema.shape.method.value);
    const result = (await handler(
      {
        method: 'tools/call',
        params: { name: 'airbrake_projects', arguments: { action: 'list' } },
      },
      {},
    )) as { content: { text: string }[] };
    expect(result.content[0].text).toContain('"projects"');
  });

  it('returns isError on unknown tool', async () => {
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, CallToolRequestSchema.shape.method.value);
    const result = (await handler(
      { method: 'tools/call', params: { name: 'nope', arguments: {} } },
      {},
    )) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns isError when handler throws (e.g., Airbrake 4xx)', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects')
      .query(true)
      .reply(401, { message: 'bad token' });
    const server = await createServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const handler = getHandler(server, CallToolRequestSchema.shape.method.value);
    const result = (await handler(
      {
        method: 'tools/call',
        params: { name: 'airbrake_projects', arguments: { action: 'list' } },
      },
      {},
    )) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/401/);
  });
});
