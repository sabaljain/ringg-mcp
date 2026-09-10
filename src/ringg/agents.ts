/**
 * Agent (assistant) endpoints.
 *
 * All writes go through PATCH /agent/v1 with an `operation` discriminator.
 * PATCH /public/agent/{agent_id} is deliberately unused: docs.ringg.ai/AGENTS.md states
 * it is not to be treated as a public documented endpoint.
 *
 * The authoritative contract for the write path is docs/edit-agent-api.md (platform
 * reference for PATCH /ca/api/v0/agent/v1). Section numbers cited below refer to it.
 */

import type { RinggClient } from "./client.js";
import { RinggShapeError } from "./errors.js";
import {
  extractAbVersions,
  extractClassificationLabels,
  extractCustomVariableNames,
  extractKnowledgeBases,
  describeVersionAmbiguity,
  extractPromptSections,
  getActiveVersion,
  isObject,
  knowledgeBasesReadable,
  readVersionField,
  unwrapAgentDetail,
  unwrapAgentList,
  type AbVersionInfo,
  type Json,
  type KbAttachment,
  type PromptSection,
  type PromptSectionsResult,
} from "./normalize.js";
import {
  extractPhaseTools,
  extractPromptVocabulary,
  summarizeReferences,
  validatePromptSections,
  type Finding,
  type PhaseTools,
} from "./prompt-refs.js";

/**
 * Operations accepted by PATCH /agent/v1 that this server drives.
 *
 * The endpoint accepts ~60 operations (docs/edit-agent-api.md section 4) covering voice,
 * call config, tools, A/B versions and the multi-node flow graph. This server exposes
 * the subset below on purpose; see tools/registry.ts for the scope rationale.
 */
export type AgentEditOperation =
  | "edit_prompt"
  | "edit_custom_vars"
  | "attach_kb"
  | "remove_kb"
  | "edit_intro_message"
  | "edit_agent_display_name"
  | "edit_custom_analysis_prompt"
  | "edit_client_analysis"
  | "edit_classification_labels"
  | "edit_analytics_context"
  | "add_new_ab_version"
  | "edit_traffic"
  | "toggle_ab_testing";

/**
 * A/B operations act on the agent itself rather than on a version's config, and the
 * reference is explicit that they never take `is_draft` (section 2). Passing a version
 * to one of these would be meaningless at best, so the tools that use them send none.
 */
export const AB_OPERATIONS: readonly AgentEditOperation[] = [
  "add_new_ab_version",
  "edit_traffic",
  "toggle_ab_testing",
];

/**
 * Which copy of the runtime config an edit targets. Only meaningful for agents whose
 * `agent_type` is `outbound_inbound`; every other agent type ignores it (section 2).
 */
export type ConfigType = "outbound" | "inbound";

/**
 * Fields every operation accepts alongside its own payload (section 2).
 *
 * `versionId` is the important one: agents are versioned and the config lives on a
 * version, so pinning the write to the version we just read is what keeps read and
 * write in agreement on an A/B agent. Omitted, the backend picks the active version
 * (falling back to the most recently updated non-archived one).
 */
export interface EditAgentOptions {
  /** Target agent version. Omit to let the backend resolve the active version. */
  versionId?: string;
  /** Multi-node agents only: edit the draft of `versionId`. Requires `versionId`. */
  isDraft?: boolean;
  /** Caller's belief that no draft exists yet. An existing draft is adopted either way. */
  newDraft?: boolean;
  /** Routes runtime-config edits to the inbound copy on an `outbound_inbound` agent. */
  configType?: ConfigType;
}

export interface AgentSummary {
  id?: string;
  agent_display_name?: string;
  agent_type?: string;
  template_name?: string;
  template_label?: string;
  template_type?: string;
  call_count?: number;
  is_archived?: boolean;
  custom_variables: string[];
  created_at?: string;
  updated_at?: string;
}

