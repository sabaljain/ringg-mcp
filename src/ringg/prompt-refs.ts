/**
 * The Ringg prompt reference grammar: parsing and validation.
 *
 * A prompt section is HTML authored in the dashboard's rich-text editor. Beyond prose it
 * carries five distinct constructs, each with its own syntax and its own failure mode.
 * None of this is documented by Ringg; the grammar below was established by reading the
 * prompts and mention-chip markup of every agent in a live workspace.
 *
 *   custom variable    @{{name}}                      chip: data-source="custom_variable"
 *   pre-call tool data @((tool_name.Dotted.Path))     chip: data-source="api"
 *   on-call tool       @||tool_name||                 chip: data-source="platform"
 *   knowledge base     @kb_name                       chip: data-source="knowledge_base"
 *   control flow       {% if %}/{% elif %}/{% else %}/{% endif %}
 *
 * Three semantics drive most of the checks here:
 *
 * 1. `@(( ))` is substituted as a STRING before Jinja evaluates the template. Inside a
 *    `{% %}` statement it must therefore be quoted - every working example in the wild
 *    writes `{% if "@((t.Path))" == "True" %}`. Unquoted, Jinja parses the substituted
 *    text as an expression and the statement means something else or fails outright.
 *
 * 2. Because the substitution is textual, a boolean field arrives as the string "True"
 *    or "False" - and "False" is TRUTHY in Jinja. `{% if "@((t.Flag))" %}` is therefore
 *    always true. The condition has to compare: `== "True"`.
 *
 * 3. A knowledge base reference binds through the `data-id` UUID on its chip, never
 *    through the visible `@kb_name` text. Plain text that merely looks like a KB
 *    reference is inert - it reads as a reference and does nothing.
 *
 * The platform's own validator is partial (see README "Jinja validation is real but
 * partial"): it rejects an unclosed `{% %}` block and an unknown tag, but accepts an
 * unclosed `{{`, a malformed filter, and every one of the reference errors above. These
 * checks are the only place those are caught before they reach a live call.
 */

import { getActiveVersion, isObject, type Json } from "./normalize.js";

/* --------------------------------------------------------------- types */

export type ReferenceKind = "custom_variable" | "pre_call_field" | "on_call_tool" | "knowledge_base";

export interface PromptReference {
  kind: ReferenceKind;
  /** The literal text as it appears in the prompt, e.g. '@((get_order.Data.Status))'. */
  raw: string;
  /** Variable name, tool name, or KB name. */
  name: string;
  /** Dotted field path, for pre-call tool references only. */
  path?: string;
  /** KB UUID recovered from the mention chip. Absent when the reference has no chip. */
  kbId?: string;
  section: string;
  /** True when the reference sits inside a {% %} statement rather than in prose. */
  inJinja: boolean;
}

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable code, e.g. 'unquoted_field_in_jinja'. */
  code: string;
  section: string;
  message: string;
  /** A concrete fix, written so it can be applied without further investigation. */
  suggestion: string;
  excerpt?: string;
}

export interface PreCallToolInfo {
  name: string;
  /** Legal dotted paths for @((name.<path>)). Empty when the tool declares none. */
  responseKeys: string[];
}

export interface ToolInfo {
  name: string;
  toolType?: string;
  enabled?: boolean;
}

export interface KbInfo {
  kb_id: string;
  kb_name?: string;
}

/**
 * What an agent makes referenceable. The `*Known` flags matter: when a list could not be
 * read from the payload, existence checks against it are skipped rather than reported as
 * failures, so an unfamiliar payload shape never produces invented findings.
 */
export interface PromptVocabulary {
  customVariables: string[];
  customVariablesKnown: boolean;
  preCallTools: PreCallToolInfo[];
  onCallTools: ToolInfo[];
  toolsKnown: boolean;
  knowledgeBases: KbInfo[];
  kbKnown: boolean;
}

