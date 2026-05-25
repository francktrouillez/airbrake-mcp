import type { z } from 'zod';
import type { AirbrakeClient } from '../client/airbrake.js';
import type { Config } from '../config.js';

export interface ToolContext {
  client: AirbrakeClient;
  config: Config;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TInput;
  handler: (ctx: ToolContext, input: z.infer<TInput>) => Promise<unknown>;
}
