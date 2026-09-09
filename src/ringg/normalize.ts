/**
 * Defensive readers for Ringg response shapes that the docs describe inconsistently
 * or not at all. Each function tolerates every shape the documentation implies and
 * reports what it actually found, so a wrong guess surfaces as a clear error rather
 * than a silently truncated write.
 *
 * See README "Documentation conflicts" for the specifics behind each of these.
 */

import { RinggShapeError } from "./errors.js";

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/* ------------------------------------------------------------------ envelopes */

/** GET /agent/all -> { status, data: { agents: [...] } }, with fallbacks. */
export function unwrapAgentList(res: unknown): Json[] {
  if (Array.isArray(res)) return res.filter(isObject);
  if (!isObject(res)) return [];
  const data = isObject(res.data) ? res.data : res;
  const agents = (data as Json).agents ?? (data as Json).items ?? (res as Json).agents;
  if (Array.isArray(agents)) return agents.filter(isObject);
  return [];
}

/** GET /agent/{id} -> { agents: {...} }. Note: singular object under a plural key. */
export function unwrapAgentDetail(res: unknown): Json {
  if (!isObject(res)) {
    throw new RinggShapeError("Ringg returned a non-object response for the agent detail request.");
  }
  const candidate = res.agents ?? res.agent ?? (isObject(res.data) ? (res.data as Json).agent ?? res.data : undefined);
  if (isObject(candidate)) return candidate;
  if (Array.isArray(candidate)) {
    const first: unknown = candidate[0];
    if (isObject(first)) return first;
  }
  // Some deployments may return the agent at the top level.
  if (typeof res.id === "string" || typeof res.agent_display_name === "string") return res;
  throw new RinggShapeError(
    `Could not locate the agent object in the response. Top-level keys: ${Object.keys(res).join(", ") || "(none)"}`,
  );
}

/** GET /external/kb/all -> bare array. */
export function unwrapKbList(res: unknown): Json[] {
  if (Array.isArray(res)) return res.filter(isObject);
  if (isObject(res)) {
    for (const key of ["data", "knowledge_bases", "kbs", "items"]) {
      const v = res[key];
      if (Array.isArray(v)) return v.filter(isObject);
    }
  }
  return [];
}

/** GET /calling/call-details -> { status, data: {...} }. */
export function unwrapCallDetail(res: unknown): Json {
  if (!isObject(res)) {
    throw new RinggShapeError("Ringg returned a non-object response for the call detail request.");
  }
  if (isObject(res.data)) return res.data;
  return res;
}

/* ------------------------------------------------------- agent versioning */

/**
 * Agents are versioned. This layer is not described in the API reference, but it is
 * where the configuration actually lives. The observed payload is:
 *
 *   agents.active_agent_version_id -> version_details[<version_id>]
 *     .agent_config.agent_prompt.prompt_sections   the prompt
 *     .agent_config.custom_variables               ["callee_name", ...]
 *     .agent_config.intro_message
 *     .knowledge_bases                             array (plural)
 *     .event_subscriptions
 *     .language / .voice / .tools
 *
 * Everything the docs describe as living on the agent actually lives on its active
 * version. `ab_versions` shows A/B variants are real, so targeting the ACTIVE version
 * rather than walking blindly matters: a blind search could read one variant while the
 * write lands on another.
 */
export interface ActiveVersion {
  versionId: string;
  version: Json;
  agentConfig: Json;
  /** True when the version was deduced rather than declared by active_agent_version_id. */
  inferred: boolean;
  /** How this version was chosen. */
  basis: "active_agent_version_id" | "call_traffic" | "only_version";
}

/**
 * Resolves which version's config is live.
 *
 * `active_agent_version_id` is null whenever `is_ab_live` is true. In that case the live
 * version is the `ab_versions` entry carrying the call traffic. This matters for
 * correctness, not just tidiness: on a real A/B agent the versions differ in their
 * knowledge base attachments, so reading the wrong one reports the wrong config.
 *
 * Returns null when the choice is genuinely ambiguous (a real traffic split across
 * several versions). Guessing there could mean reading one variant and writing another.
 */
