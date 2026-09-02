import { z } from "zod";
import { editAgent, getAgentRaw } from "../../ringg/agents.js";
import { RinggApiError } from "../../ringg/errors.js";
import { extractKnowledgeBases, knowledgeBasesReadable } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const detachKnowledgeBaseTool = defineTool({
  name: "detach_knowledge_base",
  title: "Detach a knowledge base from an agent",
  description:
    "Detach a knowledge base from an agent. This only removes the association - the knowledge " +
    "base itself and its documents are untouched. The result reports the agent's attachments " +
    "before and after. Note: for multi-prompt agents the Ringg API accepts the change but does " +
    "not report attachments back, so the result will say the outcome could not be verified.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    kb_id: z.string().min(1).describe("The knowledge base UUID to detach."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agentBefore = await getAgentRaw(client, args.agent_id);
    const before = extractKnowledgeBases(agentBefore);
    const readable = knowledgeBasesReadable(agentBefore);

    if (readable && before.length > 0 && !before.some((kb) => kb.kb_id === args.kb_id)) {
      return {
        agent_id: args.agent_id,
        kb_id: args.kb_id,
        attached_before: before,
        attached_after: before,
        changed: false,
        message:
          "That knowledge base is not attached to this agent. No write was performed. " +
          `Currently attached: ${before.map((kb) => kb.kb_id).join(", ")}`,
      };
    }

    // Ringg does not document whether remove_kb requires kb_id or detaches wholesale.
    // Sending it is the safer reading; the before/after comparison reveals what happened.
    let response: unknown;
    try {
      response = await editAgent(client, "remove_kb", args.agent_id, { kb_id: args.kb_id });
    } catch (err) {
      if (err instanceof RinggApiError && err.status === 400 && /not attached|not found/i.test(err.message)) {
        return {
          agent_id: args.agent_id,
          kb_id: args.kb_id,
          attached_before: before,
          changed: false,
          verified: readable,
          message: "Ringg reports this knowledge base is not attached to the agent. Nothing changed.",
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
          "Ringg accepted the detachment. This agent's payload does not expose knowledge base " +
          "attachments (multi-prompt agents omit the field entirely), so the result could not be " +
          "confirmed by reading it back. Verify in the Ringg dashboard.",
        api_response: response,
      };
    }

    const unexpected = after.length < before.length - 1;
    return {
      agent_id: args.agent_id,
      kb_id: args.kb_id,
      attached_before: before,
      attached_after: after,
      changed: after.length !== before.length,
      verified: true,
      warning: unexpected
        ? "More attachments disappeared than the one requested - remove_kb may ignore kb_id and " +
          "detach every knowledge base. Re-attach as needed and treat this operation with care."
        : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
