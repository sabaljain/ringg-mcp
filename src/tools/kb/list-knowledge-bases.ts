import { listKnowledgeBases } from "../../ringg/kb.js";
import { defineTool } from "../types.js";

export const listKnowledgeBasesTool = defineTool({
  name: "list_knowledge_bases",
  title: "List knowledge bases",
  description:
    "List every knowledge base in the Ringg workspace, with id, name, type and creation time. " +
    "Use get_knowledge_base for the document inventory of one, and attach_knowledge_base to " +
    "associate one with an agent. This server cannot create, edit or delete knowledge bases.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(_args, { client }) {
    const knowledge_bases = await listKnowledgeBases(client);
    return { knowledge_bases, count: knowledge_bases.length };
  },
});
