import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { noticesTool } from '../../src/tools/notices.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const GROUP_ID = '4338045234182207507';
const NOTICE_ID = '4338045208751454778';

describe('airbrake_notices', () => {
  beforeEach(() => nock.cleanAll());

  it('list with string group_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}/notices`)
      .query({ page: '1', per_page: '50' })
      .reply(200, { notices: [] });
    const r = await noticesTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      group_id: GROUP_ID,
    });
    expect(r).toMatchObject({ notices: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('list with version filter', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}/notices`)
      .query({ page: '1', per_page: '50', version: '1.2.3' })
      .reply(200, { notices: [] });
    const r = await noticesTool.handler(ctx(), {
      action: 'list',
      project_id: 1,
      group_id: GROUP_ID,
      version: '1.2.3',
    });
    expect(r).toMatchObject({ notices: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('get with string IDs', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/groups/${GROUP_ID}/notices/${NOTICE_ID}`)
      .reply(200, { notice: { id: NOTICE_ID } });
    const r = await noticesTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      group_id: GROUP_ID,
      notice_id: NOTICE_ID,
    });
    expect(r).toEqual({ notice: { id: NOTICE_ID } });
  });

  it('rejects numeric notice_id (string-only schema)', async () => {
    await expect(
      noticesTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        group_id: GROUP_ID,
        // @ts-expect-error: schema is string-only; number rejection is asserted at runtime
        notice_id: 12345,
      }),
    ).rejects.toThrow();
  });

  it('rejects path traversal in group_id and notice_id', async () => {
    await expect(
      noticesTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        group_id: '../../admin',
        notice_id: NOTICE_ID,
      }),
    ).rejects.toThrow(/snowflake/i);
    await expect(
      noticesTool.handler(ctx(), {
        action: 'get',
        project_id: 1,
        group_id: GROUP_ID,
        notice_id: '../999',
      }),
    ).rejects.toThrow(/snowflake/i);
  });

  it('get_status → GET /api/v4/projects/:pid/notice-status/:uuid', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/notice-status/abc-123-uuid')
      .reply(200, { status: 'accepted' });
    const r = await noticesTool.handler(ctx(), {
      action: 'get_status',
      project_id: 1,
      notice_uuid: 'abc-123-uuid',
    });
    expect(r).toEqual({ status: 'accepted' });
  });

  it('rejects path traversal / slashes in notice_uuid', async () => {
    for (const bad of ['../etc/passwd', 'abc/123', 'foo.bar', '']) {
      await expect(
        noticesTool.handler(ctx(), {
          action: 'get_status',
          project_id: 1,
          notice_uuid: bad,
        }),
      ).rejects.toThrow(/alphanumerics/i);
    }
  });
});
