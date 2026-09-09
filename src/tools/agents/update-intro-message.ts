import { z } from "zod";
import {
  editAgent,
  getAgentRaw,
  hasSplitConfig,
  resolveWriteVersionId,
  type ConfigType,
} from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import {
  extractCustomVariableNames,
  extractTemplateVariables,
  readVersionField,
} from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const updateIntroMessageTool = defineTool({
  name: "update_intro_message",
  title: "Update agent intro message",
  description:
    "Set the first thing the agent says when a call connects. The message replaces the existing " +
    "one outright - there is no merge, because it is a single string. " +
    "Reference custom variables as {{variable_name}}, e.g. 'Hi {{callee_name}}, calling from Acme.' " +
    "Plain text is fine: the platform wraps it in HTML and turns each {{variable_name}} into the " +
    "same mention markup the dashboard editor produces, so the greeting keeps working and still " +
    "renders as chips there. HTML you pass is kept as-is. The platform rejects an unclosed Jinja " +
    "block such as {% if %}. A reference to a variable the agent does not declare is accepted " +
    "silently and interpolates to nothing on a live call, so this tool checks the names for you. " +
    "Call get_agent first to see the current message.",
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

    // The platform accepts an unknown variable and renders it as a mention, so a typo
    // only shows up as an empty gap on a live call. Checking the names here is the only
    // place it can be caught.
    const declared = extractCustomVariableNames(agent).map((n) => n.toLowerCase());
    const referenced = extractTemplateVariables(args.intro_message);
    const unknown = referenced.filter((name) => !declared.includes(name.toLowerCase()));
    if (unknown.length > 0) {
      warnings.push(
        `This message references ${unknown.map((n) => `{{${n}}}`).join(", ")}, which ${
          unknown.length === 1 ? "is not a custom variable" : "are not custom variables"
        } on this agent. The platform accepts the reference but it will interpolate to nothing on a ` +
          `call. Declared variables: ${declared.length > 0 ? declared.join(", ") : "(none)"}. ` +
          "Add the name with update_custom_variables, or correct the spelling.",
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
      if (err instanceof RinggApiError && err.status === 400 && isTemplateError(err.message)) {
        throw new RinggShapeError(
          `Ringg rejected the intro message as an invalid template, so nothing was written. ${err.message}`,
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
      variables_referenced: referenced,
      before: current.value ?? null,
      after: after.value ?? null,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});

/**
 * Whether a 400 is the platform's template validator talking.
 *
 * Its messages name the offending construct ('the block "{% if x %}" is never closed'),
 * which is more useful than anything this layer could synthesize - so the wrapper only
 * adds the fact that nothing was written, and passes the original through.
 */
function isTemplateError(message: string): boolean {
  return /jinja|template|the block|never closed|syntax/i.test(message);
}