export function getActiveVersion(agent: Json): ActiveVersion | null {
  const details = isObject(agent.version_details) ? agent.version_details : undefined;
  if (!details) return null;

  const build = (id: string, basis: ActiveVersion["basis"], inferred: boolean): ActiveVersion | null => {
    const version = details[id];
    if (!isObject(version)) return null;
    return {
      versionId: id,
      version,
      agentConfig: isObject(version.agent_config) ? version.agent_config : {},
      inferred,
      basis,
    };
  };

  const declared = asString(agent.active_agent_version_id);
  if (declared) {
    const built = build(declared, "active_agent_version_id", false);
    if (built) return built;
  }

  // A/B mode: pick the single version actually taking traffic.
  const ab = isObject(agent.ab_versions) ? agent.ab_versions : undefined;
  if (ab) {
    let leaders: string[] = [];
    let best = Number.NEGATIVE_INFINITY;
    for (const [id, meta] of Object.entries(ab)) {
      const traffic = isObject(meta) && typeof meta.call_traffic === "number" ? meta.call_traffic : 0;
      if (traffic > best) {
        best = traffic;
        leaders = [id];
      } else if (traffic === best) {
        leaders.push(id);
      }
    }
    const top = leaders[0];
    if (leaders.length === 1 && best > 0 && top) {
      const built = build(top, "call_traffic", true);
      if (built) return built;
    }
  }

  const ids = Object.keys(details);
  const only = ids[0];
  if (ids.length === 1 && only) {
    const built = build(only, "only_version", true);
    if (built) return built;
  }

  return null;
}

/**
 * Explains why no single version could be resolved, for surfacing to the caller.
 * Returns undefined when resolution succeeded or the payload is simply unversioned.
 */
export function describeVersionAmbiguity(agent: Json): string | undefined {
  if (getActiveVersion(agent) !== null) return undefined;
  const details = isObject(agent.version_details) ? agent.version_details : undefined;
  if (!details) return undefined;
  const ids = Object.keys(details);
  if (ids.length <= 1) return undefined;

  const ab = isObject(agent.ab_versions) ? agent.ab_versions : {};
  const split = Object.entries(ab)
    .map(([id, meta]) => {
      const slug = isObject(meta) ? (asString(meta.slug) ?? id.slice(0, 8)) : id.slice(0, 8);
      const traffic = isObject(meta) && typeof meta.call_traffic === "number" ? meta.call_traffic : 0;
      return `${slug}=${traffic}`;
    })
    .join(", ");
  return (
    `This agent has ${ids.length} versions, active_agent_version_id is not set, and the call ` +
    `traffic split does not identify a single live version (${split}). Config below could not ` +
    `be read. Resolve the A/B split in the Ringg dashboard, or inspect the versions directly.`
  );
}

/* --------------------------------------------------- custom variables */

/**
 * Extracts custom variable NAMES from an agent payload.
 *
 * Live API: `version_details.<active>.agent_config.custom_variables` is already an array
 * of plain strings - exactly the shape `edit_custom_vars` writes back.
 *
 * IMPORTANT: the agent's top-level `form_fields` is a different concept - template
 * builder inputs (agent_name, company_name, faq, intro_message) carrying their own
 * values. Because edit_custom_vars replaces the entire list, feeding form_fields keys
 * into it would overwrite the agent's real call variables, so it is never read here.
 */
export function extractCustomVariableNames(agent: Json): string[] {
  const active = getActiveVersion(agent);
  const candidates: unknown[] = [];
  if (active) candidates.push(active.agentConfig.custom_variables);
  candidates.push(agent.custom_variables);
  if (isObject(agent.agent_config)) candidates.push((agent.agent_config as Json).custom_variables);

  for (const source of candidates) {
    if (source === undefined || source === null) continue;

    if (Array.isArray(source)) {
      const names: string[] = [];
      for (const item of source) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed) names.push(trimmed);
        } else if (isObject(item)) {
          const name = asString(item.key) ?? asString(item.name) ?? asString(item.variable_name);
          if (name) names.push(name.trim());
        }
      }
      return dedupe(names);
    }

    // Documented (but not observed) object-map form: { callee_name: "string", ... }
    if (isObject(source)) {
      return dedupe(Object.keys(source).map((k) => k.trim()).filter(Boolean));
    }
  }

  return [];
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/* ------------------------------------------------- knowledge bases */

