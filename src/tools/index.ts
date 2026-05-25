import { deploysTool } from './deploys.js';
import { groupsTool } from './groups.js';
import { noticesTool } from './notices.js';
import { notifyTool } from './notify.js';
import { performanceTool } from './performance.js';
import { projectsTool } from './projects.js';
import { requestTool } from './request.js';
import { sourcemapsTool } from './sourcemaps.js';
import type { ToolDefinition } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allTools: ToolDefinition<any>[] = [
  projectsTool,
  groupsTool,
  noticesTool,
  deploysTool,
  performanceTool,
  notifyTool,
  sourcemapsTool,
  requestTool,
];
