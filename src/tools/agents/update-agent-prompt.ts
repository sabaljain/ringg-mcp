import { z } from "zod";
import { editAgent, getPromptSections, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import { mergePromptSections, type PromptSection } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

const sectionSchema = z.object({
  section_title: z
    .string()
    .min(1)
    .describe(
      "Title of the section to write. In merge mode this is matched case-insensitively against " +
        "the agent's existing section titles; call get_agent first to see the exact titles in use.",
    ),
  section_content: z.string().describe("Full replacement text for this section."),
});

export const updateAgentPromptTool = defineTool({
  name: "update_agent_prompt",
  title: "Update agent prompt",
  description:
    "Update an agent's prompt section by section. In the default 'merge' mode the tool reads the " +
    "agent's current prompt, overwrites only the sections you name (matched by title), preserves " +
    "every other section, and writes the complete section list back - the upstream API replaces " +
    "the whole prompt, so the merge is what protects the sections you did not mention. " +
    "Use mode='replace' to set the prompt to exactly the sections you supply, discarding the rest. " +
    "Call get_agent first to see the existing section titles. " +
    "Section content may contain Jinja placeholders; the platform validates the syntax and rejects " +
    "a malformed template, so an unclosed {{ or {% will fail the whole write. " +
    "Single-prompt (single_node) agents only.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    sections: z
      .array(sectionSchema)
      .min(1)
      .describe("Sections to write. Each replaces the full content of the matching section."),
    mode: z
      .enum(["merge", "replace"])
      .default("merge")
      .describe(
        "'merge' (default) keeps existing sections you did not name. " +
          "'replace' discards every section you did not supply.",
      ),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Target a specific agent version. Defaults to the version the merge was read from, so " +
          "read and write stay on the same version. Only worth setting for an A/B agent where " +
          "you want a non-live variant; see get_agent for the ids.",
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client, logger }) {
    // Never let an absent mode select the destructive branch: the schema default only
    // applies when the caller went through validation, and 'replace' discards sections.
    const mode = args.mode ?? "merge";
    const incoming: PromptSection[] = args.sections.map((s) => ({
      section_title: s.section_title,
      section_content: s.section_content,
    }));

    let finalSections: PromptSection[];
    let before: string[] = [];
    let updated: string[] = [];
    let added: string[] = [];
    let removed: string[] = [];
    let readSource = "not read (mode=replace)";
    let versionId: string | undefined = args.version_id;

    if (mode === "merge") {
      const { agent, prompt } = await getPromptSections(client, args.agent_id);
      versionId = args.version_id ?? resolveWriteVersionId(agent);
      if (!prompt) {
        // Multi-prompt agents have no prompt_sections at all - their script lives in a
        // node graph. edit_prompt does not reach it; the platform edits those nodes
        // through separate flow operations this server does not expose.
        if (agent.orchestration_mode === "multi_node") {
          throw new RinggShapeError(
            "This is a multi-prompt agent (orchestration_mode: multi_node). Its script lives in a " +
              "node graph rather than in prompt sections, and edit_prompt does not reach it. The " +
              "platform edits those nodes through separate flow operations (edit_node_messages and " +
              "friends) that this server does not expose - use the Ringg dashboard. " +
              "This tool works on single-prompt (single_node) agents.",
          );
        }
        // Refuse rather than write a prompt that would silently drop sections we
        // could not see. The read schema for agent_config is undocumented.
        throw new RinggShapeError(
          "Could not locate the agent's existing prompt sections, so a merge would risk dropping " +
            "sections that are currently set. Inspect the agent with get_agent, then either supply " +
            "every section and call again with mode='replace', or report the payload shape. " +
            "(The prompt's location inside agent_config is not documented by Ringg.)",
        );
      }
      before = prompt.sections.map((s) => s.section_title);
      readSource = `${prompt.sourcePath}${prompt.synthesized ? " (synthesized from flat prompt fields)" : ""}`;
      const merge = mergePromptSections(prompt.sections, incoming);
      finalSections = merge.merged;
      updated = merge.updated;
      added = merge.added;

      if (prompt.synthesized) {
        logger.warn(
          "prompt sections were synthesized from flat fields; writing them back as prompt_sections",
          { agent_id: args.agent_id, source: prompt.sourcePath },
        );
      }
    } else {
      const { agent, prompt } = await getPromptSections(client, args.agent_id).catch(
        () => ({ agent: {} as Record<string, unknown>, prompt: null }),
      );
      versionId = args.version_id ?? resolveWriteVersionId(agent);
      if (agent.orchestration_mode === "multi_node") {
        throw new RinggShapeError(
          "This is a multi-prompt agent (orchestration_mode: multi_node). Its script lives in a " +
            "node graph, not in prompt sections, so writing prompt sections to it would be " +
            "meaningless. Edit multi-prompt agents in the Ringg dashboard.",
        );
      }
      before = prompt?.sections.map((s) => s.section_title) ?? [];
      finalSections = incoming;
      added = incoming.map((s) => s.section_title).filter((t) => !before.some((b) => same(b, t)));
      updated = incoming.map((s) => s.section_title).filter((t) => before.some((b) => same(b, t)));
      removed = before.filter((b) => !incoming.some((s) => same(s.section_title, b)));
    }

    let response: unknown;
    try {
      response = await editAgent(
        client,
        "edit_prompt",
        args.agent_id,
        { agent_prompt: { prompt_sections: finalSections } },
        { versionId },
      );
    } catch (err) {
      // The platform validates Jinja in section content and answers 400. Say which
      // failure this is, so the caller fixes the template instead of retrying blind.
      // The platform's own message names the section and the offending construct, which
      // beats anything synthesized here - so only the "nothing was written" fact is added.
      if (
        err instanceof RinggApiError &&
        err.status === 400 &&
        /jinja|template|the block|never closed|syntax/i.test(err.message)
      ) {
        throw new RinggShapeError(
          `Ringg rejected the prompt as an invalid template, so nothing was written. ${err.message}`,
        );
      }
      throw err;
    }

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      mode,
      read_from: readSource,
      sections_before: before,
      sections_after: finalSections.map((s) => s.section_title),
      updated,
      added,
      removed,
      warning:
        removed.length > 0
          ? `mode='replace' discarded ${removed.length} section(s) that were previously set: ${removed.join(", ")}`
          : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
