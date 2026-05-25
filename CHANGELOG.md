# Changelog

All notable changes to `airbrake-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/francktrouillez/airbrake-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/francktrouillez/airbrake-mcp/releases/tag/v0.1.0
