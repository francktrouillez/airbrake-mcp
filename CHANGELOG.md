# Changelog

All notable changes to `airbrake-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `airbrake_groups` `get_stats` accepts an optional `limit` (1–1000;
  Airbrake defaults to 100), sent only when given.
- `_pagination` on list results now reports `has_more` and, when true,
  `next_page`, so the model no longer has to do arithmetic to decide whether
  to fetch another page. When Airbrake returns `count`, `has_more` compares
  the items actually served so far against it (so a page capped below
  `per_page` still reports more) and `total_pages` is added. When `count` is
  absent (or not a finite, non-negative number), `has_more` is inferred from
  the length of the primary list and flagged with
  `has_more_is_estimate: true`; if there is no list either, the fields are
  omitted. Existing `page`/`per_page`/`count` fields are unchanged.
- Optional `fields` (1–50 non-empty key names) on every list-type action —
  `airbrake_projects` `list`/`list_activities`, `airbrake_groups` `list`,
  `airbrake_notices` `list`, `airbrake_deploys` `list`,
  `airbrake_sourcemaps` `list`. Each item of every top-level array in the
  payload is reduced to those top-level keys; `count`, `_pagination` and
  other non-array properties are untouched. Omitting `fields` keeps the raw
  payload.
- **`airbrake_sourcemaps_upload` tool.** Uploads a local source map
  (`file_path`, `name`, optional `pattern`) as multipart/form-data — no more
  hand-building a multipart string for `airbrake_request`. Before any HTTP
  request, `file_path` must be absolute (no Windows UNC/device paths) and
  end in `.map`, and must resolve (symlinks followed) to a regular `*.map`
  file of at most 50 MiB whose content is a source map v3; `name`/`pattern`
  are trimmed and must be non-empty, ≤ 2048 chars and free of CR/LF. This
  stops a prompt-injected model from exfiltrating arbitrary local files.
  Upload attempts get a timeout of at least 55 s. Like every `POST`, an
  upload is never re-sent after a network error, timeout or 5xx (only 429
  and connection failures before sending are retried), so a lost response
  cannot create a duplicate map; such errors say the request may have been
  applied, and the tool description says to check `list` first.
- HTTP client request options: a `FormData` body is passed to `fetch` as-is
  (fetch sets the multipart boundary, any caller content-type is dropped)
  and re-sent in full on retries; `minTimeoutMs` raises the per-attempt
  timeout for one request.
- **MCP tool annotations.** Every tool now advertises a `title` and
  `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) in `tools/list`, so clients can auto-approve reads and
  flag destructive calls. See the annotation table in the README.
- **`AIRBRAKE_READ_ONLY` read-only mode.** `1`/`true`/`yes` (case-insensitive)
  hides `airbrake_groups_update`, `airbrake_deploys_create`,
  `airbrake_sourcemaps_upload`, `airbrake_notify` and `airbrake_delete` from `tools/list` and refuses calls to them in the
  call handler without any HTTP request. `airbrake_request` stays available
  but GET-only (advertised `method` enum `["GET"]`, no `body`; write
  methods and bodies are rejected before any HTTP; annotations become
  read-only). As a backstop below every tool, the HTTP client refuses
  anything but a plain GET in read-only mode, including method-override
  headers and a `_method` query parameter (in `query` or embedded in `path`).
  Calling a moved action on a read tool says its replacement is disabled.
  A one-line notice is written to stderr at startup. Values other than `1/true/yes/0/false/no/""`
  fail startup.
- New tools `airbrake_groups_update`, `airbrake_deploys_create` and
  `airbrake_delete` (see **Changed**), and `airbrake_sourcemaps_upload`
  (see the source-map upload entry).

### Changed

- CI's dependency audit is now `scripts/audit.mjs` (`npm run audit:ci`) instead
  of `npm audit --audit-level=high`. It still fails on every high/critical
  advisory, except those with a reviewed entry in `audit-allowlist.json`. Each
  entry is scoped (`dev` entries can never cover a runtime finding), must name
  the reported package, carries a reason, and must expire within 180 days for
  `dev` or 90 for `runtime`. Expired and stale entries also fail. It audits
  the lockfile only, in its own CI job before any install; `release.yml` runs
  it before `npm ci`. Dev, optional and peer dependencies are always included.
  The only entry is `picomatch` GHSA-fc5q-39xc-vjpf (dev-only, no upstream
  fix; expires 2027-02-17); the `zod` advisory is fixed by the zod 4
  migration (see the zod 4 entry).
