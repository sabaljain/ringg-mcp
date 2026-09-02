#!/usr/bin/env node
/**
 * stdio smoke test. Spawns the built server, speaks JSON-RPC over stdin/stdout, and
 * asserts that EVERY stdout line is valid JSON-RPC - the core stdio safety property.
 *
 *   node scripts/smoke.mjs                      # protocol + tools/list only
 *   node scripts/smoke.mjs --live               # also calls the read-only tools
 *
 * Requires RINGG_API_KEY. Never calls a write tool.
 */

import { spawn } from "node:child_process";

const LIVE = process.argv.includes("--live");
const EXPECTED_TOOLS = [
  "list_agents",
  "get_agent",
  "list_knowledge_bases",
  "get_knowledge_base",
  "list_calls",
  "get_call",
  "update_agent_prompt",
  "update_custom_variables",
  "attach_knowledge_base",
  "detach_knowledge_base",
];

if (!process.env.RINGG_API_KEY) {
  process.stderr.write("smoke: RINGG_API_KEY is not set.\n");
  process.exit(1);
}

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let stdoutBuf = "";
const messages = [];
const badLines = [];
const pending = new Map();

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc !== "2.0") badLines.push(line);
      messages.push(msg);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // A non-JSON line on stdout means the JSON-RPC stream is corrupted.
      badLines.push(line);
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(`  [server stderr] ${c}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
  const done = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return done;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stderr.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}\n`);
}

function textOf(res) {
  return res?.result?.content?.map((c) => c.text).join("\n") ?? "";
}

async function main() {
  process.stderr.write("\n=== stdio smoke test ===\n");

  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("initialize", Boolean(init.result?.serverInfo?.name), init.result?.serverInfo?.name);
  notify("notifications/initialized");

  const list = await send("tools/list");
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list returns 10 tools", names.length === 10, `got ${names.length}`);
  check(
    "tool names match the agreed scope",
    JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    names.join(", "),
  );
  const noCallingTools = !names.some((n) => /campaign|initiate|terminate|dial|create_kb|delete/i.test(n));
  check("no out-of-scope tools exposed", noCallingTools);
  check(
    "every tool has an input schema",
    (list.result?.tools ?? []).every((t) => t.inputSchema && t.inputSchema.type === "object"),
  );

  if (LIVE) {
    process.stderr.write("\n--- live read-only calls ---\n");

    const agentsRes = await send("tools/call", { name: "list_agents", arguments: { limit: 5 } });
    const agentsOk = !agentsRes.result?.isError;
    check("list_agents", agentsOk, agentsOk ? "" : textOf(agentsRes).slice(0, 200));

    let agentId;
    if (agentsOk) {
      try {
        agentId = JSON.parse(textOf(agentsRes)).agents?.[0]?.id;
      } catch {}
    }

    if (agentId) {
      const one = await send("tools/call", { name: "get_agent", arguments: { agent_id: agentId } });
      const ok = !one.result?.isError;
      check("get_agent", ok, ok ? "" : textOf(one).slice(0, 200));
      if (ok) {
        const parsed = JSON.parse(textOf(one));
        check("get_agent normalizes knowledge_bases to an array", Array.isArray(parsed.knowledge_bases));
        check("get_agent reports prompt section source", typeof parsed.prompt?.source === "string", parsed.prompt?.source);
        check("get_agent returns custom_variables as an array", Array.isArray(parsed.custom_variables));
      }
    } else {
      check("get_agent", false, "no agent id available to test with");
    }

    const kbRes = await send("tools/call", { name: "list_knowledge_bases", arguments: {} });
    check("list_knowledge_bases", !kbRes.result?.isError, textOf(kbRes).slice(0, 120));

    const callsRes = await send("tools/call", { name: "list_calls", arguments: { limit: 3 } });
    const callsOk = !callsRes.result?.isError;
    check("list_calls", callsOk, callsOk ? "" : textOf(callsRes).slice(0, 200));
    if (callsOk) {
      const raw = textOf(callsRes);
      check("list_calls strips transcripts", !/"transcript"\s*:/.test(raw));
      let callId;
      try {
        callId = JSON.parse(raw).calls?.[0]?.id;
      } catch {}
      if (callId) {
        for (const view of ["summary", "transcript", "analysis", "full"]) {
          const r = await send("tools/call", { name: "get_call", arguments: { call_id: callId, view } });
          const ok = !r.result?.isError;
          check(`get_call view=${view}`, ok, ok ? "" : textOf(r).slice(0, 160));
          if (ok && view === "summary") {
            check("get_call summary omits transcript", !/"transcript"\s*:/.test(textOf(r)));
          }
        }
      }
    }

    const bad = await send("tools/call", {
      name: "get_agent",
      arguments: { agent_id: "00000000-0000-0000-0000-000000000000" },
    });
    check("unknown agent returns a tool error, not a crash", bad.result?.isError === true, textOf(bad).slice(0, 160));
  }

  // The headline stdio assertion.
  check(`all ${messages.length} stdout lines were valid JSON-RPC`, badLines.length === 0, badLines.slice(0, 3).join(" | "));

  // Secret hygiene across everything the server sent us.
  const key = process.env.RINGG_API_KEY.trim();
  const allOutput = JSON.stringify(messages);
  check("API key never appears in tool output", key.length >= 8 && !allOutput.includes(key));

  child.stdin.end();
  child.kill();

  const failed = results.filter((r) => !r.ok);
  process.stderr.write(`\n${results.length - failed.length}/${results.length} checks passed\n\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${err?.message ?? err}\n`);
  child.kill();
  process.exit(1);
});
