/**
 * Builds the MCP server from the tool registry.
 *
 * TRANSPORT-AGNOSTIC BY DESIGN. This module must never import a transport. It returns
 * an unconnected McpServer; the caller attaches stdio (today) or streamable HTTP (later).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { RinggClient } from "./ringg/client.js";
import { toUserMessage } from "./ringg/errors.js";
import { allTools } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";

export const SERVER_NAME = "ringg-mcp";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  config: Config;
  logger?: Logger;
  /** Injectable for tests and for a future HTTP transport. */
  client?: RinggClient;
}

export interface CreatedServer {
  server: McpServer;
  client: RinggClient;
  logger: Logger;
}

export function createServer(options: CreateServerOptions): CreatedServer {
  const logger = options.logger ?? createLogger(options.config.logLevel);
  const client = options.client ?? new RinggClient(options.config, logger);
  const ctx: ToolContext = { client, logger };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the Ringg AI voice agent platform. Read agents, knowledge bases and call " +
        "history; edit agent prompts, custom variables and knowledge base attachments; " +
        "transcribe audio with Ringg's Parrot speech-to-text. " +
        "This server cannot place, schedule or terminate calls, and cannot create or delete " +
        "knowledge bases. Writes replace data upstream, so prefer get_agent before and after " +
        "any update to confirm the effect.",
    },
  );

  for (const tool of allTools) {
    // The registry is heterogeneous (each tool has its own Zod shape), so the SDK's
    // per-tool generic inference cannot apply here. The cast is confined to this call;
    // each tool's own arguments stay fully typed via defineTool().
    const register = server.registerTool.bind(server) as (
      name: string,
      config: unknown,
      cb: (args: unknown) => Promise<unknown>,
    ) => unknown;

    register(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        const started = Date.now();
        try {
          const result = await tool.handler(args as never, ctx);
          logger.debug("tool ok", { tool: tool.name, ms: Date.now() - started });
          return {
            content: [{ type: "text" as const, text: stringify(result) }],
          };
        } catch (err) {
          const message = toUserMessage(err);
          logger.error("tool failed", { tool: tool.name, ms: Date.now() - started, message });
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      },
    );
  }

  logger.debug("registered tools", { count: allTools.length, names: allTools.map((t) => t.name) });
  return { server, client, logger };
}

function stringify(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return String(value);
  }
}
