import { deleteTool } from './delete.js';
import { deploysCreateTool } from './deploys-create.js';
import { deploysTool } from './deploys.js';
import { groupsUpdateTool } from './groups-update.js';
import { groupsTool } from './groups.js';
import { noticesTool } from './notices.js';
import { notifyTool } from './notify.js';
import { performanceTool } from './performance.js';
import { projectsTool } from './projects.js';
import { requestReadOnlyTool, requestTool } from './request.js';
import { sourcemapsUploadTool } from './sourcemaps-upload.js';
import { sourcemapsTool } from './sourcemaps.js';
import type { ToolDefinition } from './types.js';

// Tools are split by side effect so each carries accurate MCP annotations:
// read-only resource tools, then the narrowly-scoped writes next to the
// resource they touch, then the destructive / arbitrary-method ones.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allTools: ToolDefinition<any>[] = [
  projectsTool,
  groupsTool,
  groupsUpdateTool,
  noticesTool,
  deploysTool,
  deploysCreateTool,
  performanceTool,
  notifyTool,
  sourcemapsTool,
  sourcemapsUploadTool,
  deleteTool,
  requestTool,
];

// AIRBRAKE_READ_ONLY surface: every tool annotated read-only, plus the
// GET-only airbrake_request in place of the full one (it is last in both).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readOnlyTools: ToolDefinition<any>[] = [
  ...allTools.filter((t) => t.annotations.readOnlyHint),
  requestReadOnlyTool,
];
