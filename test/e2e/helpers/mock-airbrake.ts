// A real HTTP server standing in for api.airbrake.io during e2e tests.
//
// The e2e suite spawns the *built* server (`dist/bin.js`) as a child process,
// so in-process interceptors like nock cannot see its traffic. Instead the
// child is pointed at this server via AIRBRAKE_HOST, and every request it
// makes is recorded for assertions.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** Path without the query string, e.g. `/api/v4/projects`. */
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  /** Raw request body as received (utf-8). */
  body: string;
  /** Raw request body bytes, for multipart / binary assertions. */
  rawBody: Buffer;
}

export interface MockReply {
  status?: number;
  /** Objects are JSON-encoded; strings/Buffers are sent verbatim. */
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A route handler. Return a MockReply to have the mock send it, or take full
 * control of `res` (e.g. to stall a body) and return `undefined`.
 */
export type RouteHandler = (
  req: RecordedRequest,
  res: ServerResponse,
) => MockReply | undefined | Promise<MockReply | undefined>;

interface Route {
  method: string;
  path: string | RegExp;
  handler: RouteHandler;
  /** Remaining uses; Infinity for persistent routes. */
  remaining: number;
}

export class MockAirbrake {
  readonly requests: RecordedRequest[] = [];
  /**
   * Harness faults: requests that matched no route, and route handlers that
   * threw. The server under test only sees a 404/500 for these — which it may
   * retry or mistake for a real Airbrake response — so tests should call
   * `assertNoUnhandled()` (e.g. in afterEach) to fail on the real cause.
   */
  readonly unhandled: string[] = [];
  private routes: Route[] = [];
  private server: Server | null = null;
  url = '';

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    this.server = server;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // Destroys every socket, including stalled responses from timeout tests.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Clear recorded requests, harness faults and routes between tests. */
  reset(): void {
    this.requests.length = 0;
    this.unhandled.length = 0;
    this.routes = [];
  }

  /** Throw if any request matched no route or a route handler threw. */
  assertNoUnhandled(): void {
    if (this.unhandled.length > 0) {
      throw new Error(`mock Airbrake harness faults:\n- ${this.unhandled.join('\n- ')}`);
    }
  }

  /**
   * Register a route. `reply` may be a static MockReply or a handler.
   * Routes match in registration order; a route registered with `times`
   * is consumed after that many matches (useful for retry sequences).
   */
  on(
    method: string,
    path: string | RegExp,
    reply: MockReply | RouteHandler,
    times: number = Infinity,
  ): this {
    const handler: RouteHandler = typeof reply === 'function' ? reply : () => reply;
    this.routes.push({ method: method.toUpperCase(), path, handler, remaining: times });
    return this;
  }

  /** Requests matching method + path, in arrival order. */
  find(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && matches(path, r.path));
  }

  // Never let a throwing route handler (or a reset request stream) become an
  // unhandled rejection that leaves the request hanging: record the fault for
  // assertNoUnhandled() and still answer, so the child doesn't sit in a timeout.
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (err) {
      const message = `handler for ${req.method} ${req.url} threw: ${err instanceof Error ? err.message : err}`;
      this.unhandled.push(message);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, { status: 500, body: { message: `mock: ${message}` } });
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://mock');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body: rawBody.toString('utf8'),
      rawBody,
    };
    this.requests.push(recorded);

    const route = this.routes.find(
      (r) => r.remaining > 0 && r.method === recorded.method && matches(r.path, recorded.path),
    );
    if (!route) {
      const message = `no route for ${recorded.method} ${recorded.path}`;
      this.unhandled.push(message);
      send(res, { status: 404, body: { message: `mock: ${message}` } });
      return;
    }
    route.remaining--;
    const reply = await route.handler(recorded, res);
    if (reply) send(res, reply);
  }
}

function matches(pattern: string | RegExp, path: string): boolean {
  // String#search ignores the g/y flags and lastIndex, so stateful regexes
  // match consistently across requests (RegExp#test would alternate).
  return typeof pattern === 'string' ? pattern === path : path.search(pattern) !== -1;
}

function send(res: ServerResponse, reply: MockReply): void {
  const status = reply.status ?? 200;
  // setHeader is case-insensitive, so a caller's `Content-Type` wins over the default.
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  let payload: string | Buffer | undefined;
  if (reply.body !== undefined && status !== 204) {
    if (typeof reply.body === 'string' || Buffer.isBuffer(reply.body)) {
      payload = reply.body;
    } else {
      payload = JSON.stringify(reply.body);
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json');
    }
  }
  res.writeHead(status);
  res.end(payload);
}