/* ------------------------------------------------------------- parsing */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * HTML to plain text.
 *
 * Chips render their reference literal as their own inner text, so stripping tags leaves
 * every reference intact and identical whether or not the dashboard wrapped it in a
 * chip. That is what lets one scan handle both hand-written and editor-produced markup.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|li|h[1-6]|div|ul|ol|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

interface Chip {
  source: string;
  id: string;
  label: string;
}

/** Mention chips, read for the one thing plain text cannot carry: the KB UUID. */
function parseChips(html: string): Chip[] {
  const chips: Chip[] = [];
  for (const match of html.matchAll(/<span\b([^>]*data-type="mention"[^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const source = /data-source="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    const id = /data-id="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    const label = /data-label="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    chips.push({ source, id, label });
  }
  return chips;
}

/** Character ranges covered by {% ... %} statements, so prose and logic can be told apart. */
function jinjaStatementRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/\{%[\s\S]*?%\}/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function withinAny(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Jinja's own vocabulary: keywords, tests, and the filters and globals in common use.
 * Anything here is part of the template language rather than a reference to agent data,
 * so it must never be reported as an unknown variable.
 */
const JINJA_RESERVED = new Set([
  "and", "or", "not", "in", "is", "if", "else", "elif", "true", "false", "none",
  "defined", "undefined", "string", "number", "integer", "float", "boolean", "mapping",
  "sequence", "iterable", "callable", "sameas", "divisibleby", "escaped", "odd", "even",
  "equalto", "eq", "ne", "lt", "le", "gt", "ge", "loop", "range", "length", "count",
  "lower", "upper", "trim", "title", "capitalize", "striptags", "truncate", "default",
  "join", "replace", "int", "float64", "abs", "round", "first", "last", "list", "map",
  "select", "reject", "selectattr", "rejectattr", "sort", "unique", "sum", "batch",
]);

/**
 * Variable names used as values inside an `{% if %}` / `{% elif %}` condition.
 *
 * Quoted literals are dropped first: they hold substituted `@(( ))` text, not identifiers.
 * Filter and test names, attribute segments after a dot, and Jinja's own vocabulary are
 * all excluded, leaving only names that must resolve to agent data.
 */
function conditionIdentifiers(body: string): string[] {
  const bare = body
    // Reference literals are not identifiers. Removing them first also stops an unquoted
    // @(( )) from cascading into a second, misleading "unknown variable" report.
    .replace(/@\(\([^)]*\)\)/g, " ")
    .replace(/@\|\|[^|]*\|\|/g, " ")
    .replace(/@?\{\{[^}]*\}\}/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  const names: string[] = [];
  for (const match of bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = match[0];
    const start = match.index ?? 0;
    // A filter or test name follows '|' or 'is', not a value position.
    if (/\|\s*$/.test(bare.slice(Math.max(0, start - 8), start))) continue;
    if (/\bis\s+(?:not\s+)?$/.test(bare.slice(Math.max(0, start - 12), start))) continue;
    // Attribute access: only the root name is a reference.
    if (start > 0 && bare[start - 1] === ".") continue;
    // A call like foo(...) is a function, not agent data.
    if (bare[start + name.length] === "(") continue;
    if (JINJA_RESERVED.has(name.toLowerCase())) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Every reference in one section, in document order. */
export function extractReferences(sectionTitle: string, html: string): PromptReference[] {
  const text = stripHtml(html);
  const statements = jinjaStatementRanges(text);
  const refs: PromptReference[] = [];

  const push = (ref: Omit<PromptReference, "section">) => {
    refs.push({ ...ref, section: sectionTitle });
  };

  // Pre-call tool data field: @((tool_name.Dotted.Path))
  for (const match of text.matchAll(/@\(\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*([^)]*?))?\s*\)\)/g)) {
    const name = match[1];
    if (!name) continue;
    const path = match[2]?.trim();
    push({
      kind: "pre_call_field",
      raw: match[0],
      name,
      ...(path ? { path } : {}),
      inJinja: withinAny(statements, match.index ?? 0),
    });
  }

  // On-call tool invocation: @||tool_name||
  for (const match of text.matchAll(/@\|\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\|/g)) {
    const name = match[1];
    if (!name) continue;
    push({ kind: "on_call_tool", raw: match[0], name, inJinja: withinAny(statements, match.index ?? 0) });
  }

  // Custom variable: @{{name}} or bare {{name}}. A {{ }} inside a {% %} statement is not
  // an interpolation, so it is not counted as a reference here.
  for (const match of text.matchAll(/@?\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = match[1];
    if (!name) continue;
    const index = match.index ?? 0;
    if (withinAny(statements, index)) continue;
    push({ kind: "custom_variable", raw: match[0], name, inJinja: false });
  }

  // A bare identifier in a condition is a variable reference too - `{% if channel == 'x' %}`.
  // Unlike an interpolation, a typo here fails silently: the name is simply undefined and
  // the branch never matches, so nothing in the rendered prompt shows anything is wrong.
  for (const stmt of text.matchAll(/\{%-?\s*(?:if|elif)\b([\s\S]*?)-?%\}/g)) {
    for (const name of conditionIdentifiers(stmt[1] ?? "")) {
      push({ kind: "custom_variable", raw: name, name, inJinja: true });
    }
  }

  // Knowledge base: recoverable only from the chip, which carries the binding UUID.
  for (const chip of parseChips(html)) {
    if (chip.source !== "knowledge_base") continue;
    push({
      kind: "knowledge_base",
      raw: `@${chip.label || chip.id}`,
      name: chip.label || chip.id,
      kbId: chip.id,
      inJinja: false,
    });
  }

  return refs;
}

/* ---------------------------------------------------------- vocabulary */

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readToolList(container: Json, key: string): Json[] {
  const value = container[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function toolName(tool: Json): string | undefined {
  return asString(tool.tool_name) ?? asString(tool.name);
}

/**
 * Reads the reference vocabulary off an agent payload.
 *
 * The phase arrays live on the active version as `pre_call_tools` / `on_call_tools` /
 * `post_call_tools`. The version's flat `tools` key is only a partial mirror of the
 * on-call platform tools, so it is not used as a source here.
 */
export function extractPromptVocabulary(
  agent: Json,
  customVariables: string[],
  knowledgeBases: KbInfo[],
): PromptVocabulary {
  const active = getActiveVersion(agent);
  const containers: Json[] = [];
  if (active) containers.push(active.version);
  containers.push(agent);
  if (isObject(agent.agent_config)) containers.push(agent.agent_config as Json);

  let preCallRaw: Json[] = [];
  let onCallRaw: Json[] = [];
  let sawToolKey = false;

  for (const container of containers) {
    const hasKey =
      "pre_call_tools" in container || "on_call_tools" in container || "post_call_tools" in container;
    if (!hasKey) continue;
    sawToolKey = true;
    preCallRaw = readToolList(container, "pre_call_tools");
    onCallRaw = readToolList(container, "on_call_tools");
    break;
  }

  const preCallTools: PreCallToolInfo[] = [];
  for (const tool of preCallRaw) {
    const name = toolName(tool);
    if (!name) continue;
    const config = isObject(tool.config) ? tool.config : {};
    const keys = Array.isArray(config.responseSelectedKeys)
      ? config.responseSelectedKeys.filter((k): k is string => typeof k === "string")
      : [];
    preCallTools.push({ name, responseKeys: keys });
  }

  const onCallTools: ToolInfo[] = [];
  for (const tool of onCallRaw) {
    const name = toolName(tool);
    if (!name) continue;
    onCallTools.push({
      name,
      ...(asString(tool.tool_type) ? { toolType: asString(tool.tool_type) } : {}),
      ...(typeof tool.is_enabled === "boolean" ? { enabled: tool.is_enabled } : {}),
    });
  }

  return {
    customVariables,
    customVariablesKnown: customVariables.length > 0,
    preCallTools,
    onCallTools,
    toolsKnown: sawToolKey,
    knowledgeBases,
    kbKnown: true,
  };
}

/** Compact per-phase tool inventory, for showing what a prompt is allowed to reference. */
export interface PhaseTool {
  name: string;
  tool_type?: string;
  enabled?: boolean;
  /** Legal @((name.<path>)) paths. Pre-call tools only, and capped for readability. */
  response_keys?: string[];
  response_key_count?: number;
}

export interface PhaseTools {
  pre_call: PhaseTool[];
  on_call: PhaseTool[];
  post_call: PhaseTool[];
  /** False when the payload exposed no phase arrays at all, so empty means "unknown". */
  readable: boolean;
}

const MAX_KEYS_SHOWN = 60;

/**
 * The agent's tools, split by phase.
 *
 * `get_agent` previously surfaced the version's flat `tools` key, which mirrors only the
 * on-call platform tools and reads as `[]` on an agent that has plenty - hiding exactly
 * the names a prompt needs in order to reference anything.
 */
export function extractPhaseTools(agent: Json): PhaseTools {
  const active = getActiveVersion(agent);
  const containers: Json[] = [];
  if (active) containers.push(active.version);
  containers.push(agent);
  if (isObject(agent.agent_config)) containers.push(agent.agent_config as Json);

  for (const container of containers) {
    const hasKey =
      "pre_call_tools" in container || "on_call_tools" in container || "post_call_tools" in container;
    if (!hasKey) continue;

    const map = (tools: Json[], withKeys: boolean): PhaseTool[] => {
      const out: PhaseTool[] = [];
      for (const tool of tools) {
        const name = toolName(tool);
        if (!name) continue;
        const entry: PhaseTool = { name };
        const type = asString(tool.tool_type);
        if (type) entry.tool_type = type;
        if (typeof tool.is_enabled === "boolean") entry.enabled = tool.is_enabled;
        if (withKeys) {
          const config = isObject(tool.config) ? tool.config : {};
          const keys = Array.isArray(config.responseSelectedKeys)
            ? config.responseSelectedKeys.filter((k): k is string => typeof k === "string")
            : [];
          if (keys.length > 0) {
            entry.response_keys = keys.slice(0, MAX_KEYS_SHOWN);
            entry.response_key_count = keys.length;
          }
        }
        out.push(entry);
      }
      return out;
    };

    return {
      pre_call: map(readToolList(container, "pre_call_tools"), true),
      on_call: map(readToolList(container, "on_call_tools"), false),
      post_call: map(readToolList(container, "post_call_tools"), false),
      readable: true,
    };
  }

  return { pre_call: [], on_call: [], post_call: [], readable: false };
}

/* ---------------------------------------------------------- validation */

function excerptAround(text: string, index: number, span = 90): string {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${slice}${end < text.length ? "..." : ""}`;
}

const OPENERS = new Set(["if", "for"]);
const CLOSERS: Record<string, string> = { endif: "if", endfor: "for" };
const MIDDLES: Record<string, string[]> = { elif: ["if"], else: ["if", "for"] };

/**
 * Position of the first unmatched delimiter, so a report points at the actual mistake
 * rather than at the first well-formed reference in the section.
 *
 * Returns the offending index and which side is unmatched, or null when balanced.
 */
function findUnbalanced(
  text: string,
  open: string,
  close: string,
): { index: number; side: "open" | "close" } | null {
  const pattern = new RegExp(
    `${open.replace(/[{%]/g, "\\$&")}|${close.replace(/[}%]/g, "\\$&")}`,
    "g",
  );
  let openIndex = -1;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (match[0] === open) {
      if (openIndex >= 0) return { index: openIndex, side: "open" };
      openIndex = index;
    } else {
      if (openIndex < 0) return { index, side: "close" };
      openIndex = -1;
    }
  }
  return openIndex >= 0 ? { index: openIndex, side: "open" } : null;
}

/** Structural Jinja checks the platform performs only partially, or not at all. */
function checkJinjaStructure(section: string, text: string, findings: Finding[]): void {
  // Unclosed {{ - accepted by the platform, then breaks at render time.
  const interp = findUnbalanced(text, "{{", "}}");
  if (interp) {
    findings.push({
      severity: "error",
      code: "unbalanced_interpolation",
      section,
      message:
        `An interpolation is not balanced: a stray '${interp.side === "open" ? "{{" : "}}"}' has no ` +
        "match. The platform accepts this and it fails on a live call instead.",
      suggestion:
        interp.side === "open"
          ? "Close the '{{' with '}}', or remove it."
          : "Remove the stray '}}', or add the '{{' it was meant to close.",
      excerpt: excerptAround(text, interp.index),
    });
  }

  const stmt = findUnbalanced(text, "{%", "%}");
  if (stmt) {
    findings.push({
      severity: "error",
      code: "unbalanced_statement",
      section,
      message: `A statement is not balanced: a stray '${stmt.side === "open" ? "{%" : "%}"}' has no match.`,
      suggestion:
        stmt.side === "open" ? "Close the '{%' with '%}'." : "Remove the stray '%}'.",
      excerpt: excerptAround(text, stmt.index),
    });
  }

  // Block balance.
  const stack: Array<{ tag: string; index: number }> = [];
  for (const match of text.matchAll(/\{%-?\s*(\w+)([\s\S]*?)-?%\}/g)) {
    const tag = (match[1] ?? "").toLowerCase();
    const index = match.index ?? 0;

    if (OPENERS.has(tag)) {
      stack.push({ tag, index });
      continue;
    }
    const closes = CLOSERS[tag];
    if (closes) {
      const top = stack.pop();
      if (!top || top.tag !== closes) {
        findings.push({
          severity: "error",
          code: "unexpected_block_end",
          section,
          message: `'{% ${tag} %}' does not close an open '{% ${closes} %}' block.`,
          suggestion: `Remove the stray '{% ${tag} %}', or add the '{% ${closes} %}' it was meant to close.`,
          excerpt: excerptAround(text, index),
        });
      }
      continue;
    }
    const allowedParents = MIDDLES[tag];
    if (allowedParents) {
      const top = stack[stack.length - 1];
      if (!top || !allowedParents.includes(top.tag)) {
        findings.push({
          severity: "error",
          code: "orphan_branch",
          section,
          message: `'{% ${tag} %}' appears outside any '{% if %}' block.`,
          suggestion: `Put the '{% ${tag} %}' inside an '{% if %}' ... '{% endif %}' block, or remove it.`,
          excerpt: excerptAround(text, index),
        });
      }
    }
  }
  for (const open of stack) {
    findings.push({
      severity: "error",
      code: "unclosed_block",
      section,
      message: `'{% ${open.tag} %}' is never closed with '{% end${open.tag} %}'.`,
      suggestion: `Add '{% end${open.tag} %}' at the end of the block.`,
      excerpt: excerptAround(text, open.index),
    });
  }
}

const CONDITION_KEYWORDS = /^(if|elif)\b/i;

/** The two semantics of `@(( ))` inside a statement that silently produce wrong behaviour. */
function checkJinjaExpressions(section: string, text: string, findings: Finding[]): void {
  for (const match of text.matchAll(/\{%-?([\s\S]*?)-?%\}/g)) {
    const body = match[1] ?? "";
    const statementIndex = match.index ?? 0;

    for (const ref of body.matchAll(/@\(\([^)]*\)\)/g)) {
      const at = ref.index ?? 0;
      const before = at > 0 ? body[at - 1] : undefined;
      const after = body[at + ref[0].length];
      const quoted = (before === '"' && after === '"') || (before === "'" && after === "'");
      if (!quoted) {
        findings.push({
          severity: "error",
          code: "unquoted_field_in_jinja",
          section,
          message:
            `${ref[0]} is used inside a '{% %}' statement without quotes. The value is substituted ` +
            "as text before Jinja evaluates, so unquoted it is parsed as an expression rather than " +
            "compared as a string.",
          suggestion: `Wrap it in double quotes: "${ref[0]}".`,
          excerpt: excerptAround(text, statementIndex),
        });
      }
    }

    const trimmed = body.trim();
    if (!CONDITION_KEYWORDS.test(trimmed)) continue;
    const condition = trimmed.replace(CONDITION_KEYWORDS, "").trim();
    // A bare (or negated) quoted field as the whole condition tests string truthiness -
    // and the string "False" is truthy, so the branch never behaves as written.
    if (/^\(*\s*(?:not\s+)?\(*\s*(["'])@\(\([^)]*\)\)\1\s*\)*$/i.test(condition)) {
      const negated = /^\(*\s*not\s/i.test(condition);
      findings.push({
        severity: "warning",
        code: "string_truthiness",
        section,
        message:
          "This condition tests a tool field for truthiness. The field is substituted as text, so a " +
          'boolean arrives as the string "True" or "False" - and "False" is truthy in Jinja, making ' +
          `the branch ${negated ? "never" : "always"} taken.`,
        suggestion:
          'Compare explicitly instead, e.g. == "True". Only keep a truthiness test if you mean ' +
          '"is this field empty".',
        excerpt: excerptAround(text, statementIndex),
      });
    }
  }
}

/** Reference existence checks, skipped wherever the vocabulary could not be read. */
function checkReferences(refs: PromptReference[], vocab: PromptVocabulary, findings: Finding[]): void {
  const variables = new Set(vocab.customVariables.map((v) => v.toLowerCase()));
  const preCallByName = new Map(vocab.preCallTools.map((t) => [t.name.toLowerCase(), t]));
  const onCallNames = new Set(vocab.onCallTools.map((t) => t.name.toLowerCase()));
  const attachedKbIds = new Set(vocab.knowledgeBases.map((k) => k.kb_id));

  for (const ref of refs) {
    if (ref.kind === "custom_variable") {
      if (!vocab.customVariablesKnown) continue;
      if (variables.has(ref.name.toLowerCase())) continue;
      findings.push({
        severity: "warning",
        code: "unknown_custom_variable",
        section: ref.section,
        message: ref.inJinja
          ? `'${ref.name}' is tested in a '{% %}' condition but is not a declared custom variable on ` +
            "this agent. It evaluates as undefined, so that branch is never taken and the prompt " +
            "silently falls through to the else."
          : `${ref.raw} is not a declared custom variable on this agent. The platform accepts the ` +
            "reference and interpolates it to nothing on a live call.",
        suggestion:
          `Add '${ref.name}' with update_custom_variables, or correct the spelling. Declared: ` +
          `${vocab.customVariables.join(", ") || "(none)"}.`,
      });
      continue;
    }

    if (ref.kind === "pre_call_field") {
      if (!vocab.toolsKnown) continue;
      const tool = preCallByName.get(ref.name.toLowerCase());
      if (!tool) {
        findings.push({
          severity: "warning",
          code: "unknown_pre_call_tool",
          section: ref.section,
          message: `${ref.raw} refers to a pre-call tool named '${ref.name}', which this agent does not have.`,
          suggestion:
            `Use one of this agent's pre-call tools: ${
              vocab.preCallTools.map((t) => t.name).join(", ") || "(none configured)"
            }.`,
        });
        continue;
      }
      if (!ref.path || tool.responseKeys.length === 0) continue;
      if (tool.responseKeys.includes(ref.path)) continue;
      const leaf = ref.path.split(".").pop()?.toLowerCase();
      const near = leaf
        ? tool.responseKeys.filter((k) => k.toLowerCase().endsWith(leaf)).slice(0, 3)
        : [];
      findings.push({
        severity: "warning",
        code: "unknown_field_path",
        section: ref.section,
        message:
          `'${ref.path}' is not one of the response keys '${ref.name}' returns, so ${ref.raw} ` +
          "interpolates to nothing.",
        suggestion:
          near.length > 0
            ? `Closest declared paths: ${near.join(", ")}.`
            : `Check the tool's responseSelectedKeys (${tool.responseKeys.length} declared) for the right path.`,
      });
      continue;
    }

    if (ref.kind === "on_call_tool") {
      if (!vocab.toolsKnown) continue;
      if (onCallNames.has(ref.name.toLowerCase())) continue;
      findings.push({
        severity: "warning",
        code: "unknown_on_call_tool",
        section: ref.section,
        message: `${ref.raw} invokes an on-call tool named '${ref.name}', which this agent does not have.`,
        suggestion:
          `Use one of this agent's on-call tools: ${
            vocab.onCallTools.map((t) => t.name).join(", ") || "(none configured)"
          }.`,
      });
      continue;
    }

    if (ref.kind === "knowledge_base") {
      if (!vocab.kbKnown || !ref.kbId) continue;
      if (attachedKbIds.has(ref.kbId)) continue;
      findings.push({
        severity: "warning",
        code: "kb_not_attached",
        section: ref.section,
        message:
          `The prompt references knowledge base '${ref.name}' (${ref.kbId}), which is not attached ` +
          "to this agent. The agent is told to consult a knowledge base it cannot read.",
        suggestion:
          `Attach it with attach_knowledge_base, or remove the reference. Attached: ${
            vocab.knowledgeBases.map((k) => k.kb_name ?? k.kb_id).join(", ") || "(none)"
          }.`,
      });
    }
  }
}

