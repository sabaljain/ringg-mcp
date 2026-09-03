import { z } from "zod";
import { editAgent, getAgentRaw, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggApiError } from "../../ringg/errors.js";
import { extractKnowledgeBases, knowledgeBasesReadable } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

export const detachKnowledgeBaseTool = defineTool({
  name: "detach_knowledge_base",
  title: "Detach a knowledge base from an agent",
  description:
    "Detach one knowledge base from an agent. This only removes the association - the knowledge " +
    "base itself and its documents are untouched, and the agent's other attachments are left in " +
    "place. Attachments live on an agent version, so the change is made on the version this tool " +
    "read. The result reports the agent's attachments before and after. Note: for multi-prompt " +
    "agents the Ringg API accepts the change but does not report attachments back, so the result " +
    "will say the outcome could not be verified.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    kb_id: z.string().min(1).describe("The knowledge base UUID to detach."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Detach from a specific agent version. Defaults to the version this tool read the current " +
          "attachments from. Only worth setting for an A/B agent; see get_agent for the ids.",
      ),
    is_draft: z
      .boolean()
      .optional()
      .describe(
        "Multi-prompt (multi_node) agents only: detach on the draft of the target version rather " +
          "than the version itself, leaving the live config untouched until the draft is published. " +
          "Requires a resolvable version. Single-prompt agents ignore it.",
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    const agentBefore = await getAgentRaw(client, args.agent_id);
    const before = extractKnowledgeBases(agentBefore);
    const readable = knowledgeBasesReadable(agentBefore);
    const versionId = args.version_id ?? resolveWriteVersionId(agentBefore);

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

    // `kb_id` is required by remove_kb (docs/edit-agent-api.md section 4.2): the operation
    // detaches exactly the knowledge base named, not the agent's whole set.
    let response: unknown;
    try {
      response = await editAgent(
        client,
        "remove_kb",
        args.agent_id,
        { kb_id: args.kb_id },
        { versionId, isDraft: args.is_draft },
      );
    } catch (err) {
      if (
        err instanceof RinggApiError &&
        (err.status === 400 || err.status === 404) &&
        /not attached|not found/i.test(err.message)
      ) {
        return {
          agent_id: args.agent_id,
          kb_id: args.kb_id,
          version_id: versionId,
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
        version_id: versionId,
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
      version_id: versionId,
      attached_before: before,
      attached_after: after,
      changed: after.length !== before.length,
      verified: true,
      warning: unexpected
        ? "More attachments disappeared than the one requested. remove_kb is documented to detach " +
          "only the kb_id given, so this is unexpected - compare attached_before and attached_after, " +
          "re-attach anything that should still be there, and report the discrepancy."
        : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});
