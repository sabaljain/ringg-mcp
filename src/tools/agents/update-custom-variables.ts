import { z } from "zod";
import {
  editAgent,
  getAgentRaw,
  hasSplitConfig,
  resolveWriteVersionId,
  type ConfigType,
} from "../../ringg/agents.js";
import { extractCustomVariableNames } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/**
 * Outbound agents must keep these two in the list: dropping either is rejected upstream
 * with 403 (docs/edit-agent-api.md section 4.3, `edit_custom_vars`). This is a hard rule,
 * not advice, so the tool refuses locally rather than sending a write it knows will fail.
 */
const REQUIRED_ON_OUTBOUND = ["callee_name", "mobile_number"];

export const updateCustomVariablesTool = defineTool({
  name: "update_custom_variables",
  title: "Update agent custom variables",
  description:
    "Add or remove custom variable names on an agent. The upstream API replaces the entire " +
    "variable list on every write, so this tool reads the agent's current variables, applies your " +
    "add/remove as a set operation, and writes the complete merged list back - variables you do " +
    "not mention are preserved. Custom variables are names only (e.g. 'loan_amount'); values are " +
    "supplied per call or per campaign row. Prompts reference them as @{{variable_name}}. " +
    "Outbound agents must keep 'callee_name' and 'mobile_number': removing either is rejected by " +
    "the platform, and this tool refuses the request rather than attempting it.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    add: z
      .array(z.string().min(1))
      .optional()
      .describe("Variable names to add. Already-present names are ignored."),
    remove: z
      .array(z.string().min(1))
      .optional()
      .describe("Variable names to remove. Names that are not present are ignored."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Target a specific agent version. Defaults to the version this tool read the current " +
          "variables from, so the merge and the write stay on the same version. Only worth " +
          "setting for an A/B agent where you want a non-live variant; see get_agent for the ids.",
      ),
    config_type: z
      .enum(["outbound", "inbound"])
      .optional()
      .describe(
        "Only for agents whose agent_type is 'outbound_inbound', which keep separate outbound " +
          "and inbound configs. 'inbound' writes the inbound copy. Defaults to the platform's " +
          "default ('outbound'). Ignored by every other agent type.",
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const add = args.add ?? [];
    const remove = args.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw new Error("Supply at least one name in 'add' or 'remove'.");
    }

    const contradictory = add.filter((name) => remove.some((r) => norm(r) === norm(name)));
    if (contradictory.length > 0) {
      throw new Error(
        `These names appear in both 'add' and 'remove': ${contradictory.join(", ")}. ` +
          "Decide which you meant and send only that.",
      );
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const before = extractCustomVariableNames(agent);
    const agentType = typeof agent.agent_type === "string" ? agent.agent_type : undefined;
    const isOutbound = agentType === "outbound" || agentType === "outbound_inbound";

    const removeSet = new Set(remove.map(norm));

    // Refuse before writing: the platform answers 403 for this and the write would be a
    // wasted round trip that leaves the caller guessing which name caused it.
    const forbidden = REQUIRED_ON_OUTBOUND.filter(
      (name) => removeSet.has(name) && before.some((n) => norm(n) === name),
    );
    if (isOutbound && forbidden.length > 0) {
      throw new Error(
        `Outbound agents must keep ${forbidden.join(" and ")} in their custom variables - the ` +
          "Ringg API rejects a list without them (403). Remove the other names on their own, or " +
          "change the agent type first. No write was performed.",
      );
    }

    const after = before.filter((name) => !removeSet.has(norm(name)));

    const present = new Set(after.map(norm));
    const actuallyAdded: string[] = [];
    for (const name of add) {
      const trimmed = name.trim();
      if (!trimmed || present.has(norm(trimmed))) continue;
      after.push(trimmed);
      present.add(norm(trimmed));
      actuallyAdded.push(trimmed);
    }

    const beforeSet = new Set(before.map(norm));
    const actuallyRemoved = before.filter((n) => removeSet.has(norm(n)));
    const notFound = remove.filter((n) => !beforeSet.has(norm(n)));

    const warnings: string[] = [];
    if (notFound.length > 0) {
      warnings.push(`Not present, so nothing to remove: ${notFound.join(", ")}`);
    }
    if (isOutbound && !REQUIRED_ON_OUTBOUND.every((n) => present.has(n))) {
      const missing = REQUIRED_ON_OUTBOUND.filter((n) => !present.has(n));
      warnings.push(
        `This outbound agent does not currently list ${missing.join(" or ")}, which the platform ` +
          "requires on outbound agents. The write may be rejected with 403; add them if so.",
      );
    }
    if (before.length === 0) {
      warnings.push(
        "The agent reported no existing custom variables. If you expected some, verify with get_agent " +
          "before trusting this write - Ringg documents this field in three incompatible shapes.",
      );
    }

    // Pin the write to the version the merge was computed from, so an A/B agent cannot
    // read one variant and write another.
    const versionId = args.version_id ?? resolveWriteVersionId(agent);

    // On multi-node agents this operation touches only the targeted version; on
    // single-node agents the platform applies it to every active version.
    const isMultiNode = agent.orchestration_mode === "multi_node";
    if (isMultiNode) {
      warnings.push(
        "This is a multi-prompt (multi_node) agent, so the platform applies this change to the " +
          `targeted version only${versionId ? ` (${versionId})` : ""}, not to every A/B version.`,
      );
    }

    if (args.config_type && !hasSplitConfig(agent)) {
      warnings.push(
        `config_type='${args.config_type}' was ignored: it only applies to agents whose agent_type ` +
          `is 'outbound_inbound' (this one is '${agentType ?? "unknown"}').`,
      );
    }

    const response = await editAgent(
      client,
      "edit_custom_vars",
      args.agent_id,
      { custom_variables: after },
      { versionId, configType: args.config_type as ConfigType | undefined },
    );

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      config_type: args.config_type,
      applies_to: isMultiNode ? "targeted version only" : "all active versions",
      before,
      after,
      added: actuallyAdded,
      removed: actuallyRemoved,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});

function norm(value: string): string {
  return value.trim().toLowerCase();
}
