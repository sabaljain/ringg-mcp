import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { extractCustomVariableNames } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/**
 * Auto-included for outbound agents per the create-agent docs. Removing one is likely a
 * mistake, so the tool warns rather than blocking - the platform may re-add them anyway.
 */
const AUTO_INCLUDED = ["callee_name", "mobile_number"];

export const updateCustomVariablesTool = defineTool({
  name: "update_custom_variables",
  title: "Update agent custom variables",
  description:
    "Add or remove custom variable names on an agent. The upstream API replaces the entire " +
    "variable list on every write, so this tool reads the agent's current variables, applies your " +
    "add/remove as a set operation, and writes the complete merged list back - variables you do " +
    "not mention are preserved. Custom variables are names only (e.g. 'loan_amount'); values are " +
    "supplied per call or per campaign row. Prompts reference them as @{{variable_name}}.",
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
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const add = args.add ?? [];
    const remove = args.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw new Error("Supply at least one name in 'add' or 'remove'.");
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const before = extractCustomVariableNames(agent);

    const removeSet = new Set(remove.map(norm));
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
    const autoRemoved = actuallyRemoved.filter((n) => AUTO_INCLUDED.includes(norm(n)));
    if (autoRemoved.length > 0) {
      warnings.push(
        `${autoRemoved.join(", ")} ${autoRemoved.length === 1 ? "is" : "are"} auto-included for outbound ` +
          "agents per Ringg's docs; the platform may re-add it regardless of this write.",
      );
    }
    if (notFound.length > 0) {
      warnings.push(`Not present, so nothing to remove: ${notFound.join(", ")}`);
    }
    if (before.length === 0) {
      warnings.push(
        "The agent reported no existing custom variables. If you expected some, verify with get_agent " +
          "before trusting this write - Ringg documents this field in three incompatible shapes.",
      );
    }

    const response = await editAgent(client, "edit_custom_vars", args.agent_id, {
      custom_variables: after,
    });

    return {
      agent_id: args.agent_id,
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
