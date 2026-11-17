import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { AirbrakeClient } from '../../src/client/airbrake.js';
import { MAX_SOURCEMAP_BYTES } from '../../src/tools/sourcemap-file.js';
import {
  MAX_SOURCEMAP_FIELD_LENGTH,
  UPLOAD_MIN_TIMEOUT_MS,
  sourcemapFieldSchema,
  sourcemapsTool,
} from '../../src/tools/sourcemaps.js';

const cfg = {
  userToken: 'tok',
  projectKeys: {},
  host: 'https://api.airbrake.io',
  timeoutMs: 5000,
  maxRetries: 0,
};
const ctx = () => ({ client: new AirbrakeClient(cfg), config: cfg });

const SOURCEMAP_ID = '4338294560506624262';

describe('airbrake_sourcemaps', () => {
  beforeEach(() => nock.cleanAll());

  it('list → GET /api/v4/projects/:pid/sourcemaps', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/sourcemaps')
      .query({ page: '1', per_page: '50' })
      .reply(200, { sourcemaps: [] });
    const r = await sourcemapsTool.handler(ctx(), { action: 'list', project_id: 1 });
    expect(r).toMatchObject({ sourcemaps: [], _pagination: { page: 1, per_page: 50 } });
  });

  it('list with count on the last page → has_more false, no next_page', async () => {
    nock('https://api.airbrake.io')
      .get('/api/v4/projects/1/sourcemaps')
      .query({ page: '2', per_page: '50' })
      .reply(200, { sourcemaps: [{ id: SOURCEMAP_ID }], count: 51 });
    const r = (await sourcemapsTool.handler(ctx(), { action: 'list', project_id: 1, page: 2 })) as {
      _pagination: Record<string, unknown>;
    };
    expect(r._pagination).toEqual({
      page: 2,
      per_page: 50,
      count: 51,
      has_more: false,
      total_pages: 2,
    });
  });

  it('get with string sourcemap_id', async () => {
    nock('https://api.airbrake.io')
      .get(`/api/v4/projects/1/sourcemaps/${SOURCEMAP_ID}`)
      .reply(200, { sourcemap: { id: SOURCEMAP_ID } });
    const r = await sourcemapsTool.handler(ctx(), {
      action: 'get',
      project_id: 1,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(r).toEqual({ sourcemap: { id: SOURCEMAP_ID } });
  });

  it('delete with string sourcemap_id', async () => {
    nock('https://api.airbrake.io')
      .delete(`/api/v4/projects/1/sourcemaps/${SOURCEMAP_ID}`)
      .reply(204);
    const r = await sourcemapsTool.handler(ctx(), {
      action: 'delete',
      project_id: 1,
      sourcemap_id: SOURCEMAP_ID,
    });
    expect(r).toBeNull();
  });

  it('rejects path traversal in sourcemap_id', async () => {
    for (const bad of ['../../999', 'abc', '123/../999']) {
      await expect(
        sourcemapsTool.handler(ctx(), { action: 'delete', project_id: 1, sourcemap_id: bad }),
      ).rejects.toThrow(/snowflake/i);
    }
  });

  describe('upload', () => {
    const MAP = JSON.stringify({ version: 3, sources: ['app.js'], names: [], mappings: 'AAAA' });
    const UPLOAD_PATH = '/api/v4/projects/1/sourcemaps';
    let dir: string;

    beforeAll(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smtool-')));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const write = (name: string, content: string): string => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    };

    // Intercepts the upload (requiring Bearer auth) and records the
    // content-type and serialized multipart body for wire-format assertions.
    const interceptUpload = (status = 200, reply: object = { id: 77 }) => {
      const captured = { body: '', contentType: '' };
      const scope = nock('https://api.airbrake.io', {
        reqheaders: { authorization: 'Bearer tok' },
      })
        .post(UPLOAD_PATH, (body: string) => {
          captured.body = body;
          return true;
        })
        .reply(function () {
          captured.contentType = String(this.req.headers['content-type']);
          return [status, reply];
        });
      // Parse with the platform's multipart parser rather than matching
      // fetch's exact serialization.
      const form = (): Promise<FormData> =>
        new Response(captured.body, {
          headers: { 'content-type': captured.contentType },
        }).formData();
      return { scope, captured, form };
    };

    it('POSTs multipart/form-data with file, name and pattern and Bearer auth', async () => {
      const file = write('app.min.js.map', MAP);
      const { scope, captured, form } = interceptUpload();
      const r = await sourcemapsTool.handler(ctx(), {
        action: 'upload',
        project_id: 1,
        file_path: file,
        name: 'https://cdn.example.com/app.min.js',
        pattern: '%/app.min.js',
      });
      expect(r).toEqual({ id: 77 });
      expect(scope.isDone()).toBe(true);
      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const parts = await form();
      expect([...parts.keys()]).toEqual(['file', 'name', 'pattern']);
      const filePart = parts.get('file') as File;
      expect(filePart.name).toBe('app.min.js.map');
      expect(filePart.type).toBe('application/json');
      expect(await filePart.text()).toBe(MAP);
      expect(parts.get('name')).toBe('https://cdn.example.com/app.min.js');
      expect(parts.get('pattern')).toBe('%/app.min.js');
    });

    it('omits the pattern part when not given', async () => {
      const file = write('nopattern.js.map', MAP);
      const { form } = interceptUpload();
      await sourcemapsTool.handler(ctx(), {
        action: 'upload',
        project_id: 1,
        file_path: file,
        name: 'app.min.js',
      });
      expect([...(await form()).keys()]).toEqual(['file', 'name']);
    });

    it('requests a longer upload timeout', async () => {
      const file = write('opts.js.map', MAP);
      const client = new AirbrakeClient(cfg);
      const spy = vi.spyOn(client, 'request').mockResolvedValue({ id: 1 });
      await sourcemapsTool.handler(
        { client, config: cfg },
        { action: 'upload', project_id: 1, file_path: file, name: 'a.js' },
      );
      expect(spy).toHaveBeenCalledWith(
        'POST',
        UPLOAD_PATH,
        expect.objectContaining({
          body: expect.any(FormData),
          minTimeoutMs: UPLOAD_MIN_TIMEOUT_MS,
        }),
      );
    });

    it('warns that an upload failing in flight may have been stored', async () => {
      const file = write('netfail.js.map', MAP);
      nock('https://api.airbrake.io').post(UPLOAD_PATH).replyWithError('ECONNRESET');
      await expect(
        sourcemapsTool.handler(ctx(), {
          action: 'upload',
          project_id: 1,
          file_path: file,
          name: 'a.js',
        }),
      ).rejects.toThrow(
        /ECONNRESET.*not retried: resending POST is unsafe; the request may have been applied/,
      );
    });

    it('sends trimmed name and pattern values', async () => {
      const file = write('trim.js.map', MAP);
      const { form } = interceptUpload();
      await sourcemapsTool.handler(ctx(), {
        action: 'upload',
        project_id: 1,
        file_path: file,
        name: '  https://cdn.example.com/app.min.js ',
        pattern: ' %/app.min.js\t',
      });
      const parts = await form();
      expect(parts.get('name')).toBe('https://cdn.example.com/app.min.js');
      expect(parts.get('pattern')).toBe('%/app.min.js');
    });

    it('surfaces Airbrake errors', async () => {
      const file = write('err.js.map', MAP);
      interceptUpload(422, { message: 'bad map' });
      await expect(
        sourcemapsTool.handler(ctx(), {
          action: 'upload',
          project_id: 1,
          file_path: file,
          name: 'app.min.js',
        }),
      ).rejects.toMatchObject({ status: 422 });
    });

    // Every rejection path must fail before a single byte leaves the process.
    describe('rejections make zero HTTP requests', () => {
      const expectRejected = async (args: Record<string, unknown>, message: RegExp) => {
        const { scope } = interceptUpload();
        await expect(
          sourcemapsTool.handler(ctx(), { action: 'upload', project_id: 1, ...args } as never),
        ).rejects.toThrow(message);
        expect(scope.isDone()).toBe(false);
      };

      it('missing file', async () => {
        await expectRejected(
          { file_path: path.join(dir, 'missing.js.map'), name: 'a.js' },
          /does not exist/,
        );
      });

      it('directory', async () => {
        const d = path.join(dir, 'dir.map');
        fs.mkdirSync(d, { recursive: true });
        await expectRejected({ file_path: d, name: 'a.js' }, /regular file/);
      });

      it('non-.map file', async () => {
        await expectRejected({ file_path: write('map.txt', MAP), name: 'a.js' }, /\.map/);
      });

      it('symlink .map → non-.map target', async () => {
        const secret = write('secret.env', 'API_KEY=hunter2');
        const link = path.join(dir, 'bundle.js.map');
        fs.symlinkSync(secret, link);
        await expectRejected({ file_path: link, name: 'a.js' }, /\.map/);
      });

      it('oversized file (sparse, above MAX_SOURCEMAP_BYTES)', async () => {
        const p = path.join(dir, 'sparse.js.map');
        fs.writeFileSync(p, '');
        fs.truncateSync(p, MAX_SOURCEMAP_BYTES + 1);
        await expectRejected({ file_path: p, name: 'a.js' }, /exceeds/);
      });

      it('invalid JSON', async () => {
        await expectRejected(
          { file_path: write('bad.js.map', '{not json'), name: 'a.js' },
          /not valid JSON/,
        );
      });

      it('JSON that is not a v3 source map', async () => {
        await expectRejected(
          {
            file_path: write('v2.js.map', JSON.stringify({ version: 2, mappings: '' })),
            name: 'a.js',
          },
          /source map v3/,
        );
      });

      it.each([
        ['empty name', { name: '' }],
        ['name with CR/LF', { name: 'a.js\r\nX: y' }],
        ['name too long', { name: 'a'.repeat(MAX_SOURCEMAP_FIELD_LENGTH + 1) }],
        ['empty pattern', { name: 'a.js', pattern: '' }],
        ['pattern with LF', { name: 'a.js', pattern: '%\n%' }],
        ['pattern too long', { name: 'a.js', pattern: '%'.repeat(MAX_SOURCEMAP_FIELD_LENGTH + 1) }],
      ])('%s', async (_label, extra) => {
        await expectRejected({ file_path: write('ok.js.map', MAP), ...extra }, /name|pattern/);
      });

      it('missing file_path', async () => {
        await expectRejected({ name: 'a.js' }, /file_path/);
      });
    });
  });

  describe('sourcemapFieldSchema (name / pattern)', () => {
    it('accepts a URL', () => {
      expect(sourcemapFieldSchema.parse('https://cdn.example.com/app.min.js')).toBe(
        'https://cdn.example.com/app.min.js',
      );
    });

    it('accepts exactly MAX_SOURCEMAP_FIELD_LENGTH chars', () => {
      expect(() =>
        sourcemapFieldSchema.parse('a'.repeat(MAX_SOURCEMAP_FIELD_LENGTH)),
      ).not.toThrow();
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['too long', 'a'.repeat(MAX_SOURCEMAP_FIELD_LENGTH + 1)],
      ['CR', 'app.js\rX-Injected: 1'],
      ['LF', 'app.js\nX-Injected: 1'],
    ])('rejects %s', (_label, value) => {
      expect(() => sourcemapFieldSchema.parse(value)).toThrow();
    });
  });
});
