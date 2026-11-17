import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { groupsUpdateTool } from '../../src/tools/groups-update.js';

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

describe('airbrake_groups_update', () => {
  beforeEach(() => nock.cleanAll());

  it('mute → PUT /muted with no body', async () => {
    nock('https://api.airbrake.io')
      .put(
        `/api/v4/projects/1/groups/${GROUP_ID}/muted`,
        (body) => body === '' || body === undefined,
      )
      .reply(200, { group: { id: GROUP_ID, muted: true } });
    const r = await groupsUpdateTool.handler(ctx(), {
      action: 'mute',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, muted: true } });
  });

  it('unmute → PUT /unmuted', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/unmuted`)
      .reply(200, { group: { id: GROUP_ID, muted: false } });
    const r = await groupsUpdateTool.handler(ctx(), {
      action: 'unmute',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, muted: false } });
  });

  it('resolve → PUT /resolved', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/resolved`)
      .reply(200, { group: { id: GROUP_ID, resolved: true } });
    const r = await groupsUpdateTool.handler(ctx(), {
      action: 'resolve',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, resolved: true } });
  });

  it('unresolve → PUT /unresolved', async () => {
    nock('https://api.airbrake.io')
      .put(`/api/v4/projects/1/groups/${GROUP_ID}/unresolved`)
      .reply(200, { group: { id: GROUP_ID, resolved: false } });
    const r = await groupsUpdateTool.handler(ctx(), {
      action: 'unresolve',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toEqual({ group: { id: GROUP_ID, resolved: false } });
  });

  it('rejects numeric group_id (string-only schema)', async () => {
    await expect(
      groupsUpdateTool.handler(ctx(), {
        action: 'mute',
        project_id: 1,
        // @ts-expect-error: schema is string-only; number rejection is asserted at runtime
        group_id: 12345,
      }),
    ).rejects.toThrow();
  });

  it('rejects path traversal in group_id', async () => {
    for (const bad of ['../../999', '123/../999', 'abc', '../etc/passwd', '']) {
      await expect(
        groupsUpdateTool.handler(ctx(), { action: 'mute', project_id: 1, group_id: bad }),
      ).rejects.toThrow(/snowflake/i);
    }
  });

  it.each(['delete', 'list', 'get'])('rejects non-update action %j', async (action) => {
    await expect(
      groupsUpdateTool.handler(ctx(), {
        // @ts-expect-error: only mute/unmute/resolve/unresolve are accepted
        action,
        project_id: 1,
        group_id: GROUP_ID,
      }),
    ).rejects.toThrow();
  });
});
