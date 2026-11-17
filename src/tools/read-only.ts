import type { ToolHints } from './types.js';

/**
 * Hints for a tool that only reads from Airbrake. destructive/idempotent are
 * set explicitly (false/true) even though the spec ignores them when
 * readOnlyHint is true, so naive clients never see the "destructive" default.
 */
export const READ_ONLY_HINTS: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const READ_ONLY_DISABLED_SUFFIX = 'is disabled: AIRBRAKE_READ_ONLY is set';

export const READ_ONLY_NOTICE =
  'airbrake-mcp: read-only mode enabled (AIRBRAKE_READ_ONLY) — write/destructive tools are disabled and airbrake_request is GET-only\n';
