import { z } from "zod";
import {
  editAgent,
  getAgentRaw,
  hasSplitConfig,
  resolveWriteVersionId,
  type ConfigType,
} from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import { looksLikeHtml, readVersionField } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const updateIntroMessageTool = defineTool({
  name: "update_intro_message",
  title: "Update agent intro message",
  description:
    "Set the first thing the agent says when a call connects. The message replaces the existing " +
    "one outright - there is no merge, because it is a single string. " +
    "Reference custom variables with Jinja, e.g. 'Hi {{callee_name}}, calling from Acme.' The " +
    "platform validates the Jinja syntax and rejects a malformed template. " +
    "Note that the dashboard stores this as rich text: an intro written there arrives as HTML and " +
    "may contain variable 'mention' markup. Writing through this tool replaces it with plain text, " +
    "so the chips shown in the dashboard editor become ordinary text. The variable references " +
    "themselves keep working. Call get_agent first to see the current message.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    intro_message: z
      .string()
      .min(1)
      .describe("The new intro message. Plain text; use {{variable_name}} for custom variables."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Target a specific agent version. Defaults to the version this tool read the current " +
          "message from. Only worth setting for an A/B agent; see get_agent for the ids.",
      ),
    config_type: z
      .enum(["outbound", "inbound"])
      .optional()
      .describe(
        "Only for agents whose agent_type is 'outbound_inbound'. 'inbound' writes the agent's " +
          "separate inbound intro message instead of the outbound one. Ignored by other agent types.",
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agent = await getAgentRaw(client, args.agent_id);
    const current = readVersionField(agent, "intro_message");
    const versionId = args.version_id ?? resolveWriteVersionId(agent);

    const warnings: string[] = [];
    if (looksLikeHtml(current.value)) {
      warnings.push(
        "The existing intro message is HTML from the dashboard's rich-text editor. This write " +
          "replaces it with plain text, so any variable 'mention' formatting is flattened. The " +
          "variables still interpolate; only the editor's chip rendering is lost.",
      );
    }
    if (args.config_type && !hasSplitConfig(agent)) {
      warnings.push(
        `config_type='${args.config_type}' was ignored: it only applies to agents whose agent_type ` +
          `is 'outbound_inbound' (this one is '${agent.agent_type ?? "unknown"}').`,
      );
    }

    let response: unknown;
    try {
      response = await editAgent(
        client,
        "edit_intro_message",
        args.agent_id,
        { intro_message: args.intro_message },
        { versionId, configType: args.config_type as ConfigType | undefined },
      );
    } catch (err) {
      if (err instanceof RinggApiError && err.status === 400 && /jinja|template|syntax/i.test(err.message)) {
        throw new RinggShapeError(
          `Ringg rejected the intro message as an invalid Jinja template, so nothing was written: ${err.message} ` +
            "Check for an unclosed {{ ... }} or {% ... %}.",
        );
      }
      throw err;
    }

    const after = readVersionField(await getAgentRaw(client, args.agent_id), "intro_message");

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      config_type: args.config_type,
      read_from: current.source,
      before: current.value ?? null,
      after: after.value ?? null,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
