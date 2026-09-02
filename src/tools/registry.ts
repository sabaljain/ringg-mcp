/**
 * The single source of truth for which tools this server exposes.
 *
 * Scope is fixed and deliberate. Nothing here dials a phone: there are no tools for
 * individual calls, campaigns, or call termination. Knowledge bases are read and
 * attached/detached only - never created, edited, or deleted. Number provisioning,
 * telephony config, analytics, and workspace user management are all out of scope.
 */

import { attachKnowledgeBaseTool } from "./agents/attach-knowledge-base.js";
import { detachKnowledgeBaseTool } from "./agents/detach-knowledge-base.js";
import { getAgentTool } from "./agents/get-agent.js";
import { listAgentsTool } from "./agents/list-agents.js";
import { updateAgentPromptTool } from "./agents/update-agent-prompt.js";
import { updateCustomVariablesTool } from "./agents/update-custom-variables.js";
import { getCallTool } from "./calls/get-call.js";
import { listCallsTool } from "./calls/list-calls.js";
import { getKnowledgeBaseTool } from "./kb/get-knowledge-base.js";
import { listKnowledgeBasesTool } from "./kb/list-knowledge-bases.js";
import type { ToolDefinition } from "./types.js";

export const allTools: ToolDefinition<any>[] = [
  // Read
  listAgentsTool,
  getAgentTool,
  listKnowledgeBasesTool,
  getKnowledgeBaseTool,
  listCallsTool,
  getCallTool,
  // Write
  updateAgentPromptTool,
  updateCustomVariablesTool,
  attachKnowledgeBaseTool,
  detachKnowledgeBaseTool,
];

export const TOOL_NAMES = allTools.map((t) => t.name);