- CI now runs `npm run test:coverage` (new script, `vitest run --coverage`)
  instead of `npm test`, so the coverage thresholds declared in
  `vitest.config.ts` (lines/functions/statements 85%, branches 80%) are
  actually enforced. Added `@vitest/coverage-v8` as a dev dependency, on the
  same `^4.1.12` range as `vitest` (it requires an exact-match `vitest` peer,
  so the two must be bumped together). `src/bin.ts` is excluded from unit
  coverage — it is exercised by the e2e suite. The lcov report is uploaded as
  a CI artifact from the Node 22 leg.
- Internal: shared schema module (`src/tools/schemas.ts`) replaces per-tool
  copies of the ID, pagination and time-range schemas; no behaviour change.
- Migrated from `zod` 3 to `zod` 4 (`^4.6.7`) and dropped the
  `zod-to-json-schema` dependency: tool input schemas are now generated with
  zod 4's native `z.toJSONSchema` (draft-07, input types, everything
  inlined). The `tools/list` output is semantically unchanged — same tools,
  descriptions, properties, `action` enums and `required` sets.
- Tool argument validation errors are now short, readable text instead of a
  JSON dump of zod issues, e.g.
  `Invalid arguments for airbrake_groups:\n✖ Invalid input: expected string, received number\n  → at group_id`.
  Clients that parsed the old JSON error array should match on the text
  instead.
- Tool results are now serialised as compact JSON (no indentation), cutting
  ~38% of the bytes of every response. Error texts are unchanged.
- `airbrake_notices` `list` now defaults to `per_page: 10` (was 50; max is
  still 200) since every notice carries a full backtrace/context/params.
  Pass `per_page` explicitly to get the old page size.
- **BREAKING:** write and destructive actions moved out of the resource
  tools into dedicated tools so that each tool's annotations are accurate.
  The HTTP requests sent are unchanged.
  - `airbrake_groups` `mute` / `unmute` / `resolve` / `unresolve` →
    `airbrake_groups_update` (same arguments).
  - `airbrake_groups` `delete` → `airbrake_delete` with `resource: "group"`.
  - `airbrake_sourcemaps` `delete` → `airbrake_delete` with
    `resource: "sourcemap"`.
  - `airbrake_deploys` `create` → `airbrake_deploys_create` (`project_id` +
    `deploy`, no `action`).
  - `airbrake_groups`, `airbrake_deploys` and `airbrake_sourcemaps` are now
    read-only; calling a removed action returns an error naming its
    replacement.
- The server now exposes 12 tools (was 8).

### Fixed

- **`AIRBRAKE_TIMEOUT_MS` now covers the response body.** The timeout was
  cleared as soon as response headers arrived, so a server that sent headers
  and then stalled mid-body hung the tool call forever. The deadline now
  spans the whole attempt (connect, headers and full body read) and the timer
  is cleared on every path. A timeout or connection failure while reading the
  body is reported as an `AirbrakeNetworkError` (previously an
  `AirbrakeApiError` carrying the HTTP status) that still names the status,
  and follows the same retry policy as any other network error (see the
  next entry). Timeout messages now state the
  duration, e.g. `request timed out after 15000ms` or
  `request timed out after 15000ms while reading the HTTP 200 response body`.
  The unread body of a 429/5xx response that is about to be retried is now
  cancelled, which releases its connection. The 25 MB body cap is unchanged
  and still surfaces as an `AirbrakeApiError`.
