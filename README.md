# ringg-mcp

A local MCP server exposing the [Ringg AI](https://docs.ringg.ai) voice-agent platform to
Claude Code over stdio. Read assistants, knowledge bases and call history; make targeted
edits to an assistant's prompt, custom variables and knowledge base attachments.

**Nothing in this server dials a phone.** There are no tools for individual calls,
campaigns, or call termination — by design.

---

> **Status:** proof of concept, built and verified against a single test workspace.
> Not affiliated with or endorsed by Ringg AI.

## Setup

Requires Node 20+.

```bash
git clone <this-repo>
cd RinggMCP
npm install
npm run build
```

Put your key in a gitignored `.env` at the project root:

```bash
printf 'RINGG_API_KEY=your-key-here\n' > .env
```

The repo ships a project-scoped `.mcp.json`, so opening this directory in Claude Code
offers the server automatically. No secret goes in that file - the server reads `.env`.
To register it globally instead:

```bash
claude mcp add ringg -- node /absolute/path/to/RinggMCP/dist/index.js
```

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RINGG_API_KEY` | **yes** | — | Workspace API key, sent as `X-API-KEY`. Read from the environment or `.env`. Server exits 1 with a clear stderr message if unset. |
| `RINGG_ENV_FILE` | no | `./.env` | Path to an alternative env file. Real environment variables always win over the file. |
| `RINGG_BASE_URL` | no | `https://prod-api.ringg.ai/ca/api/v0` | API base. Must be https (localhost excepted). |
| `RINGG_VERIFY_ON_START` | no | `0` | `1` probes `GET /workspace` at startup to validate the key. Off by default so startup stays network-free. |
| `RINGG_LOG_LEVEL` | no | `info` | `error` / `warn` / `info` / `debug`. All logging goes to **stderr**. |
| `RINGG_TIMEOUT_MS` | no | `30000` | Per-request timeout. |

Get a key from the Ringg dashboard under **Settings → API Key**. It is shown only once at
generation, and regenerating immediately revokes the previous key.

The key is read from the environment at startup, held only in the client's request
headers, and never returned by a tool or written to a log. `redact()` scrubs it from every
error message and log line.

---

## Tools

### Read

| Tool | Endpoint | Notes |
|---|---|---|
| `list_agents` | `GET /agent/all` | Paginated. `limit`/`offset` always sent explicitly. |
| `get_agent` | `GET /agent/{agent_id}` | Prompt sections, custom variables, KB attachments (always an array), voice, languages, tools, classification labels, analysis config, A/B versions. |
| `list_knowledge_bases` | `GET /external/kb/all` | Bare array upstream; no pagination. |
| `get_knowledge_base` | `GET /external/kb/{kb_id}` | Status plus the files / URLs / FAQs inventory. |
| `list_calls` | `GET /calling/history` | **Summaries only** — transcripts are stripped (see below). |
| `get_call` | `GET /calling/call-details` | `view`: `summary` \| `transcript` \| `analysis` \| `full`. |

`list_calls` deserves a note: the upstream history endpoint returns each call's **full
transcript inline on every row**. This server strips it and reports `has_transcript`
instead. Use `get_call` for actual transcript content.

`get_call` makes one upstream request; `view` selects `send_analysis` and projects the
response:

| view | `send_analysis` | Returns |
|---|---|---|
| `summary` | `false` | Metadata only |
| `transcript` | `false` | Metadata + conversation turns |
| `analysis` | `true` | Metadata + platform & client analysis |
| `full` | `true` | Everything |

### Write

All writes go through `PATCH /agent/v1` with an `operation` discriminator.

**Agent configuration**

| Tool | Operation | Semantics |
|---|---|---|
| `update_agent_prompt` | `edit_prompt` | Section-wise. **Read-merge-write** by default. |
| `update_intro_message` | `edit_intro_message` | Replaces the greeting outright. Warns when it is flattening dashboard rich text. |
| `update_custom_variables` | `edit_custom_vars` | `add` / `remove` deltas. **Read-merge-write.** |
| `update_agent_display_name` | `edit_agent_display_name` | Cosmetic rename. Agent-level. |

**Knowledge bases**

| Tool | Operation | Semantics |
|---|---|---|
| `attach_knowledge_base` | `attach_kb` | Additive; reports attachments before and after. |
| `detach_knowledge_base` | `remove_kb` | Detaches the one `kb_id`; reports attachments before and after. |

**Post-call analysis**

| Tool | Operation | Semantics |
|---|---|---|
| `update_custom_analysis_prompt` | `edit_custom_analysis_prompt` | Extraction prompt + typed keys. **Read-merge-write**; `clear` to remove. |
| `update_client_analysis` | `edit_client_analysis` | `context` / `goal_key` / `keys` / `revenue`. Merged upstream at the top level only. |
| `update_classification_labels` | `edit_classification_labels` | `set` / `remove` deltas, max 10. **Read-merge-write.** Agent-level. |
| `update_analytics_context` | `edit_analytics_context` | Tool-call-log switches. Deep-merged upstream. |

**A/B versions**

| Tool | Operation | Semantics |
|---|---|---|
| `add_ab_version` | `add_new_ab_version` | Clones a version; returns the new `version_id`. Starts with no traffic. |
| `update_traffic_split` | `edit_traffic` | `{ version_id: share }`, must sum to 1.0. **Affects live calls.** |
| `toggle_ab_testing` | `toggle_ab_testing` | On/off. Disabling needs one version and no calls in flight. |

The endpoint's full contract — every operation, field and error code — is kept in
[`docs/edit-agent-api.md`](docs/edit-agent-api.md). That file is the source of truth for
this server's write path.

**Writes are pinned to the version they were read from.** Agent config lives on an agent
*version*, and `PATCH /agent/v1` accepts `version_id`. Each write tool sends the id of the
version it read the current state from, so the merge and the write cannot land on
different A/B variants. Every write tool takes an optional `version_id` to override that,
and the KB tools take `is_draft` for editing a multi-node agent's draft.

`update_custom_variables` also takes `config_type` (`outbound` | `inbound`), which only
means anything on an `outbound_inbound` agent — those keep two copies of the runtime
config. It is ignored elsewhere, and the tool says so rather than silently dropping it.

The merge-based tools exist because **the upstream API replaces the entire field on
every write**. `update_custom_variables` reads the current variable list, applies your
add/remove as a set operation, and writes the whole list back, so variables you did not
mention survive. `update_agent_prompt` does the same for prompt sections, matching by
title; `update_classification_labels` and `update_custom_analysis_prompt` do the same for
their maps. Each takes `mode: "replace"` to deliberately discard what you did not supply,
and reports what that discarded.

Where the *platform* merges — `edit_client_analysis` (top level only) and
`edit_analytics_context` (deep) — the tools pass through rather than re-merging, and
`update_client_analysis` warns when a nested `keys` or `revenue` object you send would
drop entries the stored one had.

**Validation happens before the write, not after a 400.** Traffic shares that do not sum
to 1.0, a version id that does not belong to the agent, an analysis default with no
matching key or the wrong type for its key, an 11th classification label, a blank label
description — each is refused locally with a message naming the offending value, so no
request is sent.

If `update_agent_prompt` cannot locate the agent's existing sections, it **refuses to
write** rather than silently dropping sections it could not see.

`update_custom_variables` **refuses to remove `callee_name` or `mobile_number` from an
outbound agent**. The platform rejects such a list with `403`, so the tool fails locally
with a message naming the variable instead of spending a round trip to be told no.

`update_intro_message` warns when it is about to flatten rich text. The dashboard stores
the greeting as HTML, and custom variables appear there as mention spans
(`<span data-type="mention" data-id="{{callee_name}}">@{{callee_name}}</span>`).
`edit_intro_message` converts whatever it receives to text, so writing through this tool
loses the editor's chip rendering — the variable references themselves keep working.

### Out of scope, deliberately

Individual calls, campaigns, call termination, knowledge base create/edit/delete, number
provisioning, telephony config, and workspace user management. `scripts/check-stdout-purity.sh`
enforces that none of those endpoints appear in the code.

Two write operations are within reach but deliberately absent. `delete_version` and
`push_to_prod` (reference section 4.5) archive versions and retire production config;
they belong to a dashboard's confirm-dialog, not to a tool an agent can call in a loop.
The **flow-graph operations** (sections 4.6–4.8) are absent for a different reason — see
item 4b below: `GET /agent/{id}` does not return the node graph, so a tool could neither
read node ids nor verify what it wrote.

---

## Architecture

```
src/
  config.ts              Env load + fail-fast validation. Owns the API key.
  logger.ts              stderr-ONLY logger. No stdout code path exists here.
  ringg/
    client.ts            HTTP client: base URL, X-API-KEY, timeout, error mapping
    errors.ts            Typed errors + secret redaction
    normalize.ts         Defensive readers for undocumented / inconsistent shapes
    agents.ts kb.ts calls.ts
  tools/
    types.ts registry.ts   ToolDefinition + the 19-tool registry
    agents/ kb/ calls/     One file per tool
  server.ts              createServer(deps) -> McpServer. Imports NO transport.
  transports/stdio.ts    The only stdio-aware file. Includes the stdout guard.
  index.ts               bin entrypoint
```

**Transport lives at the edge only.** `server.ts`, `tools/` and `ringg/` import no
transport — a static check enforces this. Adding streamable HTTP later means adding
`src/transports/http.ts` and a second entrypoint that calls `createServer()`; nothing
under `tools/` or `ringg/` changes.

### stdio safety

stdout carries the JSON-RPC stream, so a single stray write corrupts the session.
Three layers guard it:

1. `guardStdout()` in `transports/stdio.ts` redirects **every** `console.*` method to
   stderr before the transport connects — defusing a stray `console.log` in our code or
   any dependency.
2. `logger.ts` has no stdout code path at all.
3. `scripts/check-stdout-purity.sh` fails the build on any stdout write outside
   `src/transports/`, and `scripts/smoke.mjs` asserts every stdout line parses as JSON-RPC.

The server starts with no interactive prompts and never reads stdin outside the protocol.
A missing `RINGG_API_KEY` produces one clear stderr line and exit code 1.

---

## Verification

```bash
npm run check:stdout          # static guards: stdout purity, transport isolation, scope
npm run typecheck             # tsc --noEmit
npm run build

RINGG_API_KEY=... npm run probe          # live read-only probe; see below
RINGG_API_KEY=... npm run smoke          # protocol + tools/list
RINGG_API_KEY=... node scripts/smoke.mjs --live   # + live read-only tool calls
```

Fail-fast check — expect one stderr line, exit 1, and nothing on stdout:

```bash
env -u RINGG_API_KEY node dist/index.js
```

### Run the probe before trusting the write tools

`scripts/probe.mjs` is read-only and makes no writes. It answers, empirically, the three
questions the documentation does not:

1. Where prompt sections actually live inside `agent_config`, and what their
   `section_title` values are.
2. Which of the three documented custom-variable shapes `GET /agent/{id}` really returns.
3. Whether knowledge base attachments come back singular or plural.

```bash
RINGG_API_KEY=... node scripts/probe.mjs
# or target a specific agent:
RINGG_API_KEY=... PROBE_AGENT_ID=<uuid> node scripts/probe.mjs
```

Raw payloads land in `./probe-output/` (gitignored). Fold anything surprising into
`src/ringg/normalize.ts`.

### Verification status

Run against a live workspace on 2026-09-02.

| Area | Status |
|---|---|
| `typecheck` / `build` | ✅ clean |
| Static guards (stdout, transport isolation, scope) | ✅ 4/4 |
| Protocol + live read tools (`smoke.mjs --live`) | ✅ 21/21 |
| Fail-fast: missing / empty key, bad base URL, empty env file | ✅ exit 1, clear stderr, **0 bytes stdout** |
| 401 handling and key redaction | ✅ actionable message, key never leaks |
| `update_custom_variables` read-merge-write | ✅ live round trip on a throwaway agent |
| `mergePromptSections` logic | ✅ verified against real 30k-char prompt data |
| `attach_knowledge_base` / `detach_knowledge_base` | ✅ live round trip, including the blind-read case |
| `update_agent_prompt` live round trip on a `single_node` agent | ✅ verified on a live A/B agent |

The custom-variables round trip added two variables, removed one, confirmed the agent's
original `callee_name` / `mobile_number` and the other new variable all survived, then
restored the agent. A byte-level diff against the pre-test snapshot showed the agent
identical apart from `updated_at` and `tool_id`s, which Ringg regenerates on every request.

The prompt round trip ran against a live A/B agent with three versions, each holding four
sections of differing content (~45 KB on the target version alone). A marker was merged
into one section and then reverted. Results:

- The write landed on **exactly the version the resolver had read** (v3, the traffic-bearing
  one) — the other two versions were untouched. This settles the read-one/write-another
  hazard that motivated the version-targeting logic: **`PATCH /agent/v1` writes to the same
  version `getActiveVersion()` resolves**, including when `active_agent_version_id` is null.
- The three sections not named in the call survived byte-for-byte, as did the version's
  custom variables and knowledge base attachment.
- After reverting, all three versions were byte-identical to the pre-test snapshot.

**Section titles vary by agent template** and are not a fixed vocabulary. Observed:
`Introduction and Objective` · `Response Guidelines` · `Task` · `FAQ Guidelines` on one
agent, and `Introduction and Objective` · `Response Guidelines` · `Conversation Script` ·
`FAQs` on another. Always call `get_agent` first to read the titles actually in use.

---

## Observed API behaviour

Notes gathered while building this server: first from `docs.ringg.ai` (llms.txt, skill.md,
openapi.json and the relevant prose pages), then checked against the live API with
`scripts/probe.mjs`. Where the two differed, the implementation follows the observed
behaviour; those items are marked ✅ OBSERVED.

These are working notes for anyone integrating against the same endpoints, not a
criticism of the documentation — APIs and their docs drift, and some of this may reflect
newer platform features that the reference has yet to catch up with. Verified against one
workspace in September 2026; your results may differ.

The most structurally important item is #0: **agents are versioned**, and the config
fields live on the agent's active version rather than on the agent object itself.

**Superseded in part.** [`docs/edit-agent-api.md`](docs/edit-agent-api.md) is a platform
reference for `PATCH /agent/v1` that post-dates these notes and settles several of them:
`version_id` / `is_draft` / `config_type` are documented common fields, `edit_event_subscriptions`
is real (#1), `remove_kb` takes a `kb_id` and detaches only that one (#3), and multi-node
agents are edited through a separate family of flow operations (#4b). Items updated below
say so inline. Everything still marked ✅ OBSERVED concerns the **read** path, which that
reference does not cover.

**0. Agents are versioned.** ✅ OBSERVED

```
agents
  active_agent_version_id        null whenever is_ab_live is true
  ab_versions                    { <version_id>: { slug, description, call_traffic } }
  form_fields                    template builder inputs - NOT custom variables
  version_details
    <version_id>
      agent_config
        agent_prompt.prompt_sections   [{ section_title, section_content }]
        custom_variables               ["callee_name", "mobile_number", ...]
        intro_message
      knowledge_bases                  array - plural
      event_subscriptions
      language / voice / tools
```

The version layer is not described in the reference. Consequences, all handled in
`normalize.ts`:

- **Which version is live is not always declared.** When `is_ab_live` is true,
  `active_agent_version_id` is `null` and the live version is the `ab_versions` entry
  holding the call traffic. `getActiveVersion()` resolves by declared id, then by call
  traffic, then by sole version — and **returns nothing when a real traffic split makes
  the choice ambiguous**, rather than guessing. `get_agent` reports which version it read
  and on what basis.
- This is a correctness issue, not tidiness: on a live A/B agent here, version v1 had a
  knowledge base attached and v2 had none. Reading the wrong version reports the wrong
  configuration.
- Reading the agent root alone returns empty config for a good share of agents.

**1. `edit_event_subscriptions` appears in prose but not in the OpenAPI spec.** ☑️ SETTLED
— `docs/edit-agent-api.md` section 4.3 documents the operation and its full payload
(`event_type`, `callback_url`, `headers`, `method_type`, `auth_fetch_config`), so the
OpenAPI omission was a spec gap. Webhook management remains out of scope here; the note
below still describes what `get_agent` surfaces read-only.

Originally: `webhooks/initial-setup.md`, the body of `endpoint/assistant/edit-assistant.md`, and
`skill.md` (3 places) all document `operation: "edit_event_subscriptions"`. The
`operation` enum in `openapi.json` does not contain it, and `event_subscriptions` appears
**zero** times in the spec. The prose and the embedded OpenAPI block on the
edit-assistant page differ on this point.

✅ **Observed:** subscriptions *are* readable, at
`version_details.<active>.event_subscriptions` — so a webhook tool would not have to write
blind. Webhook management is out of scope for this server; `get_agent` surfaces the
current subscriptions read-only.

**2. `custom_variables` lives elsewhere than documented.** ✅ OBSERVED

| Source | Field | Shape |
|---|---|---|
| Docs: `GET /agent/all` | `custom_variables` | object map |
| Docs: `GET /agent/{id}` | `form_fields` | array of `{key, value}` |
| **Live: `GET /agent/all`** | `custom_variables` | **absent entirely** |
| **Live: `GET /agent/{id}`** | `version_details.<active>.agent_config.custom_variables` | **array of plain strings — already the write shape** |
| Write: `PATCH /agent/v1` | `custom_variables` | array of plain strings |

**`form_fields` is a separate concept.** It holds the template builder's own inputs —
`agent_name`, `company_name`, `call_details`, `faq`, `intro_message` — carrying values
carrying values (an agent persona name, a company name). The call variables are separate values such as
`callee_name` and `mobile_number`. Because `edit_custom_vars` replaces the whole list,
writing `form_fields` keys back through it would overwrite the agent's real call
variables — so `normalize.ts` never reads `form_fields` for this purpose, and `get_agent`
returns the two as distinct fields.

**3. Agent → knowledge base cardinality differs from the reference.** ✅ OBSERVED
`GET /agent/{agent_id}` is documented as returning a singular nullable
`knowledge_base_id`. That field was not present in the responses observed. The field in use is
`version_details.<active>.knowledge_bases`, an array, so an agent can hold more than
one. Attach/detach are additive, and `get_agent` always returns an array.

☑️ `docs/edit-agent-api.md` section 4.2 confirms the write side: `attach_kb` and
`remove_kb` both require a `kb_id`, and `remove_kb` detaches exactly that one. The
detach tool no longer hedges about whether it might detach the whole set.

**4. The prompt is not in the documented read schema.** ✅ OBSERVED
`GET /agent/{agent_id}` documents only `agent_config` as a bare `object` with no
properties. Live, the prompt is at
`version_details.<active>.agent_config.agent_prompt.prompt_sections`, The `section_title`
values are not enumerated in the reference; those observed were:

> `Introduction and Objective` · `Response Guidelines` · `Task` · `FAQ Guidelines`

`extractPromptSections()` targets the active version first and refuses to walk
`version_details` blindly. ✅ A live round trip on an A/B agent confirmed that
`PATCH /agent/v1` writes to the same version the resolver reads. ☑️ The write path no
longer relies on that: `version_id` is a documented field on every operation, so each
write tool now sends the id of the version it read, making the agreement explicit instead
of observed. `update_agent_prompt` refuses to merge when it cannot locate the sections.

Section titles are **per-template, not a fixed set** — two agents in this workspace use
different ones. Read them with `get_agent` before writing.

**4b. `orchestration_mode` changes the payload shape.** ✅ OBSERVED
Agents are either `single_node` (single prompt) or `multi_node` (multi-prompt). For a
`multi_node` agent, `GET /agent/{id}` returns a much thinner payload: `agent_prompt` is
`null`, and the node graph holding the actual script is **not returned at all**.
`edit_prompt` does not reach that graph, so `update_agent_prompt` detects the mode and
says so explicitly rather than reporting a vague "sections not found".

☑️ These agents are not uneditable, though — `docs/edit-agent-api.md` sections 4.6–4.8
document a whole family of flow operations (`add_flow_node`, `edit_node_messages`,
`edit_node_per_type_config`, edges, per-node voice and DTMF overrides) that edit the graph
node by node, against a version or its draft. This server does not expose them: they need
the graph read back to be usable, and `GET /agent/{id}` does not return it. The tool now
names them in its error so the limitation is attributable rather than mysterious.

**4c. For multi-prompt agents, KB writes succeed but reads do not reflect them.** ✅ OBSERVED
`version_details.<active>.knowledge_bases` is **absent entirely** on a `multi_node`
agent - yet `attach_kb` succeeds, and attaching twice returns
`400 "Knowledge Base already attached"`, proving the platform tracks it. So the write
path works while the read path shows nothing. An empty array here means *unknown*, not
*none*. `get_agent` exposes `knowledge_bases_readable`, and the attach/detach tools return
`verified: false` with an explanation instead of presenting a misleading `[] → []` diff.

**4d. The analysis and A/B fields sit in four different places.** ✅ OBSERVED
Inspected across 18 agents while building the analysis and A/B tools:

| Field | Where it actually lives | Shape |
|---|---|---|
| `intro_message` | `version_details.<v>.agent_config.intro_message` | **HTML**, not text |
| `custom_analysis_prompt` | `version_details.<v>.custom_analysis_prompt` | `{ prompt, keys: { name: "string" } }` |
| `client_analysis` | `version_details.<v>.client_analysis` | `{ keys: { name: { type, default, description } } }` |
| `analytics_context` | `version_details.<v>.analytics_context` **and** `…agent_config.analytics_context` | `{ platform_analytics, client_analytics }` |
| `classification_labels` | **agent root** | `{ label: description }` |
| `ab_versions` | **agent root** | `{ <version_id>: { slug, description, call_traffic } }` |

Three things worth knowing:

- **The two analysis fields use different key shapes.** `custom_analysis_prompt.keys` is
  flat (`{ "amount": "number" }`); `client_analysis.keys` is nested
  (`{ "amount": { type, default, description } }`). They read as siblings and are not.
- **`analytics_context` was found in two places on the same agent**, and on one agent in
  only one of them. `readVersionField()` tries the version, then `agent_config`, then the
  root, and reports which answered.
- **`intro_message` comes back as dashboard HTML**, including mention spans that render a
  custom variable as a chip. `edit_intro_message` converts input to text, so a
  read-then-write round trip flattens the markup. `update_intro_message` detects HTML in
  the current value and says so before writing.

**5. Pagination defaults disagree.** `api-overview.md` says "default 20, max 100". The
spec's `/agent/all` `limit` carries `default: 10` while *its own description on the same
parameter* says "default: 20, max: 100". Mitigation: always send `limit`/`offset`
explicitly.

**6. `GET /calling/history` has stale hardcoded date defaults** — `2025-09-25T00:00:00+05:30`
and `2025-09-25T23:59:59+05:30` are baked into the spec as `default`. ✅ Verified that
omitting both returns `200` with current results, so this server omits them unless supplied.

Also verified: **`total` comes back as the string `"many"`**, not a number, so it is passed
through as `number | string` rather than silently dropped.

**7. `call_type` is documented as a history filter but is not a parameter.** The prose
says "Add filters such as `agent_id`, `status`, `call_type`, or `bulk_list_id`";
`call_type` is only a *response* field. Not exposed as a filter.

**8. `transcription_url` is a JSON string, not a URL or an array.** ✅ OBSERVED
The spec types it as an array of `{bot?, user?}` turns. Live, it is a **JSON-encoded
string** containing an array of `{bot|user, message_id, timestamp, ...}` objects. This
server parses the string and maps it to a `transcript` array of
`{speaker, text, timestamp}`.

**9. Two agent-update endpoints exist.** `PATCH /agent/v1` (documented) and
`PATCH /public/agent/{agent_id}` (in the spec, absent from `llms.txt`). `AGENTS.md` says
explicitly not to treat the latter as public. This server uses `PATCH /agent/v1` only.

**10. Language enums diverge.** `/agent/v1` allows `gu-IN` and `ar-AE`; `/public/agent`
allows `bn-IN` and `ka-IN` instead. `ka-IN` is Georgian and is almost certainly a typo for
`kn-IN`, which already appears in the same enum.

**11. `skill.md` cites two endpoints that do not exist:** `POST /agent/create` (the real
path is `POST /public/agent`) and `operation: "edit_agent"` (not in the enum).

**12. KB file limits contradict.** `key-concepts/knowledge-base.md` says up to 4 files at
512 MB each; `llms.txt` and the create-KB endpoint say 2 MB per file, 5 MB total, max 10
files and 20 URLs.

Items 0, 2, 3, 4 and 8 are the ones most likely to trip up an integration written
straight from the reference; #2 is the one to be most careful with, since the write
replaces the whole field. Items 1, 7, 10 and 11 are cosmetic. If you are integrating
against Ringg, these are worth confirming against your own workspace — and worth raising
with their team, who may well have newer guidance.


## Contributing / running it yourself

Everything here is workspace-agnostic — no workspace ids, agent ids or keys are committed.
To run against your own Ringg workspace:

1. `npm install && npm run build`
2. Put your own key in `.env` (`RINGG_API_KEY=...`). It is gitignored; never commit it.
3. `npm run probe` — read-only. Confirms the shapes described in "Observed API behaviour"
   still hold for your workspace, and writes raw payloads to `probe-output/` (also
   gitignored). **Those payloads contain live customer data; delete them when done.**
4. `node scripts/smoke.mjs --live` — exercises the read tools end to end.

Before testing the write tools, snapshot the target agent and use a disposable one: every
write replaces the whole field upstream.

## License

MIT — see [LICENSE](LICENSE).
