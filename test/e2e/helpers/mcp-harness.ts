// Spawns the built MCP server (`dist/bin.js`) over real stdio and drives it
// with the official MCP SDK client — the same path a real MCP client takes.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_BIN = path.resolve(here, '..', '..', '..', 'dist', 'bin.js');

export interface ToolResult {
  isError: boolean;
  /** Concatenated text content. */
  text: string;
  /** `text` parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
}

export interface McpHarness {
  client: Client;
  /** Everything the child wrote to stderr so far. */
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

/**
 * Start `dist/bin.js` with the given env. The SDK merges this over its
 * default safe set (PATH, HOME, USER, SHELL, TERM, …) and does NOT inherit the
 * rest of the parent env, so a developer's real AIRBRAKE_* token can never
 * leak into a test run.
 */
export async function startMcp(env: Record<string, string>): Promise<McpHarness> {
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`${SERVER_BIN} not found — run \`npm run build\` before the e2e suite`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_BIN],
    env,
    stderr: 'pipe',
  });
  let stderrBuf = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const client = new Client({ name: 'airbrake-mcp-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    // Surface the child's own startup error (e.g. invalid AIRBRAKE_HOST)
    // instead of the SDK's generic "Connection closed", and reap the child.
    await transport.close().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP server failed to start: ${reason}\n--- server stderr ---\n${stderrBuf}`);
  }

  return {
    client,
    stderr: () => stderrBuf,
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON (e.g. an error message); `json` stays undefined
      }
      return { isError: result.isError === true, text, json };
    },
    close: () => client.close(),
  };
}