export interface AgentVersionInfo {
  active_version_id?: string;
  version_slug?: string;
  /** True when the active version was deduced rather than declared. */
  inferred: boolean;
  /** How the version was chosen: declared id, call traffic, or sole version. */
  basis?: "active_agent_version_id" | "call_traffic" | "only_version";
  /** All version ids present, so A/B variants are visible. */
  all_version_ids: string[];
  ab_live?: boolean;
  /** Set when no single live version could be resolved; config fields will be empty. */
  unresolved?: string;
}

export interface AgentDetail {
  id?: string;
  agent_display_name?: string;
  agent_type?: string;
  orchestration_mode?: string;
  /** Which version the fields below were read from. Writes target the active version. */
  version: AgentVersionInfo;
  language?: string;
  secondary_language?: string | null;
  voice?: unknown;
  secondary_voice_id?: string | null;
  intro_message?: string;
  whitelisted_domains?: unknown;
  template_name?: string;
  template_label?: string;
  template_type?: string;
  created_at?: string;
  updated_at?: string;
  /** Tools split by phase. `readable: false` means the payload exposed none to read. */
  tools?: PhaseTools;
  /** Names only. NOT the same as form_fields - see normalize.ts. */
  custom_variables: string[];
  /**
   * Template builder inputs (agent_name, company_name, faq, ...) with their values.
   * A different concept from custom_variables; surfaced so the two are not confused.
   */
  form_fields?: unknown;
  knowledge_bases: KbAttachment[];
  /**
   * False when the payload does not expose attachments (multi-prompt agents). An empty
   * knowledge_bases array is then "unknown", not "none".
   */
  knowledge_bases_readable: boolean;
  /** Configured webhook subscriptions. Read-only here - editing them is out of scope. */
  event_subscriptions?: unknown;
  /** `{ label: description }`, stored on the agent rather than on a version. */
  classification_labels: Record<string, string>;
  /** Post-call extraction config: `{ prompt, keys, defaults }`, or null when unset. */
  custom_analysis_prompt?: unknown;
  /** `{ context, goal_key, keys, revenue }`, or null when unset. */
  client_analysis?: unknown;
  /** `{ platform_analytics: {...}, client_analytics: {...} }`. */
  analytics_context?: unknown;
  /** Every A/B version with its slug and traffic share. */
  ab_versions: AbVersionInfo[];
  prompt: {
    /** Null when none were found; absent entirely when include_prompt was false. */
    sections?: PromptSection[] | null;
    /** Set instead of `sections` when the caller asked to omit the prompt body. */
    sections_omitted?: true;
    /** Titles are kept even when the bodies are omitted: writes are matched by title. */
    section_titles?: string[] | null;
    /** Where the sections were found, or why they were not. */
    source: string;
    synthesized: boolean;
    /** What the prompt references, by kind. See prompt-refs.ts for the grammar. */
    references?: Record<string, string[]>;
    /** References that will not resolve on a live call. Absent when there are none. */
    issues?: Finding[];
  };
}

export interface ListAgentsParams {
  limit: number;
  offset: number;
}

export async function listAgents(
  client: RinggClient,
  params: ListAgentsParams,
): Promise<{ agents: AgentSummary[]; limit: number; offset: number; count: number }> {
  // limit/offset are always sent explicitly: the spec's own default (10) contradicts
  // its parameter description and api-overview.md (both say 20).
  const res = await client.get("/agent/all", { limit: params.limit, offset: params.offset });
  const raw = unwrapAgentList(res);
  const agents = raw.map(toAgentSummary);
  return { agents, limit: params.limit, offset: params.offset, count: agents.length };
}

function toAgentSummary(agent: Json): AgentSummary {
  return {
    id: str(agent.id),
    agent_display_name: str(agent.agent_display_name),
    agent_type: str(agent.agent_type),
    template_name: str(agent.template_name),
    template_label: str(agent.template_label),
    template_type: str(agent.template_type),
    call_count: typeof agent.call_count === "number" ? agent.call_count : undefined,
    is_archived: typeof agent.is_archived === "boolean" ? agent.is_archived : undefined,
    custom_variables: extractCustomVariableNames(agent),
    created_at: str(agent.created_at),
    updated_at: str(agent.updated_at),
  };
}

