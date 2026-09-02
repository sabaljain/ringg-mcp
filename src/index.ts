#!/usr/bin/env node
/**
 * ringg-mcp entrypoint.
 *
 * Launched as a subprocess by Claude Code over stdio. To add a streamable-HTTP
 * transport later, add src/transports/http.ts and a second entrypoint that calls
 * createServer() from src/server.ts - nothing in src/tools/ or src/ringg/ changes.
 */

import { runStdioServer } from "./transports/stdio.js";

runStdioServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ringg-mcp: fatal: ${message}\n`);
  process.exit(1);
});