export interface KbAttachment {
  kb_id: string;
  kb_name?: string;
}

/**
 * Extracts attached knowledge bases, always as an array.
 *
 * Live API: `version_details.<active>.knowledge_bases` - plural, confirming an agent can
 * hold more than one. The documented singular `knowledge_base_id` on the agent root does
 * not exist on the wire; it is kept below only as a fallback.
 */
/**
 * Whether this agent's payload exposes knowledge base attachments at all.
 *
 * Verified against the live API: for multi-prompt (`multi_node`) agents, GET /agent/{id}
 * omits `knowledge_bases` entirely - yet `attach_kb` still succeeds and the platform
 * tracks it (a second attach returns 400 "Knowledge Base already attached"). So the
 * write path works while the read path is blind. Callers must not present an empty
 * array as evidence that nothing is attached.
 */
export function knowledgeBasesReadable(agent: Json): boolean {
  const active = getActiveVersion(agent);
  const containers: Json[] = [];
  if (active) containers.push(active.version);
  containers.push(agent);
  if (isObject(agent.agent_config)) containers.push(agent.agent_config as Json);
  return containers.some(
    (c) =>
      Array.isArray(c.knowledge_bases) ||
      typeof c.knowledge_base_id === "string" ||
      c.knowledge_base_id === null,
  );
}

export function extractKnowledgeBases(agent: Json): KbAttachment[] {
  const active = getActiveVersion(agent);
  const containers: Json[] = [];
  if (active) containers.push(active.version);
  containers.push(agent);
  if (isObject(agent.agent_config)) containers.push(agent.agent_config as Json);

  for (const container of containers) {
    for (const key of ["knowledge_bases", "knowledge_base", "kbs", "kb_ids", "knowledge_base_ids"]) {
      const value = container[key];
      if (!Array.isArray(value)) continue;
      const out: KbAttachment[] = [];
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          out.push({ kb_id: item.trim() });
        } else if (isObject(item)) {
          const id = asString(item.kb_id) ?? asString(item.id) ?? asString(item.knowledge_base_id);
          if (id) {
            const name = asString(item.kb_name) ?? asString(item.name) ?? asString(item.knowledge_base_name);
            out.push(name ? { kb_id: id, kb_name: name } : { kb_id: id });
          }
        }
      }
      if (out.length > 0) return out;
    }
  }

  for (const container of containers) {
    const id = asString(container.knowledge_base_id) ?? asString(container.kb_id);
    if (id) {
      const name = asString(container.knowledge_base_name) ?? asString(container.kb_name);
      return [name ? { kb_id: id, kb_name: name } : { kb_id: id }];
    }
  }

  return [];
}

/* ------------------------------------------------- prompt sections */

export interface PromptSection {
  section_title: string;
  section_content: string;
}

export interface PromptSectionsResult {
  sections: PromptSection[];
  /** Dotted path where the sections were found, for diagnostics. */
  sourcePath: string;
  /** True when sections were synthesized from flat fields rather than a section array. */
  synthesized: boolean;
  /** The agent version these sections belong to, when the payload is versioned. */
  versionId?: string;
  /** True when the active version had to be inferred rather than read. */
  versionInferred?: boolean;
}

/**
 * Field names used by POST /public/agent and PATCH /public/agent/{id} for the parts of
 * a prompt. If agent_config stores the prompt as flat fields rather than a section
 * array, these are reassembled into sections in this order.
 */
const FLAT_PROMPT_FIELDS: readonly string[] = [
  "intro_message",
  "introduction_and_objective",
  "task",
  "response_guidelines",
  "faq",
  "sample_conversations",
];

const SECTION_ARRAY_KEYS: readonly string[] = ["prompt_sections", "sections", "agent_prompt_sections"];

