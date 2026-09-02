/**
 * Call history endpoints - read only. Nothing here initiates or terminates a call.
 */

import type { RinggClient } from "./client.js";
import { unwrapCallDetail, type Json } from "./normalize.js";

export const CALL_STATUSES = [
  "registered",
  "ongoing",
  "retry",
  "error",
  "completed",
  "failed",
  "cancelled",
  "forwarded",
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_VIEWS = ["summary", "transcript", "analysis", "full"] as const;
export type CallView = (typeof CALL_VIEWS)[number];

export interface ListCallsParams {
  limit: number;
  offset: number;
  agent_id?: string;
  status?: CallStatus;
  bulk_list_id?: string;
  start_date?: string;
  end_date?: string;
}

export interface CallSummary {
  id?: string;
  to_number?: string;
  name?: string;
  status?: string;
  sub_status?: string;
  call_duration?: number;
  call_cost?: number;
  call_type?: string;
  inbound_from?: string | null;
  agent?: { id?: string; agent_name?: string };
  created_at?: string;
  call_attempt_time?: string;
  has_recording: boolean;
  has_transcript: boolean;
}

export interface ListCallsResult {
  calls: CallSummary[];
  limit?: number;
  offset?: number;
  count?: number;
  /** The live API returns either a number or the string "many". Passed through as-is. */
  total?: number | string;
  note: string;
}

/**
 * GET /calling/history.
 *
 * The upstream endpoint returns the FULL transcript inline on every row. This function
 * strips it - callers get summaries only and must use get_call for transcript content.
 * The recording URL is likewise omitted (it expires 24h after the call and is noise in
 * a list); `has_recording` records whether one was present.
 *
 * start_date / end_date are omitted unless supplied. The spec carries stale hardcoded
 * defaults (2025-09-25) which must not be relied on.
 */
export async function listCalls(client: RinggClient, params: ListCallsParams): Promise<ListCallsResult> {
  const res = (await client.get("/calling/history", {
    limit: params.limit,
    offset: params.offset,
    agent_id: params.agent_id,
    status: params.status,
    bulk_list_id: params.bulk_list_id,
    start_date: params.start_date,
    end_date: params.end_date,
  })) as Json;

  const rawCalls = Array.isArray(res?.calls)
    ? res.calls
    : Array.isArray((res as Json)?.data)
      ? ((res as Json).data as unknown[])
      : [];

  return {
    calls: rawCalls.filter(isObj).map(toCallSummary),
    limit: num(res?.limit) ?? params.limit,
    offset: num(res?.offset) ?? params.offset,
    count: num(res?.count),
    total: typeof res?.total === "number" || typeof res?.total === "string" ? res.total : undefined,
    note: "Summaries only. Transcripts and recordings are omitted here - use get_call with view=transcript or view=full for a specific call.",
  };
}

function toCallSummary(call: Json): CallSummary {
  const agent = isObj(call.agent) ? call.agent : undefined;
  const transcript = call.transcript;
  return {
    id: str(call.id),
    to_number: str(call.to_number),
    name: str(call.name),
    status: str(call.status),
    sub_status: str(call.sub_status),
    call_duration: num(call.call_duration),
    call_cost: num(call.call_cost),
    call_type: str(call.call_type),
    inbound_from: (call.inbound_from as string | null) ?? null,
    agent: agent ? { id: str(agent.id), agent_name: str(agent.agent_name) } : undefined,
    created_at: str(call.created_at),
    call_attempt_time: str(call.call_attempt_time),
    has_recording: Boolean(call.audio_recording),
    has_transcript:
      (typeof transcript === "string" && transcript.length > 0) ||
      (Array.isArray(transcript) && transcript.length > 0),
  };
}

export interface TranscriptTurn {
  speaker: "agent" | "user" | "unknown";
  text: string;
  timestamp?: string;
}

export interface CallDetailResult {
  id?: string;
  call_direction?: string;
  call_status?: string;
  call_sub_status?: string;
  from_number?: string;
  to_number?: string;
  callee_name?: string;
  agent_id?: string;
  initiation_time?: string;
  recording_url?: string;
  recording_note?: string;
  transcript?: TranscriptTurn[];
  platform_analysis?: unknown;
  client_analysis?: unknown;
  view: CallView;
}

/**
 * GET /calling/call-details.
 *
 * One upstream request. `view` selects send_analysis and projects the response:
 *   summary    send_analysis=false  metadata only
 *   transcript send_analysis=false  metadata + conversation turns
 *   analysis   send_analysis=true   metadata + platform/client analysis
 *   full       send_analysis=true   everything
 */
export async function getCall(client: RinggClient, callId: string, view: CallView): Promise<CallDetailResult> {
  const sendAnalysis = view === "analysis" || view === "full";
  const res = await client.get("/calling/call-details", { id: callId, send_analysis: sendAnalysis });
  const data = unwrapCallDetail(res);

  const out: CallDetailResult = {
    id: str(data.id),
    call_direction: str(data.call_direction),
    call_status: str(data.call_status),
    call_sub_status: str(data.call_sub_status),
    from_number: str(data.from_number),
    to_number: str(data.to_number),
    callee_name: str(data.callee_name),
    agent_id: str(data.agent_id),
    initiation_time: str(data.initiation_time),
    view,
  };

  const recording = str(data.recording_url);
  if (recording) {
    out.recording_url = recording;
    out.recording_note = "Recording URLs expire 24 hours after the call. Download it within that window to retain it.";
  }

  if (view === "transcript" || view === "full") {
    // Despite the name, `transcription_url` is an array of conversation turns.
    out.transcript = normalizeTranscript(data.transcription_url ?? data.transcript);
  }

  if (sendAnalysis) {
    out.platform_analysis = data.platform_analysis;
    out.client_analysis = data.client_analysis;
  }

  return out;
}

function normalizeTranscript(value: unknown): TranscriptTurn[] {
  if (typeof value === "string") {
    // Some responses carry a JSON-encoded array of turns as a string.
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeTranscript(parsed);
    } catch {
      return value.trim() ? [{ speaker: "unknown", text: value }] : [];
    }
    return [];
  }
  if (!Array.isArray(value)) return [];

  const turns: TranscriptTurn[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim()) turns.push({ speaker: "unknown", text: item });
      continue;
    }
    if (!isObj(item)) continue;
    const bot = str(item.bot) ?? str(item.agent) ?? str(item.assistant);
    const user = str(item.user) ?? str(item.customer) ?? str(item.human);
    const ts = str(item.timestamp);
    if (bot !== undefined) turns.push(ts ? { speaker: "agent", text: bot, timestamp: ts } : { speaker: "agent", text: bot });
    if (user !== undefined) turns.push(ts ? { speaker: "user", text: user, timestamp: ts } : { speaker: "user", text: user });
    if (bot === undefined && user === undefined) {
      const role = str(item.role) ?? str(item.speaker);
      const text = str(item.text) ?? str(item.content) ?? str(item.message);
      if (text !== undefined) {
        const speaker: TranscriptTurn["speaker"] =
          role === "user" || role === "customer" ? "user" : role ? "agent" : "unknown";
        turns.push({ speaker, text });
      }
    }
  }
  return turns;
}

function isObj(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
