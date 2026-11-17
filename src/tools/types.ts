import type { z } from 'zod';
import type { AirbrakeClient } from '../client/airbrake.js';
import type { Config } from '../config.js';

export interface ToolContext {
  client: AirbrakeClient;
  config: Config;
}

/**
 * MCP behaviour hints. All four are always set explicitly so a client never
 * falls back to the spec defaults (which assume "destructive"). The server
 * adds `title` from the tool's own title when listing.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<TInput extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  annotations: ToolHints;
  inputSchema: TInput;
  handler: (ctx: ToolContext, input: z.infer<TInput>) => Promise<unknown>;
}