- **Duplicate side effects from retried non-idempotent requests.** The client
  retried every method on 5xx responses and network errors/timeouts, so a
  `POST` that the server had already processed (e.g. `airbrake_notify`,
  `airbrake_deploys` `create`, or a `POST` via `airbrake_request`) could be
  sent again, creating duplicate notices or deploy markers. A retried `DELETE`
  whose first response was lost would get a 404 and report failure for an
  operation that had succeeded. 5xx responses, dropped connections and
  timeouts (including `AIRBRAKE_TIMEOUT_MS`, and failures while reading the
  response body) are now retried only for `GET`,
  `HEAD` and `PUT`; `POST`, `PATCH` and `DELETE` fail immediately, with an
  error message noting that the request may have been applied. Requests the
  server never processed are still retried for every method:
  `429 Too Many Requests` (honouring `Retry-After`) and connection failures
  before anything was sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, undici's
  connect timeout, and `ENETUNREACH`/`EHOSTUNREACH`/`ETIMEDOUT` raised by
  `connect`). If the connection retries run out, the error says the request
  was not sent.
- `airbrake_groups` `get_stats` now matches Airbrake's documented contract:
  `time__lt` is optional (omitted from the request so Airbrake defaults it
  to now), and `time__gte` / `time__lt` accept Unix seconds (non-negative
  integer, as in the docs, or a digit-only string) as well as ISO 8601
  strings. Values are
  forwarded verbatim. Malformed timestamps (e.g. `"yesterday"`,
  `2026-02-30`), negative/fractional/millisecond numbers, and ranges where
  `time__gte >= time__lt` are rejected before any HTTP request (offset-less
  times are read as UTC for that check). Note: strings were previously
  forwarded unvalidated; anything that is not an ISO 8601 / RFC 3339 date
  or date-time is now rejected.
- List actions no longer throw when Airbrake answers with an empty body or
  204: the `null` payload is returned as-is.

### Security

- Raised the `@modelcontextprotocol/sdk` floor from `^1.0.0` to `^1.32.0`
  (lockfile: 1.29.0 → 1.32.2) and refreshed the lockfile via `npm audit fix`
  to remediate: `@modelcontextprotocol/sdk` (GHSA-6qxp-vccf-f47h,
  GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq,
  GHSA-f897-62hf-6gxq, GHSA-6prh-2h8m-c8cw — HTTP/OAuth transports, not
  used by this stdio-only server) and its transitive `@hono/node-server`,
  `hono`, `body-parser`, `proxy-addr`, `qs`, `fast-uri` and `ip-address`
  advisories; plus dev-toolchain advisories in `vitest`/`@vitest/mocker`
  (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8), `vite`, `postcss`,
  `source-map-js`, `nanoid`, `js-yaml`, `minimatch` and `brace-expansion`.
  The `vitest` floor is raised to `^4.1.12` (patched release). Still open:
  `picomatch` GHSA-fc5q-39xc-vjpf (dev-only, no upstream patch yet).
- Upgrading to `zod` 4.6.7 also remediates GHSA-mrhx-c7xc-m3w5 (memory
  exhaustion while validating oversized constrained collections, zod
  `<4.6.6`, high); its `audit-allowlist.json` entry is removed.

## [0.1.3] — 2026-06-04

### Security

- Bumped `vitest` from 2.1.9 to 4.1.0 (dev dependency) to remediate a
  critical advisory in the Vitest UI server (GHSA-5xrq-8626-4rwp) and the
  related moderate `esbuild`/`vite` advisories (GHSA-67mh-4wv8-2f99). This
  is a dev/CI toolchain change only — the published package has no runtime
  changes from 0.1.2.

## [0.1.2] — 2026-05-26

### Security

- **Path traversal in snowflake/UUID IDs.** The `group_id`, `notice_id`,
  `deploy_id`, and `sourcemap_id` schemas previously accepted any non-empty
  string. Combined with raw URL interpolation and `fetch`'s `..`-segment
  normalization, an LLM passing `group_id: "../../999"` on a destructive
  action could redirect the verb to an arbitrary URL path. IDs are now
  constrained to digits-only (`notice_uuid` to alphanumerics + hyphens).
- **Path traversal in `airbrake_request.path`.** The `startsWith('/api/')`
  guard was bypassable via `../` (raw or percent-encoded). The path schema
  now refuses any `..` segment after percent-decoding.
