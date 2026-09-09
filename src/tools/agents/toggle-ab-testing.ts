import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import { extractAbVersions } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const toggleAbTestingTool = defineTool({
  name: "toggle_ab_testing",
  title: "Enable or disable A/B testing",
  description:
    "Turn A/B testing on or off for an agent. Enabling it is the prerequisite for add_ab_version " +
    "and update_traffic_split. Disabling it requires the agent to be down to a single active " +
    "version with no calls in flight, so retire the other versions and let queued calls drain " +
    "first - the platform rejects the change otherwise.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    ab_enabled: z.boolean().describe("true enables A/B testing, false disables it."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agent = await getAgentRaw(client, args.agent_id);
    const versions = extractAbVersions(agent);
    const before = agent.is_ab_live === true;

    if (before === args.ab_enabled) {
      return {
        agent_id: args.agent_id,
        ab_enabled_before: before,
        ab_enabled_after: before,
        changed: false,
        message: `A/B testing is already ${before ? "enabled" : "disabled"} on this agent. No write was performed.`,
      };
    }

    // Inferred from a readable field, so this warns rather than blocking.
    const warnings: string[] = [];
    if (!args.ab_enabled && versions.length > 1) {
      warnings.push(
        `This agent reports ${versions.length} versions. Disabling requires exactly one active ` +
          "version and no calls in flight, so the platform may reject this. Versions: " +
          `${versions.map((v) => `${v.version_id} (${v.slug ?? "no slug"}, traffic ${v.call_traffic ?? 0})`).join(", ")}.`,
      );
    }

    let response: unknown;
    try {
      response = await editAgent(client, "toggle_ab_testing", args.agent_id, {
        ab_enabled: args.ab_enabled,
      });
    } catch (err) {
      if (err instanceof RinggApiError && (err.status === 400 || err.status === 409) && !args.ab_enabled) {
        throw new RinggShapeError(
          "Ringg refused to disable A/B testing. It requires exactly one active version and no calls " +
            "in registered or retry status. Retire the extra versions in the dashboard and let queued " +
            `calls drain, then retry. Nothing was changed. Original error: ${err.message}`,
        );
      }
      throw err;
    }

    const after = await getAgentRaw(client, args.agent_id);

    return {
      agent_id: args.agent_id,
      ab_enabled_before: before,
      ab_enabled_after: after.is_ab_live === true,
      changed: true,
      versions,
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
