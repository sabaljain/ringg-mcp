import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggShapeError } from "../../ringg/errors.js";
import { extractAbVersions } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/** The platform's own tolerance when checking the split sums to 1.0. */
const SUM_TOLERANCE = 0.001;

export const updateTrafficSplitTool = defineTool({
  name: "update_traffic_split",
  title: "Set A/B traffic split",
  description:
    "Set how live call traffic is divided between an agent's A/B versions, as " +
    "{ version_id: share }. Shares are fractions that must add up to 1.0 - for an even two-way " +
    "split, pass 0.5 and 0.5. Every version you want to receive calls must appear; a version you " +
    "omit is not given traffic. This takes effect on live calls, so check the current split with " +
    "get_agent first.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    traffic_split: z
      .record(z.number().min(0).max(1))
      .describe("{ version_id: share }. Shares must sum to 1.0. See get_agent for the version ids."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const entries = Object.entries(args.traffic_split);
    if (entries.length === 0) {
      throw new RinggShapeError("traffic_split is empty - supply at least one version id and share.");
    }

    // Documented and deterministic, so this is a hard refusal rather than a warning.
    const sum = entries.reduce((total, [, share]) => total + share, 0);
    if (Math.abs(sum - 1) > SUM_TOLERANCE) {
      throw new RinggShapeError(
        `Traffic shares must sum to 1.0 (±${SUM_TOLERANCE}); these sum to ${sum.toFixed(4)}. ` +
          `Supplied: ${entries.map(([id, share]) => `${id}=${share}`).join(", ")}.`,
      );
    }

    const agent = await getAgentRaw(client, args.agent_id);
    const before = extractAbVersions(agent);

    if (before.length > 0) {
      const known = new Set(before.map((v) => v.version_id));
      const unknown = entries.map(([id]) => id).filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new RinggShapeError(
          `These version ids do not belong to this agent: ${unknown.join(", ")}. Known versions: ` +
            `${before.map((v) => `${v.version_id} (${v.slug ?? "no slug"})`).join(", ")}.`,
        );
      }
    }

    const omitted = before.filter((v) => !(v.version_id in args.traffic_split) && (v.call_traffic ?? 0) > 0);

    const response = await editAgent(client, "edit_traffic", args.agent_id, {
      traffic_split: args.traffic_split,
    });

    const after = extractAbVersions(await getAgentRaw(client, args.agent_id));

    return {
      agent_id: args.agent_id,
      traffic_before: before.map((v) => ({ version_id: v.version_id, slug: v.slug, share: v.call_traffic })),
      traffic_after: after.map((v) => ({ version_id: v.version_id, slug: v.slug, share: v.call_traffic })),
      warning:
        omitted.length > 0
          ? `These versions were carrying traffic and were not in the split, so they now receive none: ` +
            `${omitted.map((v) => `${v.version_id} (${v.slug ?? "no slug"})`).join(", ")}.`
          : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
