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
| `AIRBRAKE_TIMEOUT_MS` | no | `15000` | Per-request timeout in ms (including the response body read); applies to each retry attempt |
| `AIRBRAKE_MAX_RETRIES` | no | `2` | Retries on 429 and failed connections (all methods), and on 5xx/network errors/timeouts for GET/HEAD/PUT only |

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
| `airbrake_groups` | `list`, `get`, `get_stats`, `mute`, `unmute`, `resolve`, `unresolve`, `delete` | `list` supports `environment`, `resolved`, `muted`, `archived`, `deploy_id`, `start_time`, `end_time`, `order`, `query`. `get_stats` (v5) requires `time__gte` and `period` (`minute`/`hour`; `day` is also accepted by the tool for backward compatibility but is not in Airbrake's public docs); `time__lt` is optional (Airbrake defaults it to now) and `limit` (1–1000, default 100) is optional. Times are Unix seconds (integer or digit string) or ISO 8601 strings, forwarded as given. `resolve`/`unresolve` follow the documented mute PUT convention; fall back to `airbrake_request` if your instance disagrees. |
| `airbrake_notices` | `list`, `get`, `get_status` | `list` and `get_status` are documented; `get` calls an undocumented endpoint that currently works on hosted Airbrake. |
| `airbrake_deploys` | `list`, `get`, `create` | All documented. |
| `airbrake_performance` | `routes_stats`, `queries_stats`, `queues_stats` | v5 APM. All actions require `time__gte`/`time__lt`/`period` (`minute`\|`hour`\|`day`). **`queries_stats` additionally requires a `route` filter** and **`queues_stats` additionally requires a `queue` filter** — the server returns 400 without them. The GET (read) side of these endpoints is not in Airbrake's public docs (which only show the PUT ingest side) but is live-verified working on hosted Airbrake. `routes-breakdowns` is intentionally not modeled (PUT-only SDK endpoint). |
| `airbrake_notify` | `notify` | Sends errors TO Airbrake (v3 Notifier API). |
| `airbrake_sourcemaps` | `list`, `get`, `delete`, `upload` | `upload` reads a local source map file and POSTs it as multipart/form-data — see [Source-map upload](#source-map-upload). |
| `airbrake_request` | `request` | Escape hatch for any endpoint. Supports `auth: 'none'` (project-key endpoints), raw string bodies (multipart), arbitrary headers and query. |

Tools return raw Airbrake JSON payloads with no field-stripping by default. List actions add a `_pagination` metadata object so the model can iterate pages.

### Keeping responses small

Every tool result is serialised as **compact JSON** (no indentation or newlines) — whitespace costs tokens and carries no information for the model.

**`airbrake_notices` `list` defaults to `per_page: 10`** (max 200) because each notice carries a full backtrace, context, environment, session and params. All other list actions default to 50.

Every list-type action (`airbrake_projects` `list` / `list_activities`, `airbrake_groups` `list`, `airbrake_notices` `list`, `airbrake_deploys` `list`, `airbrake_sourcemaps` `list`) accepts an optional **`fields`** array (1–50 non-empty key names). When given, each object in every top-level array of the payload (`groups`, `notices`, `deploys`, …) is reduced to just those top-level keys; missing keys are omitted. Non-array properties such as `count` and `_pagination` are kept as-is. Without `fields`, the payload is returned unchanged.

```json
{ "action": "list", "project_id": 123, "fields": ["id", "errors", "noticeCount", "lastNoticeAt"] }
```

For a realistic page of notices (~30-frame backtraces plus context/params), the result text drops from ~768 KB (pretty-printed, 50 per page — the previous behaviour) to ~95 KB (compact, 10 per page) and ~7 KB with `fields: ["id", "createdAt", "context"]`.

### ID precision — strings only for snowflakes

Airbrake's group/notice/deploy/sourcemap IDs are **19-digit snowflakes** that exceed `Number.MAX_SAFE_INTEGER`. **They MUST be passed as strings**, otherwise JSON parsing (in both the LLM tool-call layer and our zod schema) silently rounds the last 3–5 digits to zero and the lookup 404s.

The schemas reject numeric IDs explicitly; you'll see a clear zod error if you try. Project IDs are small integers and can be passed as numbers as usual.

### Source-map upload

```json
{
  "action": "upload",
  "project_id": 123,
  "file_path": "/abs/path/to/dist/app.min.js.map",
  "name": "https://cdn.example.com/app.min.js",
  "pattern": "%/app.min.js"
}
```

`name` is the minified file URL (or name) the map applies to; `pattern` is an optional SQL `LIKE` pattern matching minified file URLs. The server reads the file itself and builds the multipart request (`file`, `name`, `pattern` parts) — no hand-built multipart body is needed.

Because this action reads a file from the machine running the MCP server and sends it to the Airbrake host, it is locked down so a prompt-injected model cannot use it to exfiltrate arbitrary files. All of the following are enforced **before any HTTP request is made**:

- `file_path` must be absolute and its own file name must end in `.map` (case-insensitive). This is checked before the filesystem is touched, so the tool cannot be used to probe whether arbitrary files exist; missing and unreadable paths get the same error. On Windows, network (UNC, `\\host\share`) and device (`\\?\`, `\\.\`) paths are rejected outright, since merely resolving a UNC path sends the user's NTLM credentials to that host.
- It must resolve (via `realpath`, following every symlink) to a **regular file** — directories, devices, FIFOs and sockets are rejected — whose **resolved** name also ends in `.map`. A symlink `bundle.js.map → ~/.ssh/id_rsa` is rejected.
- The file must be at most **50 MiB**, checked via `lstat` before it is read. The open handle is re-checked (same inode, still within the cap) so a file swapped after the check is not read.
- The content must parse as JSON and look like a **source map v3**: `version === 3`, `mappings` is a string, and `sources` (if present) is an array of strings or `null`s. Index maps (`sections`) are not accepted. This content check is also what stops a hard link named `*.map` that points at a secret.
- `name` and `pattern` are trimmed, then must be non-empty, at most 2048 characters, and contain no CR/LF.

Rejection messages never include the resolved target path or any file content.

Each upload attempt gets at least 55 s (or `AIRBRAKE_TIMEOUT_MS`, if larger) — long enough for large maps, while a single attempt stays under the 60 s default request timeout of MCP SDK clients. Because POST is not idempotent, an upload is **not** retried after a network error, a timeout, or any 5xx (Airbrake may already have stored it); only 429 and connection failures before anything was sent are retried, per `AIRBRAKE_MAX_RETRIES`. After an ambiguous failure the error says so — check with `list` before uploading again.

### Pagination params

Airbrake accepts both `limit` and `per_page` on list endpoints. This MCP standardizes on `page` + `per_page` for consistency across all list actions.

List actions add a `_pagination` object so the model knows whether to fetch another page without doing arithmetic:

| Field                  | When present                               | Meaning                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`, `per_page`     | always                                     | The page that was requested.                                                                                                                                                                                      |
| `count`                | Airbrake returned a numeric `count`        | Total reported by Airbrake (passed through unchanged).                                                                                                                                                            |
| `has_more`             | `count` present, or the payload has a list | `true` if another page exists. With `count`, it compares the items actually served so far, `(page - 1) * per_page + list.length`, against `count`, so a page Airbrake capped below `per_page` still reports more. |
| `next_page`            | only when `has_more` is `true`             | `page + 1` — pass it as `page` on the next call.                                                                                                                                                                  |
| `total_pages`          | `count` present                            | `ceil(count / per_page)` (`0` when `count` is `0`). Assumes Airbrake honoured the requested `per_page`.                                                                                                           |
| `has_more_is_estimate` | `count` absent and the payload has a list  | `true`: `has_more` was inferred from the first list in the payload (`length >= per_page`), so a full last page may yield one empty follow-up page.                                                                |

If Airbrake returns neither `count` nor a list, `has_more`/`next_page` are omitted rather than guessed. `has_more` errs towards one extra (possibly empty) fetch rather than skipping pages; stop when it is `false`.

### Coverage caveats

- **Project updates are not exposed.** The `PUT /api/v4/projects/:id` endpoint requires dashboard-session credentials (cookies + CSRF), not Personal API tokens, and returns 401 from every token shape we tested. Use the Airbrake dashboard to change project settings.
- **`airbrake_notices.get`** calls an undocumented endpoint. It works on hosted Airbrake today but is not part of the public contract — may break or differ on self-hosted instances and Errbit.
- **Source-map upload auth.** Airbrake's docs list project-key or user-key auth for `POST /api/v4/projects/:pid/sourcemaps`; `airbrake_sourcemaps` `upload` sends the same `Authorization: Bearer <AIRBRAKE_USER_TOKEN>` as every other management call.
- **`POST /api/v3/projects/:pid/ios-reports`** (iOS crash reports) requires `?key=PROJECT_KEY` and no `Authorization` header. Call via `airbrake_request` with `auth: 'none'` and pass the project key in `query`.
- **APM write endpoints** (`PUT /api/v5/.../routes-stats` etc.) are SDK-internal; not modeled, but reachable via the escape hatch.
- **What this MCP intentionally doesn't model:** the Airbrake dashboard exposes endpoints for comments, bookmarks, iframes, personal tokens, project stats, and a cross-project `/api/v4/groups` listing — these all returned 404/401 against hosted Airbrake from a User API token. They were modeled in earlier versions and removed. If your instance does support them, reach for `airbrake_request`.

## Development

```bash
npm install
npm test                 # vitest, 80 tests
npm run test:coverage    # vitest with v8 coverage; fails below the thresholds in vitest.config.ts
npm run typecheck
npm run lint
npm run build            # emits dist/
npm run validate         # spawns the built server, checks tool schemas (expects 8 tools)
npm run test:e2e         # builds, then drives dist/bin.js over stdio against a local mock Airbrake
npm run dev              # tsx src/bin.ts (for local stdio testing)
npm run audit:ci         # dependency audit gate (what CI runs)
```

### Dependency audit

CI runs `node scripts/audit.mjs` (also available as `npm run audit:ci`) instead of a bare `npm audit`. It audits `package-lock.json` only (`--package-lock-only`), so it runs in its own job **before** any install, and no dependency's install script can tamper with it. Dev, optional and peer dependencies are always included, whatever `NODE_ENV` or `.npmrc` says.

It fails on any **high or critical** advisory unless [`audit-allowlist.json`](audit-allowlist.json) has a matching entry, and each entry has to justify itself:

- **`scope`** is `dev` or `runtime`. A `dev` entry only covers an advisory that is absent from the shipped tree (`npm audit --omit=dev`), so a dev-tooling exception can never hide a vulnerability users install. `runtime` entries should be rare and short-lived.
- **`package`** must name the package npm reports the advisory against, and only covers it if that's the *only* package hit. The GHSA id alone isn't enough, so a mislabeled entry can't get waved through in review.
- **`reason`** says why it's acceptable for now, and what removes it.
- **`expires`** (`YYYY-MM-DD`): the gate fails after that date, and also when the date is more than **180 days** out for `dev` or **90 days** for `runtime`. Nothing can be waved through indefinitely.
- **Stale entries fail too.** Once an entry covers nothing, because the advisory was fixed upstream or the dependency was bumped, the gate asks for it to be removed. The list can only shrink back to empty.

If npm's report format ever changes such that a high/critical package can't be matched to an advisory, the gate errors (exit 2) instead of reading it as a clean tree.

Moderate and low advisories don't block CI. Check `npm audit` locally from time to time.

## Contributing

Issues and pull requests welcome at <https://github.com/francktrouillez/airbrake-mcp/issues>.

Bug reports are most useful with: the action you called, the params (with secrets redacted), the response, and the Airbrake instance type (hosted `api.airbrake.io` vs self-hosted vs Errbit).

## License

MIT
