import { z } from "zod";
import { editAgent, getPromptSections, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import {
  extractCustomVariableNames,
  extractKnowledgeBases,
  mergePromptSections,
  type PromptSection,
} from "../../ringg/normalize.js";
import { buildChangeReport, summarizeChangeReport } from "../../ringg/prompt-diff.js";
import {
  extractPromptVocabulary,
  summarizeReferences,
  validatePromptSections,
  type Finding,
  type PromptVocabulary,
} from "../../ringg/prompt-refs.js";
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
    "Call get_agent first to see the existing section titles and what the agent makes referenceable. " +
    "\n\n" +
    "EVERY WRITE IS CHECKED FIRST. The sections you supply are validated against the agent's " +
    "custom variables, pre-call and on-call tools, and attached knowledge bases before anything " +
    "is sent. If a problem is found nothing is written: the tool returns the findings with a " +
    "concrete fix for each, for you to show the user and correct. Re-call with the corrections, " +
    "or with acknowledge_findings=true once the user has seen them and wants to proceed anyway. " +
    "On a successful write the result reports what changed, per section and per step, with the " +
    "before and after text. Problems in sections you are NOT writing never block the write; they " +
    "are reported separately as pre_existing_issues. " +
    "\n\n" +
    "PROMPT REFERENCE SYNTAX (five constructs, each with its own form):\n" +
    "  - custom variable:    @{{variable_name}}\n" +
    "  - pre-call tool data: @((tool_name.Dotted.Path))  - path must be one of that tool's response keys\n" +
    "  - on-call tool:       @||tool_name||\n" +
    "  - knowledge base:     inserted from the dashboard; binds via a UUID, so plain '@kb_name' text is inert\n" +
    "  - control flow:       {% if %} / {% elif %} / {% else %} / {% endif %}\n" +
    "A @(( )) value is substituted as TEXT before Jinja runs, so inside a {% %} statement it must " +
    'be quoted: {% if "@((t.Path))" == "True" %}. Because it is text, a boolean arrives as the ' +
    'string "True"/"False" - and "False" is truthy in Jinja, so test it with == "True" rather ' +
    "than for truthiness. Custom variables are native Jinja names: test them bare, {% if channel " +
    "== 'meta' %}. The platform rejects an unclosed {% %} block but accepts an unclosed {{ and a " +
    "bad filter, so these checks are the only guard for the rest. " +
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
    acknowledge_findings: z
      .boolean()
      .default(false)
      .describe(
        "Write even though the pre-write checks found problems. Leave false so problems are " +
          "reported instead of written. Set true only after showing the user the findings from a " +
          "previous call and being told to proceed - never to get past a finding on your own " +
          "judgement, and never on the first attempt.",
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
    let existingSections: PromptSection[] = [];
    let before: string[] = [];
    let updated: string[] = [];
    let added: string[] = [];
    let removed: string[] = [];
    let readSource = "not read (mode=replace)";
    let versionId: string | undefined = args.version_id;
    let vocabulary: PromptVocabulary | undefined;

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
      existingSections = prompt.sections;
      before = prompt.sections.map((s) => s.section_title);
      readSource = `${prompt.sourcePath}${prompt.synthesized ? " (synthesized from flat prompt fields)" : ""}`;
      const merge = mergePromptSections(prompt.sections, incoming);
      finalSections = merge.merged;
      updated = merge.updated;
      added = merge.added;
      vocabulary = buildVocabulary(agent);

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
      existingSections = prompt?.sections ?? [];
      before = existingSections.map((s) => s.section_title);
      finalSections = incoming;
      added = incoming.map((s) => s.section_title).filter((t) => !before.some((b) => same(b, t)));
      updated = incoming.map((s) => s.section_title).filter((t) => before.some((b) => same(b, t)));
      removed = before.filter((b) => !incoming.some((s) => same(s.section_title, b)));
      // A failed read leaves the vocabulary unknown. The checks that need no vocabulary
      // (Jinja structure, quoting, truthiness) still run; name checks skip themselves.
      vocabulary = buildVocabulary(agent);
    }

    // Validate what will actually be live, then split by whether this call is
    // responsible for it. A legacy problem in an untouched section is reported but must
    // never dead-end an unrelated edit.
    const { findings, references } = validatePromptSections(finalSections, vocabulary);
    const writingTitles = new Set(incoming.map((s) => s.section_title.trim().toLowerCase()));
    const blocking: Finding[] = [];
    const preExisting: Finding[] = [];
    for (const finding of findings) {
      (writingTitles.has(finding.section.trim().toLowerCase()) ? blocking : preExisting).push(finding);
    }

    if (blocking.length > 0 && !args.acknowledge_findings) {
      const errors = blocking.filter((f) => f.severity === "error").length;
      const warnings = blocking.length - errors;
      return {
        agent_id: args.agent_id,
        version_id: versionId,
        written: false,
        outcome: "blocked_by_checks",
        summary:
          `Nothing was written. The pre-write checks found ${errors} error(s) and ${warnings} ` +
          `warning(s) in the section(s) you are writing. Show these to the user with the ` +
          `suggested fixes, correct the content, and call again.`,
        findings: blocking,
        pre_existing_issues: preExisting.length > 0 ? preExisting : undefined,
        how_to_proceed:
          "Fix the content and re-call. If the user has seen these findings and wants the write " +
          "anyway, re-call with acknowledge_findings=true.",
        reference_syntax: REFERENCE_SYNTAX_HINT,
      };
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

    const changes = buildChangeReport(existingSections, finalSections);

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      written: true,
      outcome: args.acknowledge_findings && blocking.length > 0 ? "written_over_findings" : "written",
      mode,
      read_from: readSource,
      summary: summarizeChangeReport(changes),
      changes,
      sections_before: before,
      sections_after: finalSections.map((s) => s.section_title),
      updated,
      added,
      removed,
      references_now_in_prompt: summarizeReferences(references),
      acknowledged_findings: args.acknowledge_findings && blocking.length > 0 ? blocking : undefined,
      pre_existing_issues: preExisting.length > 0 ? preExisting : undefined,
      warning:
        removed.length > 0
          ? `mode='replace' discarded ${removed.length} section(s) that were previously set: ${removed.join(", ")}`
          : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});

const REFERENCE_SYNTAX_HINT = {
  custom_variable: "@{{variable_name}} - and bare in Jinja: {% if channel == 'meta' %}",
  pre_call_tool_data: '@((tool_name.Dotted.Path)) - quote it inside Jinja: {% if "@((t.P))" == "True" %}',
  on_call_tool: "@||tool_name||",
  knowledge_base: "insert from the dashboard editor; it binds by UUID, not by the visible @name text",
  control_flow: "{% if %} / {% elif %} / {% else %} / {% endif %}",
};

/** The agent's referenceable vocabulary, tolerant of a payload that could not be read. */
function buildVocabulary(agent: Record<string, unknown>): PromptVocabulary {
  return extractPromptVocabulary(
    agent,
    extractCustomVariableNames(agent),
    extractKnowledgeBases(agent),
  );
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
