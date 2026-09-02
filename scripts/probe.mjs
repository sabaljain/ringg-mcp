#!/usr/bin/env node
/**
 * Live API probe. Run this ONCE against the test workspace before trusting the write
 * tools. It settles the three things docs.ringg.ai does not document:
 *
 *   1. Where prompt sections live inside `agent_config`, and their section_title values.
 *   2. Which custom-variable shape GET /agent/{id} actually returns.
 *   3. Whether knowledge base attachments come back singular or plural.
 *
 * Read-only. Makes no writes. Dumps raw JSON to ./probe-output/ (gitignored).
 *
 *   RINGG_API_KEY=... node scripts/probe.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";

const BASE = (process.env.RINGG_BASE_URL || "https://prod-api.ringg.ai/ca/api/v0").replace(/\/+$/, "");
const KEY = process.env.RINGG_API_KEY?.trim();
const OUT = "probe-output";

if (!KEY) {
  process.stderr.write("probe: RINGG_API_KEY is not set.\n");
  process.exit(1);
}

async function get(path, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "X-API-KEY": KEY, Accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function dump(name, value) {
  await writeFile(`${OUT}/${name}.json`, JSON.stringify(value, null, 2));
  process.stderr.write(`  wrote ${OUT}/${name}.json\n`);
}

function keysOf(obj) {
  return obj && typeof obj === "object" ? Object.keys(obj) : [];
}

/** Recursively find arrays that look like prompt sections. */
function findSectionArrays(node, path = "", depth = 0, hits = []) {
  if (depth > 8 || node === null || typeof node !== "object") return hits;
  if (Array.isArray(node)) {
    const looksLikeSections =
      node.length > 0 &&
      node.every((i) => i && typeof i === "object" && !Array.isArray(i)) &&
      node.some((i) => "section_title" in i || "title" in i || "section_name" in i);
    if (looksLikeSections) {
      hits.push({ path: path || "(root)", titles: node.map((i) => i.section_title ?? i.title ?? i.section_name) });
    }
    node.forEach((item, i) => findSectionArrays(item, `${path}[${i}]`, depth + 1, hits));
    return hits;
  }
  for (const [k, v] of Object.entries(node)) {
    findSectionArrays(v, path ? `${path}.${k}` : k, depth + 1, hits);
  }
  return hits;
}

