/**
 * Transport-agnostic tool definitions.
 *
 * Nothing in this directory imports an MCP transport. server.ts turns these into
 * registered MCP tools; a future streamable-HTTP transport reuses them unchanged.
 */

import type { z, ZodRawShape } from "zod";
import type { Logger } from "../logger.js";
import type { RinggClient } from "../ringg/client.js";

export interface ToolContext {
  client: RinggClient;
  logger: Logger;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape; the MCP SDK derives the JSON Schema from this. */
  inputSchema: TShape;
  annotations?: ToolAnnotations;
  /** Returns any JSON-serializable value. server.ts handles wrapping and errors. */
  handler: (args: z.objectOutputType<TShape, z.ZodTypeAny>, ctx: ToolContext) => Promise<unknown>;
}

/** Identity helper that preserves the schema's inferred argument types. */
export function defineTool<TShape extends ZodRawShape>(def: ToolDefinition<TShape>): ToolDefinition<TShape> {
  return def;
}
