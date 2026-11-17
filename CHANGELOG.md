# Changelog

All notable changes to `airbrake-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- CI's dependency audit is now `scripts/audit.mjs` (`npm run audit:ci`) instead
  of `npm audit --audit-level=high`. It still fails on every high/critical
  advisory, except those with a reviewed entry in `audit-allowlist.json`. Each
  entry is scoped (`dev` entries can never cover a runtime finding), must name
  the reported package, carries a reason, and must expire within 180 days for
  `dev` or 90 for `runtime`. Expired and stale entries also fail. It audits
  the lockfile only, in its own CI job before any install; `release.yml` runs
  it before `npm ci`. Dev, optional and peer dependencies are always included.
  The two initial
  entries are `picomatch` GHSA-fc5q-39xc-vjpf (dev-only, no upstream fix;
  expires 2027-02-17) and `zod` GHSA-mrhx-c7xc-m3w5 (runtime; removed by the
  zod 4 migration; expires 2027-01-17).

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
  The `vitest` floor is raised to `^4.1.12` (patched release), and the `zod`
  floor to `^3.25.28` to match the SDK's `zod` peer range (`^3.25 || ^4.0`)
  and `zod-to-json-schema`'s (`^3.25.28 || ^4`). Still open: `zod` GHSA-mrhx-c7xc-m3w5 (fixed only in zod 4.6.6, tracked
  separately) and `picomatch` GHSA-fc5q-39xc-vjpf (dev-only, no upstream
  patch yet).

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
