/**
 * The single source of truth for which tools this server exposes.
 *
 * Scope is fixed and deliberate. Nothing here dials a phone: there are no tools for
 * individual calls, campaigns, or call termination. Knowledge bases are read and
 * attached/detached only - never created, edited, or deleted. Number provisioning,
 * telephony config, and workspace user management are all out of scope.
 *
 * Writes cover agent configuration, post-call analysis, and A/B versions. The flow-graph
 * operations (docs/edit-agent-api.md sections 4.6-4.8) are deliberately absent: they need
 * the node graph read back to be usable, and GET /agent/{id} does not return it.
 *
 * transcribe_audio is the one tool that reaches a second service: Ringg's speech-to-text,
 * on the same workspace key. It transcribes a file and changes nothing in the workspace.
 * Real-time (WebSocket) transcription is not exposed - a tool call has no live audio to
 * stream, and the REST endpoint covers recordings.
 */

import { addAbVersionTool } from "./agents/add-ab-version.js";
import { attachKnowledgeBaseTool } from "./agents/attach-knowledge-base.js";
import { detachKnowledgeBaseTool } from "./agents/detach-knowledge-base.js";
import { getAgentTool } from "./agents/get-agent.js";
import { listAgentsTool } from "./agents/list-agents.js";
import { toggleAbTestingTool } from "./agents/toggle-ab-testing.js";
import { updateAgentDisplayNameTool } from "./agents/update-agent-display-name.js";
import { updateAgentPromptTool } from "./agents/update-agent-prompt.js";
import { updateAnalyticsContextTool } from "./agents/update-analytics-context.js";
import { updateClassificationLabelsTool } from "./agents/update-classification-labels.js";
import { updateClientAnalysisTool } from "./agents/update-client-analysis.js";
import { updateCustomAnalysisPromptTool } from "./agents/update-custom-analysis-prompt.js";
import { updateCustomVariablesTool } from "./agents/update-custom-variables.js";
import { updateIntroMessageTool } from "./agents/update-intro-message.js";
import { updateTrafficSplitTool } from "./agents/update-traffic-split.js";
import { getCallTool } from "./calls/get-call.js";
import { listCallsTool } from "./calls/list-calls.js";
import { getKnowledgeBaseTool } from "./kb/get-knowledge-base.js";
import { listKnowledgeBasesTool } from "./kb/list-knowledge-bases.js";
import { transcribeAudioTool } from "./stt/transcribe-audio.js";
import type { ToolDefinition } from "./types.js";

export const allTools: ToolDefinition<any>[] = [
  // Read
  listAgentsTool,
  getAgentTool,
  listKnowledgeBasesTool,
  getKnowledgeBaseTool,
  listCallsTool,
  getCallTool,
  // Speech-to-text
  transcribeAudioTool,
  // Write - agent configuration
  updateAgentPromptTool,
  updateIntroMessageTool,
  updateCustomVariablesTool,
  updateAgentDisplayNameTool,
  // Write - knowledge bases
  attachKnowledgeBaseTool,
  detachKnowledgeBaseTool,
  // Write - post-call analysis
  updateCustomAnalysisPromptTool,
  updateClientAnalysisTool,
  updateClassificationLabelsTool,
  updateAnalyticsContextTool,
  // Write - A/B versions
  addAbVersionTool,
  updateTrafficSplitTool,
  toggleAbTestingTool,
];

export const TOOL_NAMES = allTools.map((t) => t.name);
