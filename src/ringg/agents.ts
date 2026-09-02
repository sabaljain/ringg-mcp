/**
 * Agent (assistant) endpoints.
 *
 * All writes go through PATCH /agent/v1 with an `operation` discriminator.
 * PATCH /public/agent/{agent_id} is deliberately unused: docs.ringg.ai/AGENTS.md states
 * it is not to be treated as a public documented endpoint.
 */

import type { RinggClient } from "./client.js";
import {
  extractCustomVariableNames,
  extractKnowledgeBases,
  describeVersionAmbiguity,
  extractPromptSections,
  getActiveVersion,
  isObject,
  knowledgeBasesReadable,
  unwrapAgentDetail,
  unwrapAgentList,
  type Json,
  type KbAttachment,
  type PromptSection,
  type PromptSectionsResult,
} from "./normalize.js";

/** Operations accepted by PATCH /agent/v1 that this server uses. */
export type AgentEditOperation = "edit_prompt" | "edit_custom_vars" | "attach_kb" | "remove_kb";

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
  tools?: unknown;
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
  prompt: {
    sections: PromptSection[] | null;
    /** Where the sections were found, or why they were not. */
    source: string;
    synthesized: boolean;
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

export async function getAgent(client: RinggClient, agentId: string): Promise<AgentDetail> {
  const agent = await getAgentRaw(client, agentId);
  return toAgentDetail(agent);
}

export function toAgentDetail(agent: Json): AgentDetail {
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
    tools: pick("tools"),
    custom_variables: extractCustomVariableNames(agent),
    form_fields: agent.form_fields,
    knowledge_bases: extractKnowledgeBases(agent),
    knowledge_bases_readable: knowledgeBasesReadable(agent),
    event_subscriptions: v.event_subscriptions,
    prompt: {
      sections: prompt?.sections ?? null,
      source: prompt
        ? `found at ${prompt.sourcePath}${prompt.synthesized ? " (synthesized from flat prompt fields)" : ""}` +
          (prompt.versionInferred ? " [active version was inferred, not declared]" : "")
        : "not found - the agent payload contains no recognizable prompt sections",
      synthesized: prompt?.synthesized ?? false,
    },
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

/** PATCH /agent/v1 - the single write path for every agent mutation. */
export async function editAgent(
  client: RinggClient,
  operation: AgentEditOperation,
  agentId: string,
  payload: Record<string, unknown>,
): Promise<EditAgentResult> {
  const body = { operation, agent_id: agentId, ...payload };
  const res = await client.patch<EditAgentResult>("/agent/v1", body);
  return (res ?? {}) as EditAgentResult;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
