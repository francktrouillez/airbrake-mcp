import { z } from 'zod';
import type { ToolDefinition } from './types.js';

// Mapping from action name to the actual v5 endpoint segment.
// routes-breakdowns is intentionally absent — that endpoint is PUT-only
// (SDK ingestion side) and returns 405 on GET.
const ENDPOINTS = {
  routes_stats: 'routes-stats',
  queries_stats: 'queries-stats',
  queues_stats: 'queues-stats',
} as const;

const baseTimeRange = z.object({
  time__gte: z.string().describe('ISO 8601 timestamp lower bound (required)'),
  time__lt: z.string().describe('ISO 8601 timestamp upper bound (required)'),
  period: z.enum(['minute', 'hour', 'day']).describe('Bucket granularity (required)'),
  environment: z.string().optional(),
});

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('routes_stats'),
      project_id: z.number().int().positive(),
      route: z.string().optional(),
      method: z.string().optional(),
      query: z.string().optional(),
    })
    .merge(baseTimeRange),
  z
    .object({
      action: z.literal('queries_stats'),
      project_id: z.number().int().positive(),
      route: z
        .string()
        .describe(
          'Required. The endpoint returns 400 "no joins to apply JoinOn" without a route filter.',
        ),
      method: z.string().optional(),
      query: z.string().optional(),
    })
    .merge(baseTimeRange),
  z
    .object({
      action: z.literal('queues_stats'),
      project_id: z.number().int().positive(),
      queue: z
        .string()
        .describe(
          'Required. Background-job queue name (e.g. "default"). The endpoint returns 400 "no joins to apply JoinOn" without it.',
        ),
    })
    .merge(baseTimeRange),
]);

export const performanceTool: ToolDefinition<typeof inputSchema> = {
  name: 'airbrake_performance',
  description:
    'Airbrake APM data (v5). routes_stats: overall route latency/throughput (optional route/method/query filters). queries_stats: DB queries — REQUIRES a `route` filter. queues_stats: background jobs — REQUIRES a `queue` filter. All actions require time__gte, time__lt, and period ("minute"|"hour"|"day"); optional environment everywhere. Returns the raw Airbrake JSON payload — no data is removed.',
  inputSchema,
  handler: async (ctx, input) => {
    const parsed = inputSchema.parse(input);
    const { action, project_id, ...filters } = parsed;
    const segment = ENDPOINTS[action];
    return ctx.client.request('GET', `/api/v5/projects/${project_id}/${segment}`, {
      query: filters,
    });
  },
};
