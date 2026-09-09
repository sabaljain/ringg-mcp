import { z } from "zod";
import { editAgent, getAgentRaw, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggShapeError } from "../../ringg/errors.js";
import { readVersionField } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const updateAnalyticsContextTool = defineTool({
  name: "update_analytics_context",
  title: "Update analytics context",
  description:
    "Control what extra material the two analytics passes receive. Today the one documented switch " +
    "is whether tool call logs are included, set separately for platform analytics and client " +
    "analytics. The platform deep-merges this, so a switch you do not mention keeps its current " +
    "value. Turning logs on gives the analyser visibility into which tools ran during a call.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    platform_tool_call_logs: z
      .boolean()
      .optional()
      .describe("Include tool call logs in platform analytics."),
    client_tool_call_logs: z
      .boolean()
      .optional()
      .describe("Include tool call logs in client analytics."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe("Target a specific agent version. Defaults to the version the current config was read from."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const payload: Record<string, unknown> = {};
    if (args.platform_tool_call_logs !== undefined) {
      payload.platform_analytics = { tool_call_logs: args.platform_tool_call_logs };
    }
    if (args.client_tool_call_logs !== undefined) {
      payload.client_analytics = { tool_call_logs: args.client_tool_call_logs };
    }
    if (Object.keys(payload).length === 0) {
      throw new RinggShapeError(
        "Supply at least one of platform_tool_call_logs or client_tool_call_logs.",
      );
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const current = readVersionField(agent, "analytics_context");
    const versionId = args.version_id ?? resolveWriteVersionId(agent);

    const response = await editAgent(
      client,
      "edit_analytics_context",
      args.agent_id,
      { analytics_context: payload },
      { versionId },
    );

    const after = readVersionField(await getAgentRaw(client, args.agent_id), "analytics_context");

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      read_from: current.source,
      sent: payload,
      before: current.value ?? null,
      after: after.value ?? null,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
