import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import { extractAbVersions } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/** Platform cap on concurrent active versions (docs/edit-agent-api.md section 4.5). */
const MAX_ACTIVE_VERSIONS = 5;

export const addAbVersionTool = defineTool({
  name: "add_ab_version",
  title: "Add an A/B test version",
  description:
    "Create a new A/B version of an agent by cloning an existing one, including its nodes, edges " +
    "and knowledge base links. The clone starts with no traffic: use update_traffic_split to send " +
    "calls to it. A/B testing must already be enabled on the agent (see toggle_ab_testing), and an " +
    "agent may hold at most 5 active versions. Returns the new version's id and slug - keep the id, " +
    "since every write tool takes a version_id to target it.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    base_version_id: z
      .string()
      .min(1)
      .optional()
      .describe("Version to clone. Defaults to the agent's latest version. See get_agent for the ids."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, { client }) {
    const agent = await getAgentRaw(client, args.agent_id);
    const before = extractAbVersions(agent);
    const abLive = agent.is_ab_live === true;

    if (args.base_version_id && before.length > 0 && !before.some((v) => v.version_id === args.base_version_id)) {
      throw new RinggShapeError(
        `base_version_id '${args.base_version_id}' does not belong to this agent. Known versions: ` +
          `${before.map((v) => `${v.version_id} (${v.slug ?? "no slug"})`).join(", ")}.`,
      );
    }

    // Both of these are read from fields whose exact semantics are inferred, so they
    // warn rather than block - a false refusal here would be worse than a 400.
    const warnings: string[] = [];
    if (!abLive) {
      warnings.push(
        "This agent reports is_ab_live=false, which suggests A/B testing is not enabled. If the " +
          "request is rejected, enable it first with toggle_ab_testing.",
      );
    }
    if (before.length >= MAX_ACTIVE_VERSIONS) {
      warnings.push(
        `This agent already has ${before.length} versions and the platform allows ${MAX_ACTIVE_VERSIONS} ` +
          "active ones. If the request is rejected, retire a version in the dashboard first.",
      );
    }

    let response: Record<string, unknown>;
    try {
      response = (await editAgent(client, "add_new_ab_version", args.agent_id, {
        ...(args.base_version_id ? { base_version_id: args.base_version_id } : {}),
      })) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof RinggApiError && err.status === 400 && !abLive) {
        throw new RinggShapeError(
          "Ringg rejected the new version, and A/B testing appears to be disabled on this agent. " +
            `Enable it with toggle_ab_testing (ab_enabled=true), then retry. Original error: ${err.message}`,
        );
      }
      throw err;
    }

    const after = extractAbVersions(await getAgentRaw(client, args.agent_id));

    return {
      agent_id: args.agent_id,
      new_version_id: response.version_id,
      new_version_slug: response.version_slug,
      cloned_from: args.base_version_id ?? "the agent's latest version",
      versions_before: before,
      versions_after: after,
      next_step:
        "The new version starts with no traffic. Use update_traffic_split to route calls to it.",
      warnings: warnings.length > 0 ? warnings : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
