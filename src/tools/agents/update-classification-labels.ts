import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggShapeError } from "../../ringg/errors.js";
import { extractClassificationLabels } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/** Platform cap on the number of labels (docs/edit-agent-api.md section 4.3). */
const MAX_LABELS = 10;

export const updateClassificationLabelsTool = defineTool({
  name: "update_classification_labels",
  title: "Update call classification labels",
  description:
    "Manage the labels each completed call is classified into, as { label: description }. The " +
    "description is what the classifier reads, so it should describe the situation the label " +
    "covers, e.g. 'callback_requested': 'Customer asked to be called back at a specific time.' " +
    "The upstream API replaces the whole map on every write, so this tool reads the current labels " +
    "and applies your set/remove as a merge - labels you do not mention are preserved. Use " +
    "mode='replace' to set exactly what you pass. Maximum 10 labels. Labels live on the agent, so " +
    "the change applies across every A/B version at once.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    set: z
      .record(z.string().min(1))
      .optional()
      .describe("Labels to add or re-describe, as { label: description }. Both sides must be non-empty."),
    remove: z
      .array(z.string().min(1))
      .optional()
      .describe("Label names to remove. Names that are not present are ignored."),
    mode: z
      .enum(["merge", "replace"])
      .default("merge")
      .describe("'merge' (default) keeps labels you did not mention. 'replace' discards them."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    // 'replace' discards labels, so an absent mode must not select it.
    const mode = args.mode ?? "merge";
    const set = args.set ?? {};
    const remove = args.remove ?? [];
    if (Object.keys(set).length === 0 && remove.length === 0) {
      throw new Error("Supply at least one label in 'set' or a name in 'remove'.");
    }

    // Naming a label in both halves is contradictory. Resolving it silently either way
    // would hide a mistake, so say so instead.
    const contradictory = Object.keys(set).filter((label) => remove.includes(label));
    if (contradictory.length > 0) {
      throw new RinggShapeError(
        `These labels appear in both 'set' and 'remove': ${contradictory.join(", ")}. ` +
          "Decide which you meant and send only that.",
      );
    }

    // Empty values are rejected upstream; catching it here names the offending label.
    const blank = Object.entries(set)
      .filter(([, description]) => description.trim() === "")
      .map(([label]) => label);
    if (blank.length > 0) {
      throw new RinggShapeError(
        `These labels have an empty description, which the platform rejects: ${blank.join(", ")}.`,
      );
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const before = extractClassificationLabels(agent);

    const after: Record<string, string> = mode === "merge" ? { ...before } : {};
    for (const name of remove) delete after[name];
    for (const [label, description] of Object.entries(set)) after[label] = description;

    if (Object.keys(after).length > MAX_LABELS) {
      throw new RinggShapeError(
        `That would leave ${Object.keys(after).length} labels; the platform allows at most ${MAX_LABELS}. ` +
          "Remove some in the same call, or use mode='replace' to set a smaller map.",
      );
    }

    const removed = Object.keys(before).filter((label) => !(label in after));
    const added = Object.keys(after).filter((label) => !(label in before));
    const notFound = remove.filter((label) => !(label in before));

    const warnings: string[] = [];
    if (notFound.length > 0) warnings.push(`Not present, so nothing to remove: ${notFound.join(", ")}`);
    if (mode === "replace" && removed.length > 0) {
      warnings.push(`mode='replace' discarded ${removed.length} label(s): ${removed.join(", ")}`);
    }

    // Agent-level field: no version_id, since every version shares one label map.
    const response = await editAgent(client, "edit_classification_labels", args.agent_id, {
      classification_labels: after,
    });

    return {
      agent_id: args.agent_id,
      mode,
      before,
      after,
      added,
      removed,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
