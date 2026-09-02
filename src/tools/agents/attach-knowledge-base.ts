import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggApiError } from "../../ringg/errors.js";
import { extractKnowledgeBases, knowledgeBasesReadable } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const attachKnowledgeBaseTool = defineTool({
  name: "attach_knowledge_base",
  title: "Attach a knowledge base to an agent",
  description:
    "Attach a knowledge base to an agent so it can answer from those documents during calls. " +
    "An agent may hold more than one knowledge base, so this is additive and does not replace " +
    "existing attachments. The result reports the agent's attachments before and after. " +
    "Note: for multi-prompt agents the Ringg API accepts the attachment but does not report " +
    "attachments back, so the result will say the outcome could not be verified. " +
    "Use list_knowledge_bases to find a kb_id.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    kb_id: z.string().min(1).describe("The knowledge base UUID, from list_knowledge_bases."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agentBefore = await getAgentRaw(client, args.agent_id);
    const before = extractKnowledgeBases(agentBefore);
    const readable = knowledgeBasesReadable(agentBefore);

    if (readable && before.some((kb) => kb.kb_id === args.kb_id)) {
      return {
        agent_id: args.agent_id,
        kb_id: args.kb_id,
        attached_before: before,
        attached_after: before,
        changed: false,
        message: "That knowledge base is already attached to this agent. No write was performed.",
      };
    }

    let response: unknown;
    try {
      response = await editAgent(client, "attach_kb", args.agent_id, { kb_id: args.kb_id });
    } catch (err) {
      // Already-attached is a benign outcome, not a failure - and it is the only signal
      // available on agents whose attachments cannot be read back.
      if (err instanceof RinggApiError && err.status === 400 && /already attached/i.test(err.message)) {
        return {
          agent_id: args.agent_id,
          kb_id: args.kb_id,
          attached_before: before,
          changed: false,
          verified: readable,
          message:
            "Ringg reports this knowledge base is already attached to the agent. Nothing changed.",
        };
      }
      throw err;
    }

    const after = extractKnowledgeBases(await getAgentRaw(client, args.agent_id));

    if (!readable) {
      return {
        agent_id: args.agent_id,
        kb_id: args.kb_id,
        changed: true,
        verified: false,
        message:
          "Ringg accepted the attachment. This agent's payload does not expose knowledge base " +
          "attachments (multi-prompt agents omit the field entirely), so the result could not be " +
          "confirmed by reading it back. Verify in the Ringg dashboard.",
        api_response: response,
      };
    }

    return {
      agent_id: args.agent_id,
      kb_id: args.kb_id,
      attached_before: before,
      attached_after: after,
      changed: true,
      verified: true,
      note:
        before.length > 0 && after.length === 1
          ? "The agent previously had attachment(s) and now reports exactly one - this workspace may " +
            "only support a single knowledge base per agent. Compare attached_before and attached_after."
          : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
