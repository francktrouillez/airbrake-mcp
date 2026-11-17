// `fields` projection across every list-type action. Each case asserts the
// request still goes out with the usual pagination query, items come back
// reduced to the requested keys, and non-array props (count, _pagination)
// survive untouched.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { deploysTool } from '../../src/tools/deploys.js';
import { groupsTool } from '../../src/tools/groups.js';
import { noticesTool } from '../../src/tools/notices.js';
import { projectsTool } from '../../src/tools/projects.js';
import { sourcemapsTool } from '../../src/tools/sourcemaps.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const GROUP_ID = '4338045234182207507';

interface ListCase {
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: ToolDefinition<any>;
  args: Record<string, unknown>;
  path: string;
  key: string;
  defaultPerPage: number;
}

const cases: ListCase[] = [
  {
    label: 'projects list',
    tool: projectsTool,
    args: { action: 'list' },
    path: '/api/v4/projects',
    key: 'projects',
    defaultPerPage: 50,
  },
  {
    label: 'projects list_activities',
    tool: projectsTool,
    args: { action: 'list_activities', project_id: 1 },
    path: '/api/v4/projects/1/activities',
    key: 'activities',
    defaultPerPage: 50,
  },
  {
    label: 'groups list',
    tool: groupsTool,
    args: { action: 'list', project_id: 1 },
    path: '/api/v4/projects/1/groups',
    key: 'groups',
    defaultPerPage: 50,
  },
  {
    label: 'notices list',
    tool: noticesTool,
    args: { action: 'list', project_id: 1, group_id: GROUP_ID },
    path: `/api/v4/projects/1/groups/${GROUP_ID}/notices`,
    key: 'notices',
    defaultPerPage: 10,
  },
  {
    label: 'deploys list',
    tool: deploysTool,
    args: { action: 'list', project_id: 1 },
    path: '/api/v4/projects/1/deploys',
    key: 'deploys',
    defaultPerPage: 50,
  },
  {
    label: 'sourcemaps list',
    tool: sourcemapsTool,
    args: { action: 'list', project_id: 1 },
    path: '/api/v4/projects/1/sourcemaps',
    key: 'sourcemaps',
    defaultPerPage: 50,
  },
];

function fullItems(): Record<string, unknown>[] {
  return [
    { id: 'a', name: 'first', big: { nested: [1, 2, 3] }, other: 'x' },
    { id: 'b', name: 'second', big: { nested: [4] } },
  ];
}

describe.each(cases)('fields projection: $label', (c) => {
  beforeEach(() => nock.cleanAll());

  it('projects items to the requested keys and keeps count/_pagination', async () => {
    nock('https://api.airbrake.io')
      .get(c.path)
      .query({ page: '1', per_page: String(c.defaultPerPage) })
      .reply(200, { [c.key]: fullItems(), count: 2 });
    const r = (await c.tool.handler(ctx(), { ...c.args, fields: ['id', 'name', 'missing'] })) as
      | Record<string, unknown>
      | undefined;
    expect(r?.[c.key]).toEqual([
      { id: 'a', name: 'first' },
      { id: 'b', name: 'second' },
    ]);
    expect(r?.count).toBe(2);
    expect(r?._pagination).toMatchObject({ page: 1, per_page: c.defaultPerPage, count: 2 });
  });

  it('returns the raw payload when fields is omitted', async () => {
    nock('https://api.airbrake.io')
      .get(c.path)
      .query(true)
      .reply(200, { [c.key]: fullItems(), count: 2 });
    const r = (await c.tool.handler(ctx(), c.args)) as Record<string, unknown>;
    expect(r[c.key]).toEqual(fullItems());
  });

  it('rejects invalid fields without making a request', async () => {
    const context = ctx();
    const spy = vi.spyOn(context.client, 'request');
    await expect(c.tool.handler(context, { ...c.args, fields: [''] })).rejects.toThrow(/non-empty/);
    expect(spy).not.toHaveBeenCalled();
  });
});
