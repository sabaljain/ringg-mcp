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
    "payload, or states plainly that none were found. " +
    "\n\n" +
    "`tools` is split by phase (pre_call / on_call / post_call); each pre-call tool lists the " +
    "response keys that are legal paths in an @((tool_name.Path)) reference. Together with " +
    "`custom_variables` and `knowledge_bases` that is the full vocabulary a prompt may reference, " +
    "so read this before writing one with update_agent_prompt. " +
    "`prompt.references` lists what the current prompt actually references, and `prompt.issues` " +
    "reports references that will not resolve on a live call - an undeclared variable, a knowledge " +
    "base that is referenced but not attached, a tool field path the tool does not return. The " +
    "platform accepts all of these silently, so a read is the only way to find them. " +
    "\n\n" +
    "Pass include_prompt=false when you need the vocabulary rather than the wording - preparing a " +
    "prompt write, checking which tools or variables exist, auditing references. Prompt bodies are " +
    "most of a large agent's payload, so omitting them is the difference between a result that " +
    "fits and one that does not. Section titles, references and issues all survive.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID, as returned by list_agents."),
    include_prompt: z
      .boolean()
      .default(true)
      .describe(
        "Include the full text of every prompt section (default true). Set false to get " +
          "section_titles instead of the bodies, keeping the tool/variable/knowledge-base " +
          "vocabulary and the reference audit. On a large agent the bodies are 78-96% of the " +
          "response, so this is what keeps a read from overflowing the result limit. Use false " +
          "unless you actually need to read or edit the wording.",
      ),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    return getAgent(client, args.agent_id, { includePrompt: args.include_prompt !== false });
  },
});
