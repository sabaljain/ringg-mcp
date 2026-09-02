/**
 * Knowledge base endpoints - read only.
 *
 * Create / edit / delete are deliberately not implemented. Attaching and detaching a KB
 * to an agent is an AGENT operation (PATCH /agent/v1), not a KB one; see agents.ts.
 *
 * Documented rate limits: 60 requests per hour per workspace for both read endpoints.
 */

import type { RinggClient } from "./client.js";
import { unwrapKbList, type Json } from "./normalize.js";

export interface KbSummary {
  kb_id?: string;
  kb_name?: string;
  type?: string;
  created_at?: string;
}

export interface KbFile {
  file_id?: string;
  filename?: string;
  file_type?: string;
  file_size?: number;
  file_path?: string;
}

export interface KbUrl {
  file_id?: string;
  url?: string;
  file_type?: string;
  file_size?: number;
}

export interface KbDetail {
  kb_id?: string;
  kb_name?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  files: KbFile[];
  urls: KbUrl[];
  faqs: unknown[];
  counts: { files: number; urls: number; faqs: number };
}

export async function listKnowledgeBases(client: RinggClient): Promise<KbSummary[]> {
  const res = await client.get("/external/kb/all");
  return unwrapKbList(res).map((kb) => ({
    kb_id: str(kb.kb_id) ?? str(kb.id),
    kb_name: str(kb.kb_name) ?? str(kb.name),
    type: str(kb.type),
    created_at: str(kb.created_at),
  }));
}

export async function getKnowledgeBase(client: RinggClient, kbId: string): Promise<KbDetail> {
  const res = (await client.get(`/external/kb/${encodeURIComponent(kbId)}`)) as Json;
  const kb = (res && typeof res === "object" && "data" in res && res.data && typeof res.data === "object"
    ? (res.data as Json)
    : res) ?? {};

  const files = asArray(kb.files);
  const urls = asArray(kb.urls);
  const faqs = asArray(kb.faqs);

  return {
    kb_id: str(kb.kb_id) ?? str(kb.id),
    kb_name: str(kb.kb_name) ?? str(kb.name),
    status: str(kb.status),
    created_at: str(kb.created_at),
    updated_at: str(kb.updated_at),
    files: files as KbFile[],
    urls: urls as KbUrl[],
    faqs,
    counts: { files: files.length, urls: urls.length, faqs: faqs.length },
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
