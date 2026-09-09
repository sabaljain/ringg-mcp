import { z } from "zod";
import { editAgent, getAgentRaw, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggShapeError } from "../../ringg/errors.js";
import { isObject, readVersionField } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const updateClientAnalysisTool = defineTool({
  name: "update_client_analysis",
  title: "Update client analysis configuration",
  description:
    "Configure the client-facing analysis attached to each call: the business context the analyser " +
    "works from, which extracted key represents the call's goal, the keys themselves, and revenue " +
    "attribution. The platform merges what you send with the stored config at the top level, so " +
    "fields you omit are preserved - sending only 'context' leaves keys and revenue untouched. " +
    "At least one field is required. 'goal_key' must name a key declared as boolean. " +
    "Be aware that this configuration cannot be removed once set: the platform rejects both null " +
    "and an empty object, so the closest to unset is emptying each field individually. " +
    "Call get_agent first to see the current configuration; note that observed 'keys' entries are " +
    "objects of the form { type, default, description }, which differs from the flatter shape used " +
    "by update_custom_analysis_prompt.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    context: z
      .string()
      .nullable()
      .optional()
      .describe("Business context for the analyser. Pass null to clear just this field."),
    goal_key: z
      .string()
      .nullable()
      .optional()
      .describe("Name of the extracted key that represents the call's goal. Pass null to clear."),
    keys: z
      .record(z.unknown())
      .optional()
      .describe(
        "Keys to extract. Replaces the stored 'keys' object wholesale, since the platform merges " +
          "only at the top level - include every key you want to keep. Observed entry shape: " +
          '{ "type": "string", "default": null, "description": "..." }.',
      ),
    revenue: z
      .record(z.unknown())
      .optional()
      .describe("Revenue attribution config. Replaces the stored 'revenue' object wholesale."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe("Target a specific agent version. Defaults to the version the current config was read from."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const payload: Record<string, unknown> = {};
    if (args.context !== undefined) payload.context = args.context;
    if (args.goal_key !== undefined) payload.goal_key = args.goal_key;
    if (args.keys !== undefined) payload.keys = args.keys;
    if (args.revenue !== undefined) payload.revenue = args.revenue;

    if (Object.keys(payload).length === 0) {
      throw new RinggShapeError(
        "Supply at least one of context, goal_key, keys or revenue - the platform rejects an empty " +
          "client_analysis object.",
      );
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const current = readVersionField(agent, "client_analysis");
    const versionId = args.version_id ?? resolveWriteVersionId(agent);
    const existing = isObject(current.value) ? current.value : {};

    // Undocumented, and enforced upstream with a bare 400: goal_key must name a key that
    // is declared boolean. Checked against the keys this call establishes - the ones
    // being sent, or the stored ones when keys are untouched.
    if (typeof args.goal_key === "string") {
      const effectiveKeys = isObject(args.keys)
        ? args.keys
        : isObject(existing.keys)
          ? (existing.keys as Record<string, unknown>)
          : undefined;
      if (effectiveKeys) {
        const entry = effectiveKeys[args.goal_key];
        if (entry === undefined) {
          throw new RinggShapeError(
            `goal_key '${args.goal_key}' is not one of the client analysis keys. Available: ` +
              `${Object.keys(effectiveKeys).join(", ") || "(none)"}. Declare it in 'keys' first.`,
          );
        }
        const type = isObject(entry) ? entry.type : entry;
        if (type !== "boolean") {
          throw new RinggShapeError(
            `goal_key must name a boolean key; '${args.goal_key}' is declared as ` +
              `'${String(type)}'. The platform rejects anything else.`,
          );
        }
      }
    }

    const warnings: string[] = [];
    // Nested objects are replaced, not merged, so say what is about to be lost.
    for (const field of ["keys", "revenue"] as const) {
      if (args[field] === undefined) continue;
      const previous = isObject(existing[field]) ? Object.keys(existing[field] as object) : [];
      const next = Object.keys(args[field] as object);
      const dropped = previous.filter((k) => !next.includes(k));
      if (dropped.length > 0) {
        warnings.push(
          `'${field}' is replaced wholesale, so these entries are being dropped: ${dropped.join(", ")}. ` +
            "Include them in your payload if they should survive.",
        );
      }
    }

    const response = await editAgent(
      client,
      "edit_client_analysis",
      args.agent_id,
      { client_analysis: payload },
      { versionId },
    );

    const after = readVersionField(await getAgentRaw(client, args.agent_id), "client_analysis");

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      read_from: current.source,
      fields_sent: Object.keys(payload),
      applies_to: agent.orchestration_mode === "multi_node" ? "targeted version only" : "all active versions",
      before: current.value ?? null,
      after: after.value ?? null,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