- **Header injection in `airbrake_request`.** A case-variant `Authorization`
  from user-supplied headers concatenated with the real bearer on the wire.
  User headers are now lowercased and the reserved set
  (`authorization`/`host`/`cookie`) is stripped before the canonical bearer
  is attached. Header values are also schema-rejected if they contain CR/LF.
- **Retry-After stall.** A server-supplied `Retry-After` of year-9999 parsed
  as ~253 trillion ms, hanging the MCP child indefinitely with the bearer
  token held in memory. Capped at 60 s.
- **Unbounded response body.** `await response.text()` had no size limit; a
  multi-GB body would OOM the process. Bodies are now streamed with a 25 MB
  cap (and pre-checked via `Content-Length` when present).
- **`AIRBRAKE_HOST` validation.** Previously accepted any string; a typo or
  attacker-controlled env could ship the bearer token to a non-HTTPS host.
  Now requires a parseable `http:`/`https:` URL; warns to stderr on `http:`.
- **Empty `AIRBRAKE_USER_TOKEN` warning.** Notify-only setups still work
  without the token, but `createServer` now writes a one-line stderr
  warning so misconfigured deployments surface the issue at startup
  rather than via silent 401s on every management call.
- **Numeric env guards.** `AIRBRAKE_TIMEOUT_MS` must be ≥ 1 and
  `AIRBRAKE_MAX_RETRIES` ≥ 0; previously accepted negatives that silently
  broke the client.

### Changed

- CI now runs `npm audit --audit-level=high` on every build. Dependabot
  configured for weekly npm and GitHub Actions updates (dev deps grouped).
- Reported server version (`name`/`version` in the MCP initialize response)
  now matches the package version.

## [0.1.1] — 2026-05-25

### Fixed

- README and CHANGELOG disclaimer now correctly say "Airbrake" (the
  company is named Airbrake, not "Airbrake Technologies"). No code
  changes; published version on npm now reflects the corrected wording.

## [0.1.0] — 2026-05-25

Initial public release. Eight resource-grouped tools cover what hosted Airbrake
actually exposes to Personal API tokens, plus a generic `airbrake_request`
escape hatch for any endpoint not directly modeled.

### Added

- `airbrake_projects` — `list`, `get`, `list_activities`
- `airbrake_groups` — `list` (with `environment`, `resolved`, `muted`, `archived`,
  `deploy_id`, `start_time`, `end_time`, `order`, `query` filters), `get`,
  `get_stats` (v5 time-series), `mute`, `unmute`, `resolve`, `unresolve`,
  `delete`
- `airbrake_notices` — `list` (with `version` filter), `get`, `get_status`
- `airbrake_deploys` — `list`, `get`, `create`
- `airbrake_performance` — `routes_stats`, `queries_stats` (requires `route`),
  `queues_stats` (requires `queue`)
- `airbrake_notify` — `notify` (v3 Notifier API, project-key auth)
- `airbrake_sourcemaps` — `list`, `get`, `delete`
- `airbrake_request` — escape hatch with `auth: 'none'` support, raw string
  bodies for multipart, arbitrary headers and query
- HTTP client: bearer + project-key auth, retries on 429 (honoring
  `Retry-After`, including HTTP-date format) and 5xx with equal-jitter
  exponential backoff, configurable timeouts
- `npm run validate` — spawns the built server, validates every tool's
  `inputSchema` against MCP/Claude constraints (top-level `type: "object"`,
  no top-level `anyOf`/`oneOf`/`allOf`)
- CI on Node 20 + 22: lint, typecheck, test, build, validate

### Notes

This is an **unofficial** project, not affiliated with or endorsed by
Airbrake. See the README "Coverage caveats" section for
endpoints that are documented by Airbrake but unreachable from Personal
API tokens (and therefore not modeled), and for endpoints we expose that
aren't in Airbrake's public docs (live-verified working on hosted
Airbrake but not part of the public contract).

[Unreleased]: https://github.com/francktrouillez/airbrake-mcp/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/francktrouillez/airbrake-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/francktrouillez/airbrake-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/francktrouillez/airbrake-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/francktrouillez/airbrake-mcp/releases/tag/v0.1.0