/** Fetches an agent and returns both the normalized view and the raw payload. */
export async function getAgentRaw(client: RinggClient, agentId: string): Promise<Json> {
  const res = await client.get(`/agent/${encodeURIComponent(agentId)}`);
  return unwrapAgentDetail(res);
}

export interface AgentDetailOptions {
  /**
   * Include the prompt section bodies. Default true.
   *
   * The bodies are 78-96% of a large agent's payload, enough to push a single read past
   * what a tool result can carry. Omitting them keeps the titles, the referenceable
   * vocabulary and the reference audit - everything needed to prepare a prompt write.
   */
  includePrompt?: boolean;
}

export async function getAgent(
  client: RinggClient,
  agentId: string,
  options: AgentDetailOptions = {},
): Promise<AgentDetail> {
  const agent = await getAgentRaw(client, agentId);
  return toAgentDetail(agent, options);
}

export function toAgentDetail(agent: Json, options: AgentDetailOptions = {}): AgentDetail {
  const includePrompt = options.includePrompt !== false;
  const prompt = extractPromptSections(agent);
  const active = getActiveVersion(agent);

  // Config lives on the agent's active version, not on the agent itself. Read from the
  // version first and fall back to the agent root for unversioned payloads.
  const v: Json = active?.version ?? {};
  const cfg: Json = active?.agentConfig ?? (isObject(agent.agent_config) ? agent.agent_config : {});
  const pick = (key: string): unknown => (v[key] !== undefined ? v[key] : agent[key]);

  const versionDetails = isObject(agent.version_details) ? agent.version_details : undefined;

  return {
    id: str(agent.id),
    agent_display_name: str(agent.agent_display_name),
    agent_type: str(agent.agent_type),
    orchestration_mode: str(agent.orchestration_mode),
    version: {
      active_version_id: active?.versionId ?? str(agent.active_agent_version_id),
      version_slug: str(v.version_slug),
      inferred: active?.inferred ?? false,
      basis: active?.basis,
      all_version_ids: versionDetails ? Object.keys(versionDetails) : [],
      ab_live: typeof agent.is_ab_live === "boolean" ? agent.is_ab_live : undefined,
      unresolved: describeVersionAmbiguity(agent),
    },
    language: str(pick("language")),
    secondary_language: (pick("secondary_language") as string | null) ?? null,
    voice: pick("voice"),
    secondary_voice_id: (pick("secondary_voice_id") as string | null) ?? null,
    intro_message: str(cfg.intro_message),
    whitelisted_domains: pick("whitelisted_domains"),
    template_name: str(agent.template_name),
    template_label: str(agent.template_label),
    template_type: str(agent.template_type),
    created_at: str(agent.created_at),
    updated_at: str(agent.updated_at),
    tools: extractPhaseTools(agent),
    custom_variables: extractCustomVariableNames(agent),
    form_fields: agent.form_fields,
    knowledge_bases: extractKnowledgeBases(agent),
    knowledge_bases_readable: knowledgeBasesReadable(agent),
    event_subscriptions: v.event_subscriptions,
    classification_labels: extractClassificationLabels(agent),
    custom_analysis_prompt: readVersionField(agent, "custom_analysis_prompt").value,
    client_analysis: readVersionField(agent, "client_analysis").value,
    analytics_context: readVersionField(agent, "analytics_context").value,
    ab_versions: extractAbVersions(agent),
    prompt: {
      // The audit runs either way: it is computed from the sections, not from whether
      // the caller wanted them echoed back, so omitting the bodies loses no diagnostics.
      ...(includePrompt
        ? { sections: prompt?.sections ?? null }
        : {
            sections_omitted: true as const,
            section_titles: prompt?.sections.map((s) => s.section_title) ?? null,
          }),
      source: prompt
        ? `found at ${prompt.sourcePath}${prompt.synthesized ? " (synthesized from flat prompt fields)" : ""}` +
          (prompt.versionInferred ? " [active version was inferred, not declared]" : "")
        : "not found - the agent payload contains no recognizable prompt sections",
      synthesized: prompt?.synthesized ?? false,
      ...auditPrompt(agent, prompt),
    },
  };
}

