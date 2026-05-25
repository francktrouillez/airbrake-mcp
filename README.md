# airbrake-mcp

[![CI](https://github.com/francktrouillez/airbrake-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/francktrouillez/airbrake-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/airbrake-mcp.svg)](https://www.npmjs.com/package/airbrake-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

An MCP (Model Context Protocol) server that exposes the Airbrake public API to LLM clients. Works with any MCP-compatible client (Claude Desktop, Claude Code, Cursor, Cline, Codex CLI, Continue.dev, etc.).

Eight resource-grouped tools cover what hosted Airbrake actually exposes (projects, error groups, notices, deploys, v5 APM, source maps, the v3 Notifier), plus a generic `airbrake_request` escape hatch for endpoints not directly modeled — including project-key endpoints and multipart uploads.

**Unofficial. Not affiliated with or endorsed by Airbrake.**

## Install

### Claude Code (one-liner)

```bash
claude mcp add airbrake --scope user \
  --env AIRBRAKE_USER_TOKEN=YOUR_TOKEN \
  -- npx -y airbrake-mcp
```

Restart Claude Code and the `airbrake_*` tools become available.

### Other clients

See [MCP client config](#mcp-client-config) below for Claude Desktop, Cursor, Cline, Codex CLI, and Continue.dev. (One-liner installers per client are documented as they ship — until then the JSON config block in that section is identical across all clients; only the file location changes.)

### Run the binary directly (optional)

The server is normally spawned by your MCP client over stdio. To test it stand-alone:

```bash
AIRBRAKE_USER_TOKEN=your_token npx airbrake-mcp
```

It will wait for JSON-RPC messages on stdin. Useful for debugging the install only.

## Configuration

All configuration is via environment variables.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `AIRBRAKE_USER_TOKEN` | yes (except for notify-only setups) | — | Bearer token for the management API |
| `AIRBRAKE_PROJECT_KEYS` | only for `airbrake_notify` | — | JSON map `{"123":"notifier_key"}` |
| `AIRBRAKE_HOST` | no | `https://api.airbrake.io` | Override for self-hosted Airbrake or Errbit |
| `AIRBRAKE_TIMEOUT_MS` | no | `15000` | Per-request timeout |
| `AIRBRAKE_MAX_RETRIES` | no | `2` | Retries on 429 and 5xx |

Get a User API token from Airbrake → User Settings → Personal API tokens.

## MCP client config

The MCP entry below is the same for every MCP client — only the config file location differs.

```json
{
  "mcpServers": {
    "airbrake": {
      "command": "npx",
      "args": ["-y", "airbrake-mcp"],
      "env": {
        "AIRBRAKE_USER_TOKEN": "your_user_token_here"
      }
    }
  }
}
```

Where to put it, by client:

| Client | Location |
|---|---|
| **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Code** | `~/.claude.json` — or use `claude mcp add airbrake --scope user --env AIRBRAKE_USER_TOKEN=… -- npx -y airbrake-mcp` |
| **Cursor** | `.cursor/mcp.json` (per-project) or `~/.cursor/mcp.json` (user-wide) |
| **Cline (VS Code)** | VS Code Settings → Cline → MCP servers (UI), or `cline_mcp_settings.json` |
| **Codex CLI** | `~/.codex/config.json` under `mcpServers` |
| **Continue.dev** | `.continue/config.json` under `experimental.modelContextProtocolServers` |

To enable the notifier (sending errors TO Airbrake), add the project keys map:

```json
{
  "mcpServers": {
    "airbrake": {
      "command": "npx",
      "args": ["-y", "airbrake-mcp"],
      "env": {
        "AIRBRAKE_USER_TOKEN": "your_user_token_here",
        "AIRBRAKE_PROJECT_KEYS": "{\"123\":\"notifier_key_abc\"}"
      }
    }
  }
}
```

## Tools

| Tool | Actions | Notes |
|---|---|---|
| `airbrake_projects` | `list`, `get`, `list_activities` | Project updates are not modeled — see the caveat below. |
| `airbrake_groups` | `list`, `get`, `get_stats`, `mute`, `unmute`, `resolve`, `unresolve`, `delete` | `list` supports `environment`, `resolved`, `muted`, `archived`, `deploy_id`, `start_time`, `end_time`, `order`, `query`. `get_stats` (v5) requires `time__gte`/`time__lt`/`period`. `resolve`/`unresolve` follow the documented mute PUT convention; fall back to `airbrake_request` if your instance disagrees. |
| `airbrake_notices` | `list`, `get`, `get_status` | `list` and `get_status` are documented; `get` calls an undocumented endpoint that currently works on hosted Airbrake. |
| `airbrake_deploys` | `list`, `get`, `create` | All documented. |
| `airbrake_performance` | `routes_stats`, `queries_stats`, `queues_stats` | v5 APM. All actions require `time__gte`/`time__lt`/`period` (`minute`\|`hour`\|`day`). **`queries_stats` additionally requires a `route` filter** and **`queues_stats` additionally requires a `queue` filter** — the server returns 400 without them. The GET (read) side of these endpoints is not in Airbrake's public docs (which only show the PUT ingest side) but is live-verified working on hosted Airbrake. `routes-breakdowns` is intentionally not modeled (PUT-only SDK endpoint). |
| `airbrake_notify` | `notify` | Sends errors TO Airbrake (v3 Notifier API). |
| `airbrake_sourcemaps` | `list`, `get`, `delete` | Upload is multipart/form-data — use `airbrake_request` with a pre-formed multipart body. |
| `airbrake_request` | `request` | Escape hatch for any endpoint. Supports `auth: 'none'` (project-key endpoints), raw string bodies (multipart), arbitrary headers and query. |

Tools return raw Airbrake JSON payloads with no field-stripping. List actions add a `_pagination` metadata object so the model can iterate pages.

### ID precision — strings only for snowflakes

Airbrake's group/notice/deploy/sourcemap IDs are **19-digit snowflakes** that exceed `Number.MAX_SAFE_INTEGER`. **They MUST be passed as strings**, otherwise JSON parsing (in both the LLM tool-call layer and our zod schema) silently rounds the last 3–5 digits to zero and the lookup 404s.

The schemas reject numeric IDs explicitly; you'll see a clear zod error if you try. Project IDs are small integers and can be passed as numbers as usual.

### Pagination params

Airbrake accepts both `limit` and `per_page` on list endpoints. This MCP standardizes on `page` + `per_page` for consistency across all list actions.

### Coverage caveats

- **Project updates are not exposed.** The `PUT /api/v4/projects/:id` endpoint requires dashboard-session credentials (cookies + CSRF), not Personal API tokens, and returns 401 from every token shape we tested. Use the Airbrake dashboard to change project settings.
- **`airbrake_notices.get`** calls an undocumented endpoint. It works on hosted Airbrake today but is not part of the public contract — may break or differ on self-hosted instances and Errbit.
- **Source-map upload (`POST /api/v4/projects/:pid/sourcemaps`)** requires multipart/form-data. The escape hatch supports it via raw string body + a `Content-Type: multipart/form-data; boundary=…` header; constructing the multipart body is the caller's responsibility.
- **`POST /api/v3/projects/:pid/ios-reports`** (iOS crash reports) requires `?key=PROJECT_KEY` and no `Authorization` header. Call via `airbrake_request` with `auth: 'none'` and pass the project key in `query`.
- **APM write endpoints** (`PUT /api/v5/.../routes-stats` etc.) are SDK-internal; not modeled, but reachable via the escape hatch.
- **What this MCP intentionally doesn't model:** the Airbrake dashboard exposes endpoints for comments, bookmarks, iframes, personal tokens, project stats, and a cross-project `/api/v4/groups` listing — these all returned 404/401 against hosted Airbrake from a User API token. They were modeled in earlier versions and removed. If your instance does support them, reach for `airbrake_request`.

## Development

```bash
npm install
npm test                 # vitest, 80 tests
npm run typecheck
npm run lint
npm run build            # emits dist/
npm run validate         # spawns the built server, checks tool schemas (expects 8 tools)
npm run dev              # tsx src/bin.ts (for local stdio testing)
```

## Contributing

Issues and pull requests welcome at <https://github.com/francktrouillez/airbrake-mcp/issues>.

Bug reports are most useful with: the action you called, the params (with secrets redacted), the response, and the Airbrake instance type (hosted `api.airbrake.io` vs self-hosted vs Errbit).

## License

MIT
