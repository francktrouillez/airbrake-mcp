import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { deleteTool } from '../../src/tools/delete.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
  readOnly: false,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const GROUP_ID = '4338045234182207507';
const SOURCEMAP_ID = '4338294560506624262';

describe('airbrake_delete', () => {
  beforeEach(() => nock.cleanAll());

  it('resource=group → DELETE /api/v4/projects/:pid/groups/:gid', async () => {
    nock('https://api.airbrake.io').delete(`/api/v4/projects/1/groups/${GROUP_ID}`).reply(204);
    const r = await deleteTool.handler(ctx(), {
      resource: 'group',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toBeNull();
    expect(nock.isDone()).toBe(true);
  });

  it('resource=sourcemap → DELETE /api/v4/projects/:pid/sourcemaps/:sid', async () => {
    nock('https://api.airbrake.io')
      .delete(`/api/v4/projects/1/sourcemaps/${SOURCEMAP_ID}`)
      .reply(204);
    const r = await deleteTool.handler(ctx(), {
      resource: 'sourcemap',
      project_id: 1,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(r).toBeNull();
    expect(nock.isDone()).toBe(true);
  });

  it('requires group_id for resource=group (sourcemap_id is not a substitute)', async () => {
    await expect(
      deleteTool.handler(ctx(), {
        resource: 'group',
        project_id: 1,
        // @ts-expect-error: wrong ID for the resource
        sourcemap_id: SOURCEMAP_ID,
      }),
    ).rejects.toThrow(/group_id/);
  });

  it('requires sourcemap_id for resource=sourcemap (group_id is not a substitute)', async () => {
    await expect(
      deleteTool.handler(ctx(), {
        resource: 'sourcemap',
        project_id: 1,
        // @ts-expect-error: wrong ID for the resource
        group_id: GROUP_ID,
      }),
    ).rejects.toThrow(/sourcemap_id/);
  });

  it('rejects an ambiguous call carrying both IDs', async () => {
    await expect(
      deleteTool.handler(ctx(), {
        resource: 'group',
        project_id: 1,
        group_id: GROUP_ID,
        // @ts-expect-error: extra ID is refused, not silently ignored
        sourcemap_id: SOURCEMAP_ID,
      }),
    ).rejects.toThrow();
  });

  it('rejects an unknown resource', async () => {
    await expect(
      deleteTool.handler(ctx(), {
        // @ts-expect-error: only group | sourcemap
        resource: 'project',
        project_id: 1,
      }),
    ).rejects.toThrow();
  });

  it('rejects path traversal / non-digit IDs for both resources', async () => {
    for (const bad of ['../../999', '123/../999', 'abc', '123abc', '../etc/passwd', '']) {
      await expect(
        deleteTool.handler(ctx(), { resource: 'group', project_id: 1, group_id: bad }),
      ).rejects.toThrow(/snowflake/i);
      await expect(
        deleteTool.handler(ctx(), { resource: 'sourcemap', project_id: 1, sourcemap_id: bad }),
      ).rejects.toThrow(/snowflake/i);
    }
  });

  it('rejects numeric IDs (string-only schema)', async () => {
    await expect(
      deleteTool.handler(ctx(), {
        resource: 'group',
        project_id: 1,
        // @ts-expect-error: schema is string-only
        group_id: 12345,
      }),
    ).rejects.toThrow();
  });
});