/**
 * What the prompt references, and anything wrong with it.
 *
 * Reported on a plain read so a broken reference can be found by looking at the agent,
 * rather than only by attempting a write. Every issue here is one the platform accepts
 * silently: a variable that interpolates to nothing, a knowledge base that is referenced
 * but not attached, a tool field path that does not exist.
 */
function auditPrompt(
  agent: Json,
  prompt: PromptSectionsResult | null,
): { references?: Record<string, string[]>; issues?: Finding[] } {
  if (!prompt || prompt.sections.length === 0) return {};
  const vocabulary = extractPromptVocabulary(
    agent,
    extractCustomVariableNames(agent),
    extractKnowledgeBases(agent),
  );
  const { findings, references } = validatePromptSections(prompt.sections, vocabulary);
  return {
    references: summarizeReferences(references),
    ...(findings.length > 0 ? { issues: findings } : {}),
  };
}

/** Reads an agent and returns its prompt sections, or null if none could be located. */
export async function getPromptSections(
  client: RinggClient,
  agentId: string,
): Promise<{ agent: Json; prompt: PromptSectionsResult | null }> {
  const agent = await getAgentRaw(client, agentId);
  return { agent, prompt: extractPromptSections(agent) };
}

export interface EditAgentResult {
  message?: string;
  agent_id?: string;
  [key: string]: unknown;
}

/**
 * PATCH /agent/v1 - the single write path for every agent mutation.
 *
 * `options` carries the common envelope fields (section 2). `is_draft` and `new_draft`
 * are only sent together, and only when a draft edit is actually requested: sending
 * `is_draft: true` without a `version_id` is a schema error upstream, so it is caught
 * here with a message that says what to do instead.
 */
export async function editAgent(
  client: RinggClient,
  operation: AgentEditOperation,
  agentId: string,
  payload: Record<string, unknown>,
  options: EditAgentOptions = {},
): Promise<EditAgentResult> {
  if (options.isDraft && !options.versionId) {
    throw new RinggShapeError(
      "Editing a draft requires the version it belongs to. Supply version_id (get_agent " +
        "reports the agent's version ids) or drop is_draft to edit the active version directly.",
    );
  }

  const body: Record<string, unknown> = { operation, agent_id: agentId, ...payload };
  if (options.versionId) body.version_id = options.versionId;
  if (options.isDraft !== undefined) {
    body.is_draft = options.isDraft;
    // Always paired: the backend adopts an existing draft either way, so false is safe.
    body.new_draft = options.newDraft ?? false;
  }
  if (options.configType) body.config_type = options.configType;

  const res = await client.patch<EditAgentResult>("/agent/v1", body);
  return (res ?? {}) as EditAgentResult;
}

/**
 * The version id a write should be pinned to, or undefined when it cannot be resolved.
 *
 * Returns the version `getActiveVersion()` read from, so a tool that reads-merges-writes
 * lands its write on the version it based the merge on. Undefined means "let the backend
 * choose" - which is correct for unversioned payloads and for a genuinely ambiguous A/B
 * split, where the calling tool warns rather than guessing.
 */
export function resolveWriteVersionId(agent: Json): string | undefined {
  const active = getActiveVersion(agent);
  if (active) return active.versionId;
  return typeof agent.active_agent_version_id === "string" ? agent.active_agent_version_id : undefined;
}

/**
 * Whether an edit to this agent's runtime config needs a `config_type` decision.
 * Only `outbound_inbound` agents keep two copies of the config (section 2).
 */
export function hasSplitConfig(agent: Json): boolean {
  return agent.agent_type === "outbound_inbound";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