/** A bare '@name' matching a known KB name but carrying no chip binds to nothing. */
function checkUnboundKbMentions(
  section: string,
  text: string,
  boundNames: Set<string>,
  vocab: PromptVocabulary,
  findings: Finding[],
): void {
  if (vocab.knowledgeBases.length === 0) return;
  const byName = new Map<string, KbInfo>();
  for (const kb of vocab.knowledgeBases) {
    if (kb.kb_name) byName.set(kb.kb_name.toLowerCase(), kb);
  }
  if (byName.size === 0) return;

  const seen = new Set<string>();
  for (const match of text.matchAll(/@([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    const name = match[1];
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byName.has(key) || boundNames.has(key) || seen.has(key)) continue;
    seen.add(key);
    findings.push({
      severity: "warning",
      code: "kb_reference_without_binding",
      section,
      message:
        `'@${name}' reads as a knowledge base reference but carries no binding. A KB reference binds ` +
        "through the UUID on its mention chip, never through the visible text, so this is inert prose.",
      suggestion:
        `Insert the reference from the dashboard editor so it carries data-id="${byName.get(key)?.kb_id}", ` +
        "or reword the sentence so it does not look like a reference.",
      excerpt: excerptAround(text, match.index ?? 0),
    });
  }
}

/** Runs every check over the sections about to be written. */
export function validatePromptSections(
  sections: Array<{ section_title: string; section_content: string }>,
  vocab: PromptVocabulary,
): { findings: Finding[]; references: PromptReference[] } {
  const findings: Finding[] = [];
  const references: PromptReference[] = [];

  for (const section of sections) {
    const title = section.section_title;
    const text = stripHtml(section.section_content);
    const refs = extractReferences(title, section.section_content);
    references.push(...refs);

    checkJinjaStructure(title, text, findings);
    checkJinjaExpressions(title, text, findings);

    const boundKbNames = new Set(
      refs.filter((r) => r.kind === "knowledge_base").map((r) => r.name.toLowerCase()),
    );
    checkUnboundKbMentions(title, text, boundKbNames, vocab, findings);
  }

  checkReferences(references, vocab, findings);

  // One mistake reported once. A variable referenced twenty times is still one thing to
  // fix, and twenty copies of the same line would bury the rest of the report.
  const deduped: Finding[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.code} ${finding.section} ${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  deduped.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return { findings: deduped, references };
}

/** Compact 'what does this prompt reference' summary, for the write report. */
export function summarizeReferences(refs: PromptReference[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ref of refs) {
    const label = ref.kind === "pre_call_field" ? `${ref.name}.${ref.path ?? ""}` : ref.name;
    const list = out[ref.kind] ?? (out[ref.kind] = []);
    if (!list.includes(label)) list.push(label);
  }
  return out;
}
