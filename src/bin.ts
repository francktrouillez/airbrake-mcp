#!/usr/bin/env node
import { startStdioServer } from './server.js';

startStdioServer().catch((err) => {
  process.stderr.write(
    `airbrake-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
