import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { defineTool } from "../types.js";

export const updateAgentDisplayNameTool = defineTool({
  name: "update_agent_display_name",
  title: "Rename an agent",
  description:
    "Change an agent's display name - the label shown in the Ringg dashboard and returned by " +
    "list_agents. This is cosmetic: it does not affect the agent's id, its prompt, or anything " +
    "the agent says on a call. The name lives on the agent itself rather than on a version, so " +
    "the change applies across every A/B version at once.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    agent_display_name: z.string().min(1).describe("The new display name."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agent = await getAgentRaw(client, args.agent_id);
    const before = typeof agent.agent_display_name === "string" ? agent.agent_display_name : undefined;

    if (before === args.agent_display_name) {
      return {
        agent_id: args.agent_id,
        before,
        after: before,
        changed: false,
        message: "The agent already has that display name. No write was performed.",
      };
    }

    // Agent-level field: no version_id, since every version shares the one name.
    const response = await editAgent(client, "edit_agent_display_name", args.agent_id, {
      agent_display_name: args.agent_display_name,
    });

    const after = await getAgentRaw(client, args.agent_id);

    return {
      agent_id: args.agent_id,
      before,
      after: typeof after.agent_display_name === "string" ? after.agent_display_name : undefined,
      changed: true,
      api_response: response,
      verify_with: "list_agents",
    };
  },
});
