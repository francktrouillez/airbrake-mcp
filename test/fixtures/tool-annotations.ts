// The intended side-effect classification of every tool, shared by the unit
// and e2e suites so both assert against one source of truth. Changing a row
// here is a deliberate, reviewable decision — clients use these hints to
// decide what to auto-approve and what to flag.

import type { ToolHints } from '../../src/tools/types.js';

// The values are spelled out here, not imported, so a change in src/ must be
// mirrored deliberately.
export type ExpectedAnnotations = ToolHints;

const READ: ExpectedAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Normal mode: every tool, in `tools/list` order. */
export const EXPECTED_ANNOTATIONS: Record<string, ExpectedAnnotations> = {
  airbrake_projects: READ,
  airbrake_groups: READ,
  airbrake_groups_update: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  airbrake_notices: READ,
  airbrake_deploys: READ,
  airbrake_deploys_create: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  airbrake_performance: READ,
  airbrake_notify: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  airbrake_sourcemaps: READ,
  airbrake_sourcemaps_upload: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  airbrake_delete: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  airbrake_request: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** AIRBRAKE_READ_ONLY mode: only these tools are listed. */
export const EXPECTED_READ_ONLY_ANNOTATIONS: Record<string, ExpectedAnnotations> = {
  airbrake_projects: READ,
  airbrake_groups: READ,
  airbrake_notices: READ,
  airbrake_deploys: READ,
  airbrake_performance: READ,
  airbrake_sourcemaps: READ,
  // GET-only escape hatch.
  airbrake_request: READ,
};

/** Tools hidden (and refused) when AIRBRAKE_READ_ONLY is set. */
export const WRITE_TOOLS: readonly string[] = Object.keys(EXPECTED_ANNOTATIONS).filter(
  (name) => !(name in EXPECTED_READ_ONLY_ANNOTATIONS),
);

/** A valid call for each write tool (project 42), used to prove refusal. */
export const WRITE_CALLS: Record<string, Record<string, unknown>> = {
  airbrake_groups_update: { action: 'mute', project_id: 42, group_id: '3741526488590376432' },
  airbrake_deploys_create: { project_id: 42, deploy: { environment: 'production' } },
  airbrake_notify: {
    action: 'notify',
    project_id: 42,
    payload: { errors: [{ type: 'Error', message: 'boom', backtrace: [] }] },
  },
  // Refused before the file is read, so the path need not exist.
  airbrake_sourcemaps_upload: {
    project_id: 42,
    file_path: '/nonexistent/app.js.map',
    name: 'a.js',
  },
  airbrake_delete: { resource: 'group', project_id: 42, group_id: '3741526488590376432' },
};