function toSection(item: unknown): PromptSection | undefined {
  if (!isObject(item)) return undefined;
  const title =
    asString(item.section_title) ?? asString(item.title) ?? asString(item.section_name) ?? asString(item.name);
  const content =
    asString(item.section_content) ??
    asString(item.content) ??
    asString(item.text) ??
    asString(item.value) ??
    "";
  if (!title) return undefined;
  return { section_title: title, section_content: content };
}

function looksLikeSectionArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((i) => toSection(i) !== undefined);
}

/**
 * Recursively searches an agent payload for its prompt sections.
 *
 * `agent_config` is documented only as a bare `object` with no properties, so the
 * location is discovered at runtime rather than assumed. Returns null when nothing
 * recognizable is found - callers must treat that as a hard error rather than writing
 * a prompt that would silently drop the sections they could not see.
 */
export function extractPromptSections(agent: Json): PromptSectionsResult | null {
  // Preferred path, confirmed against the live API:
  //   version_details.<active>.agent_config.agent_prompt.prompt_sections
  const active = getActiveVersion(agent);
  if (active) {
    const agentPrompt = active.agentConfig.agent_prompt;
    const direct = isObject(agentPrompt) ? agentPrompt.prompt_sections : undefined;
    if (looksLikeSectionArray(direct)) {
      return {
        sections: (direct as unknown[]).map((i) => toSection(i)!),
        sourcePath: `version_details.${active.versionId}.agent_config.agent_prompt.prompt_sections`,
        synthesized: false,
        versionId: active.versionId,
        versionInferred: active.inferred,
      };
    }
    // Same version, but the prompt sits somewhere else within it.
    const withinVersion = searchForSections(active.agentConfig, `version_details.${active.versionId}.agent_config`, 0);
    if (withinVersion) {
      return { ...withinVersion, versionId: active.versionId, versionInferred: active.inferred };
    }
  }

  // Unversioned or unexpected payload: fall back to a bounded search, but never walk
  // version_details blindly - picking a non-active A/B variant would be worse than failing.
  const roots: Array<[string, unknown]> = [
    ["agent_config", agent.agent_config],
    ["agent_prompt", agent.agent_prompt],
    ["prompt", agent.prompt],
  ];

  for (const [prefix, root] of roots) {
    if (root === undefined || root === null) continue;
    const found = searchForSections(root, prefix, 0);
    if (found) return found;
  }

  for (const [prefix, root] of roots) {
    if (!isObject(root)) continue;
    const synthesized = synthesizeFromFlatFields(root, prefix);
    if (synthesized) return synthesized;
  }

  return null;
}

function searchForSections(node: unknown, path: string, depth: number): PromptSectionsResult | null {
  if (depth > 6) return null;

  if (looksLikeSectionArray(node)) {
    return {
      sections: (node as unknown[]).map((i) => toSection(i)!).filter(Boolean),
      sourcePath: path || "(root)",
      synthesized: false,
    };
  }

  if (!isObject(node)) return null;

  // Prefer explicitly named keys before a blind walk.
  for (const key of SECTION_ARRAY_KEYS) {
    const value = node[key];
    if (looksLikeSectionArray(value)) {
      return {
        sections: (value as unknown[]).map((i) => toSection(i)!).filter(Boolean),
        sourcePath: joinPath(path, key),
        synthesized: false,
      };
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "object" || value === null) continue;
    const found = searchForSections(value, joinPath(path, key), depth + 1);
    if (found) return found;
  }

  return null;
}

