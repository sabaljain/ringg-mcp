import { z } from "zod";
import { listAgents } from "../../ringg/agents.js";
import { defineTool } from "../types.js";

export const listAgentsTool = defineTool({
  name: "list_agents",
  title: "List agents",
  description:
    "List the voice assistants (agents) in the Ringg workspace. Returns id, display name, type, " +
    "template info, call count and custom variable names for each. Use get_agent for the full " +
    "configuration of one agent, including its prompt and knowledge base attachments.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(20).describe("Number of agents to return (1-100)."),
    offset: z.number().int().min(0).default(0).describe("Number of agents to skip, for paging."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    // Defaults restated here so a caller that bypasses schema validation still pages
    // sensibly rather than sending undefined upstream.
    return listAgents(client, { limit: args.limit ?? 20, offset: args.offset ?? 0 });
  },
});
