import { z } from "zod";
import { getAgent } from "../../ringg/agents.js";
import { defineTool } from "../types.js";

export const getAgentTool = defineTool({
  name: "get_agent",
  title: "Get agent configuration",
  description:
    "Get the full configuration of one Ringg agent: prompt sections, custom variable names, " +
    "attached knowledge bases, voice, languages, and tools. Knowledge base attachments are always " +
    "returned as an array. The prompt object reports where its sections were located in the " +
    "payload, or states plainly that none were found.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID, as returned by list_agents."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    return getAgent(client, args.agent_id);
  },
});
