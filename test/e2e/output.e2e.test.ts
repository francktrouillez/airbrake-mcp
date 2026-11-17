// Output-size contract over the real stdio transport: compact JSON, the
// smaller notices default page, and `fields` projection.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildNoticesPage, FIXTURE_GROUP_ID } from '../fixtures/notices.js';
import { MockAirbrake, type RecordedRequest } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';

const NOTICES_PATH = `/api/v4/projects/42/groups/${FIXTURE_GROUP_ID}/notices`;

function noticesReply(req: RecordedRequest): { body: Record<string, unknown> } {
  return { body: buildNoticesPage(Number(req.query.per_page ?? 50)) };
}

describe('e2e: tool output size', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;

  beforeAll(async () => {
    await mock.start();
    mcp = await startMcp({ AIRBRAKE_USER_TOKEN: 'e2e-token', AIRBRAKE_HOST: mock.url });
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

  it('returns compact JSON that parses back to the full payload', async () => {
    const body = {
      projects: [{ id: 1, name: 'p', nested: { deep: [1, 2, { x: 'y' }] } }],
      count: 1,
    };
    mock.on('GET', '/api/v4/projects', { body });
    const res = await mcp.call('airbrake_projects', { action: 'list' });
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain('\n');
    expect(res.text).toBe(JSON.stringify(res.json));
    expect(res.json).toEqual({ ...body, _pagination: expect.objectContaining({ page: 1 }) });
  });

  it('notices list without per_page asks Airbrake for 10 per page', async () => {
    mock.on('GET', NOTICES_PATH, noticesReply);
    const res = await mcp.call('airbrake_notices', {
      action: 'list',
      project_id: 42,
      group_id: FIXTURE_GROUP_ID,
    });
    expect(res.isError).toBe(false);
    const [req] = mock.find('GET', NOTICES_PATH);
    expect(req?.query.per_page).toBe('10');
    const json = res.json as { notices: unknown[]; _pagination: Record<string, unknown> };
    expect(json.notices).toHaveLength(10);
    expect(json._pagination).toMatchObject({ page: 1, per_page: 10 });
  });

  it('other list tools keep the 50 per-page default', async () => {
    mock.on('GET', '/api/v4/projects/42/groups', { body: { groups: [] } });
    await mcp.call('airbrake_groups', { action: 'list', project_id: 42 });
    expect(mock.find('GET', '/api/v4/projects/42/groups')[0]?.query.per_page).toBe('50');
  });

  it('groups list with fields returns only those keys while count/_pagination survive', async () => {
    mock.on('GET', '/api/v4/projects/42/groups', {
      body: {
        groups: [
          {
            id: '3741526488590376432',
            errors: [{ type: 'E' }],
            context: { big: 'x' },
            resolved: false,
          },
          { id: '3741526488590376433', errors: [{ type: 'F' }], noticeCount: 9 },
        ],
        count: 2,
      },
    });
    const res = await mcp.call('airbrake_groups', {
      action: 'list',
      project_id: 42,
      fields: ['id', 'errors'],
    });
    expect(res.isError).toBe(false);
    const json = res.json as Record<string, unknown>;
    expect(json.groups).toEqual([
      { id: '3741526488590376432', errors: [{ type: 'E' }] },
      { id: '3741526488590376433', errors: [{ type: 'F' }] },
    ]);
    expect(json.count).toBe(2);
    expect(json._pagination).toMatchObject({ page: 1, per_page: 50, count: 2 });
  });

  it.each([
    ['empty array', []],
    ['empty string', ['']],
  ])('rejects fields=%s as a tool error with zero HTTP requests', async (_label, fields) => {
    const res = await mcp.call('airbrake_groups', { action: 'list', project_id: 42, fields });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/fields|non-empty|at least/i);
    expect(mock.requests).toHaveLength(0);
  });

  it('shrinks a realistic notices page: pretty/50 → compact/10 → compact/10 + fields', async () => {
    mock.on('GET', NOTICES_PATH, noticesReply);
    const base = { action: 'list', project_id: 42, group_id: FIXTURE_GROUP_ID };

    // "Before": what the previous release sent — 50 notices, pretty-printed.
    const fifty = await mcp.call('airbrake_notices', { ...base, per_page: 50 });
    const before = Buffer.byteLength(JSON.stringify(fifty.json, null, 2));
    const compactFifty = Buffer.byteLength(fifty.text);

    const ten = await mcp.call('airbrake_notices', base);
    const after = Buffer.byteLength(ten.text);

    const projected = await mcp.call('airbrake_notices', {
      ...base,
      fields: ['id', 'createdAt', 'context'],
    });
    const afterFields = Buffer.byteLength(projected.text);

    expect(compactFifty).toBeLessThan(before * 0.7);
    expect(after).toBeLessThan(before / 7);
    expect(afterFields).toBeLessThan(after / 2);
    const notices = (projected.json as { notices: Record<string, unknown>[] }).notices;
    expect(notices).toHaveLength(10);
    for (const n of notices) expect(Object.keys(n).sort()).toEqual(['context', 'createdAt', 'id']);
  });
});