/** Find any key whose name hints at a knowledge base. */
function findKbKeys(node, path = "", depth = 0, hits = []) {
  if (depth > 8 || node === null || typeof node !== "object") return hits;
  if (Array.isArray(node)) {
    node.forEach((item, i) => findKbKeys(item, `${path}[${i}]`, depth + 1, hits));
    return hits;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (/kb|knowledge/i.test(k)) {
      hits.push({ path: p, type: Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v, value: v });
    }
    findKbKeys(v, p, depth + 1, hits);
  }
  return hits;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const findings = [];
  const say = (s) => process.stderr.write(`${s}\n`);

  say("\n=== GET /workspace (auth check) ===");
  const ws = await get("/workspace");
  say(`  status ${ws.status}`);
  if (!ws.ok) {
    say("  Auth failed. Fix RINGG_API_KEY before continuing.");
    await dump("00-workspace", ws);
    process.exit(1);
  }

  say("\n=== GET /agent/all ===");
  const agents = await get("/agent/all", { limit: 20, offset: 0 });
  await dump("01-agent-all", agents);
  say(`  status ${agents.status}; top-level keys: ${keysOf(agents.body).join(", ")}`);
  const list =
    agents.body?.data?.agents ?? agents.body?.agents ?? (Array.isArray(agents.body) ? agents.body : []);
  say(`  agents returned: ${Array.isArray(list) ? list.length : "unknown"}`);
  if (Array.isArray(list) && list[0]) {
    const cv = list[0].custom_variables;
    const shape = Array.isArray(cv) ? `array(${cv.length})` : cv === null ? "null" : typeof cv;
    say(`  [list] custom_variables shape: ${shape}`);
    findings.push(`GET /agent/all custom_variables => ${shape}`);
  }

  const agentId = process.env.PROBE_AGENT_ID || (Array.isArray(list) && list[0]?.id);
  if (!agentId) {
    say("\nNo agent id available. Set PROBE_AGENT_ID to probe an agent's detail payload.");
    await dump("99-findings", findings);
    return;
  }

  say(`\n=== GET /agent/${agentId} ===`);
  const detail = await get(`/agent/${encodeURIComponent(agentId)}`);
  await dump("02-agent-detail", detail);
  say(`  status ${detail.status}; top-level keys: ${keysOf(detail.body).join(", ")}`);
  const agent = detail.body?.agents ?? detail.body?.agent ?? detail.body;
  say(`  agent keys: ${keysOf(agent).join(", ")}`);

  // 1. Prompt sections
  const sectionHits = findSectionArrays(agent);
  say("\n  -- prompt sections --");
  if (sectionHits.length === 0) {
    say("  NONE FOUND. Inspect 02-agent-detail.json by hand; agent_config keys:");
    say(`    ${keysOf(agent.agent_config).join(", ") || "(agent_config absent or not an object)"}`);
    findings.push("prompt sections: NOT FOUND by heuristic - inspect 02-agent-detail.json");
  } else {
    for (const hit of sectionHits) {
      say(`  at ${hit.path}`);
      say(`    titles: ${JSON.stringify(hit.titles)}`);
      findings.push(`prompt sections at ${hit.path} titles=${JSON.stringify(hit.titles)}`);
    }
  }

  // 2. Custom variables
  say("\n  -- custom variables --");
  for (const key of ["custom_variables", "form_fields", "variables"]) {
    if (key in (agent ?? {})) {
      const v = agent[key];
      const shape = Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
      say(`  ${key}: ${shape} => ${JSON.stringify(v)?.slice(0, 300)}`);
      findings.push(`GET /agent/{id} ${key} => ${shape}`);
    }
  }

  // 3. Knowledge bases
  say("\n  -- knowledge base fields --");
  const kbHits = findKbKeys(agent);
  if (kbHits.length === 0) {
    say("  no kb-ish keys found");
    findings.push("agent detail: no knowledge-base fields present");
  }
  for (const hit of kbHits) {
    say(`  ${hit.path}: ${hit.type} => ${JSON.stringify(hit.value)?.slice(0, 200)}`);
    findings.push(`agent detail kb field ${hit.path} => ${hit.type}`);
  }

  say("\n=== GET /external/kb/all ===");
  const kbs = await get("/external/kb/all");
  await dump("03-kb-all", kbs);
  say(`  status ${kbs.status}; ${Array.isArray(kbs.body) ? `bare array(${kbs.body.length})` : `object keys: ${keysOf(kbs.body).join(", ")}`}`);
  findings.push(`GET /external/kb/all => ${Array.isArray(kbs.body) ? "bare array" : "wrapped object"}`);

  say("\n=== GET /calling/history (no date params) ===");
  const history = await get("/calling/history", { limit: 3, offset: 0 });
  await dump("04-calling-history", history);
  say(`  status ${history.status}; top-level keys: ${keysOf(history.body).join(", ")}`);
  const calls = history.body?.calls ?? [];
  say(`  calls: ${calls.length}; total: ${history.body?.total}`);
  if (calls[0]) {
    say(`  row keys: ${keysOf(calls[0]).join(", ")}`);
    say(`  transcript present in list rows: ${"transcript" in calls[0]} <- list_calls must strip this`);
    findings.push(`GET /calling/history omitting dates => status ${history.status}, ${calls.length} rows returned`);
    findings.push(`history rows include transcript: ${"transcript" in calls[0]}`);
  }

  if (calls[0]?.id) {
    say(`\n=== GET /calling/call-details (id=${calls[0].id}) ===`);
    const cd = await get("/calling/call-details", { id: calls[0].id, send_analysis: true });
    await dump("05-call-details", cd);
    const data = cd.body?.data ?? cd.body;
    say(`  status ${cd.status}; data keys: ${keysOf(data).join(", ")}`);
    const t = data?.transcription_url;
    say(`  transcription_url type: ${Array.isArray(t) ? `array(${t.length})` : typeof t}`);
    findings.push(`transcription_url => ${Array.isArray(t) ? "array of turns" : typeof t}`);
  }

  await dump("99-findings", findings);
  say("\n=== FINDINGS ===");
  for (const f of findings) say(`  - ${f}`);
  say(`\nRaw payloads in ./${OUT}/ . Fold anything surprising into src/ringg/normalize.ts.\n`);
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
