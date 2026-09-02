import { z } from "zod";
import { getKnowledgeBase } from "../../ringg/kb.js";
import { defineTool } from "../types.js";

export const getKnowledgeBaseTool = defineTool({
  name: "get_knowledge_base",
  title: "Get knowledge base details",
  description:
    "Get one knowledge base: its name, processing status, timestamps, and the inventory of files, " +
    "URLs and FAQs it contains. Check the status before attaching it to an agent - an untrained " +
    "knowledge base will not answer questions during calls.",
  inputSchema: {
    kb_id: z.string().min(1).describe("The knowledge base UUID, from list_knowledge_bases."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    return getKnowledgeBase(client, args.kb_id);
  },
});