function synthesizeFromFlatFields(node: Json, path: string): PromptSectionsResult | null {
  const present = FLAT_PROMPT_FIELDS.filter((f) => typeof node[f] === "string");
  if (present.length < 2) return null;
  return {
    sections: present.map((f) => ({ section_title: f, section_content: node[f] as string })),
    sourcePath: path || "(root)",
    synthesized: true,
  };
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * Merges `incoming` sections into `existing` by section_title.
 * Matching titles are overwritten in place; new titles are appended; untouched
 * existing sections are preserved. Title matching is case-insensitive and
 * whitespace-insensitive, but the existing title's spelling is kept.
 */
export function mergePromptSections(
  existing: PromptSection[],
  incoming: PromptSection[],
): { merged: PromptSection[]; updated: string[]; added: string[] } {
  const key = (t: string) => t.trim().toLowerCase();
  const merged = existing.map((s) => ({ ...s }));
  const updated: string[] = [];
  const added: string[] = [];

  for (const section of incoming) {
    const index = merged.findIndex((s) => key(s.section_title) === key(section.section_title));
    if (index >= 0) {
      const target = merged[index]!;
      target.section_content = section.section_content;
      updated.push(target.section_title);
    } else {
      merged.push({ ...section });
      added.push(section.section_title);
    }
  }

  return { merged, updated, added };
}

/* ------------------------------------------- agent-level / version-level fields */

/**
 * Reads a field that lives on the agent's active version.
 *
 * Observed placement is not consistent, so all three known homes are tried in order
 * and the one that answered is reported back:
 *
 *   version_details.<active>.<key>                custom_analysis_prompt, client_analysis,
 *                                                 analytics_context
 *   version_details.<active>.agent_config.<key>   intro_message, and analytics_context
 *                                                 again on some agents
 *   <root>.<key>                                  unversioned payloads
 *
 * `source` is surfaced by the tools so a caller can see where a value came from rather
 * than trusting an unexplained read.
 */
export function readVersionField(agent: Json, key: string): { value: unknown; source: string } {
  const active = getActiveVersion(agent);
  if (active) {
    if (active.version[key] !== undefined) {
      return { value: active.version[key], source: `version_details.${active.versionId}.${key}` };
    }
    if (active.agentConfig[key] !== undefined) {
      return {
        value: active.agentConfig[key],
        source: `version_details.${active.versionId}.agent_config.${key}`,
      };
    }
  }
  const cfg = isObject(agent.agent_config) ? agent.agent_config : undefined;
  if (cfg && cfg[key] !== undefined) return { value: cfg[key], source: `agent_config.${key}` };
  if (agent[key] !== undefined) return { value: agent[key], source: key };
  return {
    value: undefined,
    source: active
      ? `not present on version ${active.versionId}`
      : "not present (no active version could be resolved)",
  };
}

/**
 * Classification labels are stored on the agent, not on a version (section 4.3), and
 * were observed at the payload root as a flat `{ label: description }` map.
 */
export function extractClassificationLabels(agent: Json): Record<string, string> {
  const raw = agent.classification_labels;
  if (!isObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [label, description] of Object.entries(raw)) {
    if (typeof description === "string") out[label] = description;
  }
  return out;
}

export interface AbVersionInfo {
  version_id: string;
  slug?: string;
  description?: string | null;
  /** Share of traffic this version receives. Observed as 0 or 1 on non-split agents. */
  call_traffic?: number;
}

/**
 * `ab_versions` -> `{ <version_id>: { slug, description, call_traffic } }` at the root.
 * Returned as an array so the version id is never lost when the map is projected.
 */
export function extractAbVersions(agent: Json): AbVersionInfo[] {
  const raw = isObject(agent.ab_versions) ? agent.ab_versions : undefined;
  const details = isObject(agent.version_details) ? agent.version_details : undefined;
  const source = raw ?? details;
  if (!source) return [];
  const out: AbVersionInfo[] = [];
  for (const [versionId, value] of Object.entries(source)) {
    const v = isObject(value) ? value : {};
    out.push({
      version_id: versionId,
      slug: asString(v.slug) ?? asString(v.version_slug),
      description: typeof v.description === "string" ? v.description : null,
      call_traffic: typeof v.call_traffic === "number" ? v.call_traffic : undefined,
    });
  }
  return out;
}

/**
 * True when the stored intro message carries HTML markup.
 *
 * The dashboard editor stores rich text, and custom variables appear as mention spans
 * (`<span data-type="mention" data-id="{{callee_name}}">@{{callee_name}}</span>`).
 * `edit_intro_message` converts whatever it is given to text, so overwriting a rich
 * intro flattens it - the tools warn rather than letting that happen silently.
 */
export function looksLikeHtml(value: unknown): boolean {
  return typeof value === "string" && /<\/?[a-z][^>]*>/i.test(value);
}
