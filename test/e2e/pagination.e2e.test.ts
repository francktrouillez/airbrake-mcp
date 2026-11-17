// End-to-end coverage for `_pagination.has_more` / `next_page`: the built
// binary over stdio, against the local mock Airbrake.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake, type MockReply, type RecordedRequest } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness } from './helpers/mcp-harness.js';
import { PAGINATION_HINT, type PaginationMeta } from '../../src/client/pagination.js';

const GROUP_ID = '3741526488590376432';

const items = (n: number, offset = 0): Array<{ id: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: String(offset + i) }));

function paginationOf(json: unknown): PaginationMeta {
  return (json as { _pagination: PaginationMeta })._pagination;
}

describe('e2e: pagination has_more / next_page', () => {
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

  it('walks a 3-page groups listing by following next_page until has_more is false', async () => {
    const TOTAL = 120;
    const PER_PAGE = 50;
    mock.on('GET', '/api/v4/projects/42/groups', (req: RecordedRequest): MockReply => {
      const page = Number(req.query.page);
      const perPage = Number(req.query.per_page);
      const start = (page - 1) * perPage;
      const size = Math.max(0, Math.min(perPage, TOTAL - start));
      return { body: { groups: items(size, start), count: TOTAL } };
    });

    const seen: PaginationMeta[] = [];
    const ids: string[] = [];
    let page: number | undefined = 1;
    while (page !== undefined && seen.length < 10) {
      const res = await mcp.call('airbrake_groups', {
        action: 'list',
        project_id: 42,
        page,
        per_page: PER_PAGE,
      });
      expect(res.isError).toBe(false);
      const meta = paginationOf(res.json);
      seen.push(meta);
      ids.push(...(res.json as { groups: Array<{ id: string }> }).groups.map((g) => g.id));
      page = meta.has_more ? meta.next_page : undefined;
    }

    expect(seen).toEqual([
      { page: 1, per_page: 50, count: 120, has_more: true, next_page: 2, total_pages: 3 },
      { page: 2, per_page: 50, count: 120, has_more: true, next_page: 3, total_pages: 3 },
      { page: 3, per_page: 50, count: 120, has_more: false, total_pages: 3 },
    ]);
    expect(new Set(ids).size).toBe(TOTAL);
    const pages = mock.find('GET', '/api/v4/projects/42/groups').map((r) => r.query.page);
    expect(pages).toEqual(['1', '2', '3']);
  });

  it('keeps has_more true when Airbrake caps the page below per_page', async () => {
    // Asked for 50, served 20 of 60: the walk must continue, not stop early.
    mock.on('GET', '/api/v4/projects/42/groups', { body: { groups: items(20), count: 60 } });
    const res = await mcp.call('airbrake_groups', { action: 'list', project_id: 42 });
    expect(res.isError).toBe(false);
    expect(paginationOf(res.json)).toEqual({
      page: 1,
      per_page: 50,
      count: 60,
      has_more: true,
      next_page: 2,
      total_pages: 2,
    });
  });

  it('flags has_more as an estimate when deploys omit count', async () => {
    mock.on('GET', '/api/v4/projects/42/deploys', { body: { deploys: items(5) } });
    const res = await mcp.call('airbrake_deploys', {
      action: 'list',
      project_id: 42,
      per_page: 5,
    });
    expect(res.isError).toBe(false);
    expect(paginationOf(res.json)).toEqual({
      page: 1,
      per_page: 5,
      has_more: true,
      next_page: 2,
      has_more_is_estimate: true,
    });
  });

  // Notices default to a smaller page than the other list actions.
  const NOTICES_PER_PAGE = 10;

  it('reports has_more false for an empty notices list', async () => {
    mock.on('GET', `/api/v4/projects/42/groups/${GROUP_ID}/notices`, {
      body: { notices: [], count: 0 },
    });
    const res = await mcp.call('airbrake_notices', {
      action: 'list',
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(false);
    expect(paginationOf(res.json)).toEqual({
      page: 1,
      per_page: NOTICES_PER_PAGE,
      count: 0,
      has_more: false,
      total_pages: 0,
    });
  });

  it('reports has_more false (estimate) for an empty notices list without count', async () => {
    mock.on('GET', `/api/v4/projects/42/groups/${GROUP_ID}/notices`, { body: { notices: [] } });
    const res = await mcp.call('airbrake_notices', {
      action: 'list',
      project_id: 42,
      group_id: GROUP_ID,
    });
    expect(res.isError).toBe(false);
    expect(paginationOf(res.json)).toEqual({
      page: 1,
      per_page: NOTICES_PER_PAGE,
      has_more: false,
      has_more_is_estimate: true,
    });
  });

  const listActions: Array<{
    label: string;
    tool: string;
    args: Record<string, unknown>;
    path: string;
    key: string;
    /** Default page size when it differs from the shared 50. */
    perPage?: number;
  }> = [
    {
      label: 'projects list',
      tool: 'airbrake_projects',
      args: { action: 'list' },
      path: '/api/v4/projects',
      key: 'projects',
    },
    {
      label: 'projects list_activities',
      tool: 'airbrake_projects',
      args: { action: 'list_activities', project_id: 42 },
      path: '/api/v4/projects/42/activities',
      key: 'activities',
    },
    {
      label: 'groups list',
      tool: 'airbrake_groups',
      args: { action: 'list', project_id: 42 },
      path: '/api/v4/projects/42/groups',
      key: 'groups',
    },
    {
      label: 'notices list',
      tool: 'airbrake_notices',
      args: { action: 'list', project_id: 42, group_id: GROUP_ID },
      path: `/api/v4/projects/42/groups/${GROUP_ID}/notices`,
      key: 'notices',
      perPage: NOTICES_PER_PAGE,
    },
    {
      label: 'deploys list',
      tool: 'airbrake_deploys',
      args: { action: 'list', project_id: 42 },
      path: '/api/v4/projects/42/deploys',
      key: 'deploys',
    },
    {
      label: 'sourcemaps list',
      tool: 'airbrake_sourcemaps',
      args: { action: 'list', project_id: 42 },
      path: '/api/v4/projects/42/sourcemaps',
      key: 'sourcemaps',
    },
  ];

  for (const action of listActions) {
    it(`${action.label} carries has_more/next_page/total_pages`, async () => {
      const perPage = action.perPage ?? 50;
      mock.on('GET', action.path, { body: { [action.key]: items(perPage), count: 75 } });
      const res = await mcp.call(action.tool, action.args);
      expect(res.isError).toBe(false);
      expect(paginationOf(res.json)).toEqual({
        page: 1,
        per_page: perPage,
        count: 75,
        has_more: true,
        next_page: 2,
        total_pages: Math.ceil(75 / perPage),
      });
      expect(mock.find('GET', action.path)).toHaveLength(1);
    });
  }

  it('documents has_more/next_page in every paginated tool description', async () => {
    const { tools } = await mcp.client.listTools();
    const paginated = [...new Set(listActions.map((a) => a.tool))];
    for (const name of paginated) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toContain(PAGINATION_HINT);
    }
  });
});
