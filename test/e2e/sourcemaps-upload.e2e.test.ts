// End-to-end coverage for `airbrake_sourcemaps` `upload`: the built binary
// reads a real file from disk and sends real multipart/form-data over HTTP to
// the mock Airbrake, which records the raw bytes for assertions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAirbrake, type RecordedRequest } from './helpers/mock-airbrake.js';
import { startMcp, type McpHarness, type ToolResult } from './helpers/mcp-harness.js';

const TOKEN = 'e2e-user-token';
const UPLOAD_PATH = '/api/v4/projects/42/sourcemaps';
const MULTIPART_PREFIX = /^multipart\/form-data; boundary=/;
// Non-ASCII content proves the bytes travel unmodified.
const MAP_CONTENT = JSON.stringify({
  version: 3,
  file: 'app.min.js',
  sources: ['src/café.ts', null],
  names: ['naïve'],
  mappings: 'AAAA,SAASA',
});

// Parses the recorded body with the platform's standards-compliant
// multipart/form-data parser, using the boundary from the request header.
async function parseMultipart(req: RecordedRequest): Promise<FormData> {
  const contentType = String(req.headers['content-type']);
  return new Response(req.rawBody, { headers: { 'content-type': contentType } }).formData();
}

async function fileBytes(form: FormData): Promise<Buffer> {
  const file = form.get('file') as File;
  return Buffer.from(await file.arrayBuffer());
}

describe('e2e: airbrake_sourcemaps upload', () => {
  const mock = new MockAirbrake();
  let mcp: McpHarness;
  let dir: string;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e-sm-')));
    await mock.start();
    mcp = await startMcp({
      AIRBRAKE_USER_TOKEN: TOKEN,
      AIRBRAKE_HOST: mock.url,
      AIRBRAKE_MAX_RETRIES: '1',
      AIRBRAKE_TIMEOUT_MS: '3000',
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    try {
      mock.assertNoUnhandled();
    } finally {
      mock.reset();
    }
  });

  const write = (name: string, content: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  const upload = (filePath: string, extra: Record<string, unknown> = {}): Promise<ToolResult> =>
    mcp.call('airbrake_sourcemaps_upload', {
      project_id: 42,
      file_path: filePath,
      name: 'app.min.js',
      ...extra,
    });

  it('advertises airbrake_sourcemaps_upload as a non-idempotent write with its fields', async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === 'airbrake_sourcemaps_upload');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tool?.inputSchema.required).toEqual(
      expect.arrayContaining(['project_id', 'file_path', 'name']),
    );
    const props = tool?.inputSchema.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('action');
    expect(props).toHaveProperty('file_path');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('pattern');
  });

  it('uploads a real .map file as multipart/form-data and returns the Airbrake id', async () => {
    const file = write('app.min.js.map', MAP_CONTENT);
    mock.on('POST', UPLOAD_PATH, { body: { id: '4338294560506624262' } });

    const res = await upload(file, {
      name: 'https://cdn.example.com/app.min.js',
      pattern: '%/app.min.js',
    });

    expect(res.isError, res.text).toBe(false);
    expect(res.json).toEqual({ id: '4338294560506624262' });

    const [req] = mock.find('POST', UPLOAD_PATH);
    expect(req).toBeDefined();
    expect(req!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(req!.headers['content-type'])).toMatch(MULTIPART_PREFIX);

    const form = await parseMultipart(req!);
    expect([...form.keys()]).toEqual(['file', 'name', 'pattern']);
    const filePart = form.get('file') as File;
    expect(filePart.name).toBe('app.min.js.map');
    expect(filePart.type).toBe('application/json');
    expect((await fileBytes(form)).equals(fs.readFileSync(file))).toBe(true);
    expect(form.get('name')).toBe('https://cdn.example.com/app.min.js');
    expect(form.get('pattern')).toBe('%/app.min.js');
  });

  it('omits the pattern part when pattern is not given', async () => {
    mock.on('POST', UPLOAD_PATH, { body: { id: 1 } });
    const res = await upload(write('nopattern.js.map', MAP_CONTENT));
    expect(res.isError, res.text).toBe(false);
    const [req] = mock.find('POST', UPLOAD_PATH);
    expect([...(await parseMultipart(req!)).keys()]).toEqual(['file', 'name']);
  });

  describe('rejections make zero requests', () => {
    const SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n';

    it.each([
      [
        'a .map symlink to a secret file',
        (): string => {
          const link = path.join(dir, 'bundle.js.map');
          fs.symlinkSync(write('id_ed25519', SECRET), link);
          return link;
        },
        /\.map/,
      ],
      ['a .txt file', (): string => write('notes.txt', MAP_CONTENT), /\.map/],
      [
        'a .map file that is not a source map',
        (): string => write('fake.js.map', JSON.stringify({ hello: 'world' })),
        /source map v3/,
      ],
    ])('%s', async (_label, makeFile, message) => {
      const res = await upload(makeFile());
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(message);
      expect(res.text).not.toContain('id_ed25519');
      expect(res.text).not.toContain('PRIVATE KEY');
      expect(mock.requests).toHaveLength(0);
    });
  });

  it('surfaces an Airbrake 500 as a tool error without retrying the POST', async () => {
    mock.on('POST', UPLOAD_PATH, { status: 500, body: { message: 'internal error' } });
    const res = await upload(write('err.js.map', MAP_CONTENT));
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/500/);
    expect(res.text).toMatch(
      /not retried: resending POST is unsafe; the request may have been applied/,
    );
    // A 500 is ambiguous (the map may be stored): not retried despite
    // AIRBRAKE_MAX_RETRIES=1, so no duplicate upload.
    expect(mock.find('POST', UPLOAD_PATH)).toHaveLength(1);
  });

  it('does not retry a 503 either: any 5xx on a POST is ambiguous', async () => {
    mock.on('POST', UPLOAD_PATH, { status: 503, headers: { 'retry-after': '0' } }, 1);
    mock.on('POST', UPLOAD_PATH, { body: { id: 9 } });
    const res = await upload(write('busy.js.map', MAP_CONTENT));
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/503/);
    expect(mock.find('POST', UPLOAD_PATH)).toHaveLength(1);
  });

  it('re-sends the complete multipart body when retrying a 429', async () => {
    // 429 means "not processed": the only status a POST upload is retried on.
    const file = write('retry.js.map', MAP_CONTENT);
    mock.on('POST', UPLOAD_PATH, { status: 429, headers: { 'retry-after': '0' } }, 1);
    mock.on('POST', UPLOAD_PATH, { body: { id: 9 } });
    const res = await upload(file);
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toEqual({ id: 9 });
    const reqs = mock.find('POST', UPLOAD_PATH);
    expect(reqs).toHaveLength(2);
    const expected = fs.readFileSync(file);
    for (const req of reqs) {
      expect((await fileBytes(await parseMultipart(req))).equals(expected)).toBe(true);
    }
  });
});
