// Regression guard for the public tool surface, plus end-to-end proof that
// malformed IDs are rejected before any HTTP request. (Branch-by-branch wiring
// of the shared schemas is checked in-process in test/tools/schemas.test.ts.)
//
// Snapshots: one file per tool under __snapshots__/tools-list/, holding the
// exact name, description and JSON inputSchema that `tools/list` puts on the
// wire. A change to a tool's schema (field, default, limit, regex, describe
// text, property order) fails only that tool's snapshot. Refresh intentional
// changes with `npm run build && npm run test:e2e:run -- -u`; delete the file
// of a removed tool. Note src/server.ts `mergeAnyOf` keeps only the FIRST
// branch's copy of a property shared across actions, so later branches are
// not visible here.

import { readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockAirbrake } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness, type ToolResult } from './helpers/mcp-harness.js';

const GOOD_ID = '3741526488590376432';
// Distinct from GOOD_ID so the positive control can see THIS field in the URL.
const FIELD_ID = '1234567890123456789';
const BAD_PROJECT_IDS = [0, -1, 1.5, '42'];
const BAD_SNOWFLAKES = [
  Number(GOOD_ID), // JSON number: loses precision
  '../../admin',
  '123/../999',
  '..',
  '',
];
const TIME_RANGE = {
  time__gte: '2026-01-01T00:00:00Z',
  time__lt: '2026-01-02T00:00:00Z',
  period: 'hour',
};

// Every (tool, action, field) that sends an ID to Airbrake; `good` and `bad`
// default to FIELD_ID and BAD_SNOWFLAKES.
const ID_CASES: {
  tool: string;
  args: Record<string, unknown>;
  field: string;
  good?: string;
  bad?: unknown[];
}[] = [
  ...['get', 'delete', 'mute', 'unmute', 'resolve', 'unresolve'].map((action) => ({
    tool: 'airbrake_groups',
    args: { action },
    field: 'group_id',
  })),
  { tool: 'airbrake_groups', args: { action: 'get_stats', ...TIME_RANGE }, field: 'group_id' },
  { tool: 'airbrake_groups', args: { action: 'list' }, field: 'deploy_id' },
  { tool: 'airbrake_notices', args: { action: 'list' }, field: 'group_id' },
  { tool: 'airbrake_notices', args: { action: 'get', notice_id: GOOD_ID }, field: 'group_id' },
  { tool: 'airbrake_notices', args: { action: 'get', group_id: GOOD_ID }, field: 'notice_id' },
  { tool: 'airbrake_deploys', args: { action: 'get' }, field: 'deploy_id' },
  { tool: 'airbrake_sourcemaps', args: { action: 'get' }, field: 'sourcemap_id' },
  { tool: 'airbrake_sourcemaps', args: { action: 'delete' }, field: 'sourcemap_id' },
  {
    tool: 'airbrake_notices',
    args: { action: 'get_status' },
    field: 'notice_uuid',
    good: 'abc-123',
    bad: ['../../admin', 'a/b', '..', ''],
  },
];

describe('e2e: tool schemas', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: 'e2e-user-token',
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_MAX_RETRIES: '0',
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await mock.stop();
  });

  afterEach(() => {
    try {
      mock.assertNoUnhandled();
    } finally {
      mock.reset();
    }
  });

  it('tools/list output matches the committed per-tool snapshots', async () => {
    // Raw request with a pass-through result schema: `client.listTools()`
    // re-parses each tool with the SDK's own zod schema, which reorders keys
    // and would make the snapshot depend on the SDK version, not our output.
    const { tools } = await mcp.client.request(
      { method: 'tools/list' },
      z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }),
    );
    for (const tool of tools) {
      // soft: report every tool whose snapshot differs, not just the first.
      await expect
        .soft(`${JSON.stringify(tool, null, 2)}\n`)
        .toMatchFileSnapshot(`./__snapshots__/tools-list/${tool.name}.json`);
    }
    // No stale snapshot left behind for a removed or renamed tool.
    const files = readdirSync(new URL('./__snapshots__/tools-list/', import.meta.url));
    expect(files.filter((f) => f.endsWith('.json')).sort()).toEqual(
      tools.map((t) => `${t.name}.json`).sort(),
    );
  });

  for (const { tool, args, field, good = FIELD_ID, bad: badValues = BAD_SNOWFLAKES } of ID_CASES) {
    it(`${tool} ${String(args.action)} validates ${field} before any HTTP request`, async () => {
      // Positive control: with a valid ID the call reaches Airbrake carrying
      // that ID, so the other args are valid and any rejection below is down
      // to `field`.
      for (const method of ['GET', 'PUT', 'DELETE']) mock.on(method, /.*/, { body: {} });
      const ok = await mcp.call(tool, { project_id: 42, ...args, [field]: good });
      expect(ok.isError, ok.text).toBe(false);
      expect(mock.requests).toHaveLength(1);
      const req = mock.requests[0]!;
      expect([...req.path.split('/'), ...Object.values(req.query)]).toContain(good);

      for (const bad of badValues) {
        const res = await mcp.call(tool, { project_id: 42, ...args, [field]: bad });
        expectOnlyFieldRejected(res, field, `${tool}.${field}=${JSON.stringify(bad)}`);
      }
      expect(mock.requests).toHaveLength(1);
    });
  }

  it('rejects a non-positive / non-integer project_id on every project-scoped tool', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['airbrake_projects', { action: 'get' }],
      ['airbrake_groups', { action: 'list' }],
      ['airbrake_notices', { action: 'get_status', notice_uuid: 'abc-123' }],
      ['airbrake_deploys', { action: 'list' }],
      ['airbrake_sourcemaps', { action: 'list' }],
      ['airbrake_performance', { action: 'routes_stats', ...TIME_RANGE }],
      ['airbrake_notify', { action: 'notify', payload: { errors: [] } }],
    ];
    for (const [tool, args] of calls) {
      for (const bad of BAD_PROJECT_IDS) {
        const res = await mcp.call(tool, { ...args, project_id: bad });
        expectOnlyFieldRejected(res, 'project_id', `${tool} project_id=${JSON.stringify(bad)}`);
      }
    }
    expect(mock.requests).toHaveLength(0);
  });
});

/**
 * The tool error text is `z.prettifyError` output: one `✖ <message>` line per
 * issue, followed by `  → at <path>` when the issue has a path. Every issue
 * must point at `field`, so a failure caused by some other argument cannot
 * mask a missing validator on the field under test.
 */
function expectOnlyFieldRejected(res: ToolResult, field: string, label: string): void {
  expect(res.isError, label).toBe(true);
  const lines = res.text.split('\n');
  const issueCount = lines.filter((l) => l.startsWith('✖ ')).length;
  const paths = lines.flatMap((l) => {
    const m = /^\s+→ at (.+)$/.exec(l);
    return m ? [m[1]!.split(/[.[]/)[0]] : [];
  });
  expect(issueCount, `${label}: ${res.text}`).toBeGreaterThan(0);
  expect(paths, `${label}: every issue needs a path`).toHaveLength(issueCount);
  expect(paths, label).toEqual(paths.map(() => field));
}
