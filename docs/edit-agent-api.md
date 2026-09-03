# Edit Agent API — operations and parameters

Reference for `PATCH /ca/api/v0/agent/v1` (the single "edit agent" endpoint). Written for building MCP tools on top of it.

Source of truth: `agent/schema.py` (`EditAgentRequestV1`) and `agent/agent_edit/service.py` (dispatcher). Handlers live in `agent/agent_edit/{config,flow,tools,version,phone,kb}_operations.py`.

---

## 1. Endpoint

| | |
|---|---|
| Method / path | `PATCH {BASE_URL}/ca/api/v0/agent/v1` |
| Body | JSON, one operation per request |
| Auth | `Authorization: Bearer <jwt>` **or** `X-API-KEY: <key>` (sending both → 400) |
| Permission | caller needs the `agents` resource permission |

Every request has the same envelope; only the operation-specific fields change:

```json
{
  "operation": "<one of the operations below>",
  "agent_id": "<agent uuid>",
  "...": "operation-specific fields"
}
```

### Response

Most operations return:

```json
{ "message": "Agent updated successfully!", "agent_id": "<uuid>", "edit_details": { "...optional" } }
```

`edit_details` is present only for tool operations (server-assigned `tool_id`s etc.). A/B, flow (node/edge) and KB operations return their own shapes, documented per operation.

### Errors

| Status | When |
|---|---|
| 400 | schema validation (missing required field for the operation, bad enum), business validation (`ValueError` is mapped to 400) |
| 403 | removing `callee_name` / `mobile_number` from custom variables on an outbound agent |
| 404 | agent / version / node / edge / KB / number not found |
| 409 | inbound number pool conflicts |
| 500 | unexpected failure (transaction rolled back) |

Schema-level required-field errors look like: `'kb_id' is required for operation 'attach_kb'`.

---

## 2. Common fields (apply to every operation)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `operation` | string enum | required | see section 4 |
| `agent_id` | uuid string | required | must belong to the caller's workspace and not be archived |
| `version_id` | uuid string | `null` | Target agent version. **Required** for every flow/node/edge operation and for `is_draft=true`. When omitted for other operations the agent's active version is used (falls back to the most recently updated non-archived version). |
| `is_draft` | bool | `false` | Multi-node agents only. `true` = edit the draft of `version_id` (draft is created by copying the base version if none exists). Single-node agents ignore it. |
| `new_draft` | bool | `false` | Caller's belief that no draft exists yet. An existing draft is adopted either way (never 409s). Safe to always send `false`. |
| `config_type` | `"outbound"` \| `"inbound"` | `"outbound"` | Only for agents whose `agent_type` is `outbound_inbound`. `"inbound"` routes runtime-config edits (and `edit_intro_message`, `edit_custom_vars`) to the inbound copy of the config. |

### Version / draft resolution

1. A/B operations (`add_new_ab_version`, `toggle_ab_testing`, `delete_version`, `push_to_prod`, `edit_traffic`, `edit_version_description`) never use `is_draft`.
2. Flow/node/edge operations: `version_id` + `is_draft` + `new_draft` are all schema-required (send `false` for the booleans on non-draft edits).
3. Everything else: `version_id` optional (defaults to active version). `is_draft=true` requires `version_id`.
4. Node/edge ids may be either the draft row id **or** the base-version node id (`base_node_id`) — the backend resolves both.

### Side effects on every call

The agent's runtime cache is invalidated after every successful edit, and a workspace audit log entry (`operation`, `changed_fields`) is written.

---

## 3. Multi-node vs single-node agents

`Agent.orchestration_mode` is `single_node` (one prompt) or `multi_node` (flow of nodes). Operations in sections 4.5–4.7 require a multi-node agent (400 otherwise). Some agent-level operations behave differently:

| Operation | single_node | multi_node |
|---|---|---|
| `edit_custom_vars` | all active versions updated | only the targeted (draft) version |
| `edit_custom_analysis_prompt` | all active versions | only the targeted version |
| `edit_client_analysis` | all active versions | only the targeted version |

---

## 4. Operations

Fields listed as **required** are enforced by the schema validator (400 if `null`/missing). Fields under **optional** are read by the handler if present.

### 4.1 Inbound phone number

#### `attach_inbound_number`
- **required**: `number_id` (uuid of a `from_number`)
- Rules: agent must be `inbound` or `outbound_inbound`; number must exist, not be archived, have inbound enabled, not be bound to another agent; agent must have a language configured. If the number is in a number pool it is removed from the pool (pool must not be in active use).
- Response: standard.

#### `remove_inbound_number`
- **required**: `number_id`
- Rules: same agent-type rule; number is returned to the workspace default pool.

### 4.2 Knowledge bases

#### `attach_kb` / `remove_kb`
- **required**: `kb_id`
- optional: `version_id`, `is_draft`, `new_draft`
- KB must belong to the same workspace. Attaching an already-attached KB → 400.
- Response: `{ "message": "Knowledge Base attached successfully", "kb_id": "..." }`

#### `attach_node_kb` / `remove_node_kb` (multi-node)
- **required**: `kb_id`, `node_id`
- optional: `version_id`, `is_draft`, `new_draft`
- Response adds `"node_id"`. Removing a KB that is not attached to the node → 404.

### 4.3 Agent-level configuration

#### `edit_agent_display_name`
- **required**: `agent_display_name` (string)

#### `edit_prompt`
- **required**: `agent_prompt` — either a plain string or the sectioned shape:
  ```json
  { "prompt_sections": [ { "section_title": "Role", "section_content": "You are ..." } ] }
  ```
- Jinja syntax in the prompt is validated (400 on error). Sections whose content is unchanged are grandfathered. Token stats are recomputed.

#### `edit_intro_message`
- **required**: `intro_message` (string; HTML is converted to text). Jinja validated.
- With `config_type="inbound"` on an `outbound_inbound` agent, writes `inbound_intro_message`.

#### `edit_custom_vars`
- **required**: `custom_variables` (list of strings)
- Outbound agents must keep `callee_name` and `mobile_number` in the list (403 otherwise). Honors `config_type`.

#### `edit_voice`
- **required**: `voice_id` (uuid), `language` (locale label, e.g. `en-IN`; validated against the active language list)
- optional: `secondary_voice_id` (uuid, or `""` to clear), `secondary_language`, `additional_languages` (list of locale labels; `null` = untouched, `[]` = clear)
- Rules: the voice must support `language`; secondary voice must support `secondary_language`; secondary base language must differ from primary (`hi-IN` vs `en-IN` ok, `en-US` vs `en-IN` not); max 6 languages total. STT provider/model is re-derived from the language set.

#### `edit_secondary_voice`
- Accepted by the schema but **not dispatched** — returns success without changing anything. Use `edit_voice` with `secondary_voice_id` / `secondary_language` instead.

#### `edit_voice_speed`
- **required**: `voice_speed` (number)

#### `edit_vocab`
- **required**: `vocab` (list of strings; ≤ 100 words total across entries)

#### `edit_query_phrases`
- **required**: `pre_query_response_phrases` (list of strings spoken before a KB query / tool call)
- optional: `pre_query_phrase_probability` (float 0.0–1.0; default at runtime 0.6)

#### `edit_noise_settings`
- **required**: `mute_while_bot_speaking` (bool), `mute_during_intro` (bool; schema default `true`, so it is always present)

#### `edit_dtmf_settings`
- **required**: `dtmf_settings`:
  ```json
  {
    "dtmf_capturing_enabled": true,
    "dtmf_input": {
      "digits": 4,            // positive int, or omit → null
      "end": "#,*",           // comma-separated keys; must not contain "0"
      "reset": "*",           // comma-separated; must not overlap with "end"
      "timeout": 10           // positive int seconds
    }
  }
  ```
  `dtmf_input` must be present when `dtmf_settings` is non-empty. Pass `{}` to clear.

#### `edit_vad_settings`
- **required**: `vad_settings`:
  ```json
  {
    "vad_override": true,
    "interruption_sensitivity": "default" | "sensitive" | "strict",
    "vad_input":            { "confidence": 0.8, "start_secs": 0.7, "stop_secs": 0.5, "min_volume": 0.5 },
    "vad_input_bot_silent": { "confidence": 0.8, "start_secs": 0.7, "stop_secs": 0.5, "min_volume": 0.5 }
  }
  ```
  All keys optional; unknown keys inside `vad_input*` are dropped. `interruption_sensitivity` fills `vad_input` from a preset if `vad_input` is not sent.

#### `edit_agent_whitelisted_domains`
- **required**: `whitelisted_domains` (list of origins, e.g. `https://example.com`, `android://com.example.app`)
- `https://www.ringg.ai` must remain in the list (400 otherwise).

#### `edit_extract_callee_name`
- **required**: `extract_callee_name` (bool)
- Note: passes schema validation but has **no handler** — currently a no-op.

#### `edit_call_config`
- **required**: `call_config` — deep-merged into the version's existing `call_config`. Keys (all optional):
  ```json
  {
    "idle_timeout_warning": 5,
    "idle_timeout_end": 10,
    "max_call_length": 400,
    "call_retry_config": { "retry_count": 0, "retry_busy": 30, "retry_not_picked": 30, "retry_failed": 30 },
    "call_time": { "call_start_time": "09:00", "call_end_time": "21:00", "timezone": "Asia/Kolkata", "scheduled_at": null },
    "voicemail": { "detect": false, "action": "end" | "summarise" | "static_message", "retry": false, "static_message": null },
    "mute_during_intro": true,
    "noise_filter_config": { "filter_noise": false, "method": "krisp_viva_filter", "noise_suppression_level": 80 },
    "background_audio_config": { "audio_id": "...", "volume": 0.5, "mixing": true, "loop": true },
    "timeout_msg_on": false,
    "timeout_texts": { "...": "..." },
    "timeout_msg_dur": 12,
    "transfer": { },
    "call_transfer_config": { },
    "enable_smart_turn": false
  }
  ```
  Idle timeouts are validated only when one of them changes. Voicemail settings go through here (the top-level `voicemail` request field is not used by any operation).

#### `edit_timezone`
- **required**: `timezone` (IANA name, e.g. `Asia/Kolkata`). Writes `call_config.call_time.timezone`.

#### `edit_llm_temperature`
- **required**: `llm_temperature` (float). Writes `runtime_config.llm.temperature`.

#### `edit_demo_settings`
- **required**: `is_demo_enabled` (bool). Also sets `demo_limit` = 50.

#### `edit_custom_analysis_prompt`
- **required**: `custom_analysis_prompt`:
  ```json
  {
    "prompt": "Extract ...",
    "keys": { "intent": "string", "amount": "number", "callback": "boolean" },
    "defaults": { "callback": false }
  }
  ```
  - `keys` values ∈ `string | integer | number | boolean | array | date | datetime`.
  - `prompt` and `keys` are required together; `defaults` keys must be a subset of `keys` and match the declared type.
  - Send `{}` / `null` to clear. Removing a key that an agent tool still references via `client_analysis.<key>` → 400.

#### `edit_client_analysis`
- **required**: `client_analysis` (non-empty object), top-level merged with the stored config:
  ```json
  { "context": "string|null", "goal_key": "string|null", "keys": { }, "revenue": { } }
  ```

#### `edit_classification_labels`
- **required**: `classification_labels` — `{ "<label>": "<description>" }`, max 10 entries, non-empty keys and values. Stored on the agent (not version).

#### `edit_event_subscriptions`
- **required**: `event_subscriptions` — full replacement list:
  ```json
  [{
    "event_type": ["call_completed", "all_processing_completed"],
    "callback_url": "https://...",
    "headers": { "Authorization": "Bearer ..." },
    "method_type": "POST",
    "auth_fetch_config": {
      "enabled": true, "url": "https://.../token", "method": "POST",
      "headers": {}, "body": {}, "query_params": {}, "token_path": "data.token",
      "ttl_seconds": 3600, "header_name": "Authorization", "header_value_template": "Bearer {{token}}"
    }
  }]
  ```
  `event_type` values: `call_started`, `call_ringing`, `call_ongoing`, `call_completed`, `recording_completed`, `client_analysis_completed`, `platform_analysis_completed`, `all_processing_completed`. `auth_fetch_config` is optional; `ttl_seconds` 30–86400; template must contain `{{token}}`.

#### `edit_chat_settings`
- **required**: `chat_settings` — merged into `chat_config`:
  `{ "max_call_length": 60–3600, "idle_timeout_warning": 5–300, "idle_timeout_end": 10–600 }` (seconds, all optional).

#### `edit_rate_limit` (inbound agents only)
- optional: `rate_limit` — omit/`null` to clear:
  ```json
  { "max_calls": 5, "timeframe_minutes": 60, "action": "terminate" | "transfer", "transfer_to": "+91...", "whitelisted_numbers": ["+91..."] }
  ```
  Phone numbers are validated/normalised to E.164.

#### `edit_analytics_context`
- **required**: `analytics_context` — deep-merged:
  `{ "platform_analytics": { "tool_call_logs": false }, "client_analytics": { "tool_call_logs": false } }`

#### `edit_outbound_inbound`
- **required**: `enable_outbound_inbound` (bool). Agent must be `outbound` or `outbound_inbound`.
- `true`: agent type → `outbound_inbound`, outbound config/intro copied to the inbound slots on all active versions. `false`: agent type → `outbound`, inbound config cleared.

#### `edit_outbound_from_number_ids`
- **required**: `outbound_from_number_ids` (list of uuids).
- Note: schema-validated only — **no handler** in the dispatcher today (no-op).

#### `edit_voicemail_settings`
- Accepted by the schema but **not dispatched** (no-op). Use `edit_call_config` with a `voicemail` object.

### 4.4 Tools (agent level, tools v2)

Tool payloads are SDK tool definitions (`tools_framework_sdk`). `tool_type` values must be upper-case enum names.

| Phase | Supported `tool_type` |
|---|---|
| pre-call | `API_TOOL`, `FUNCTION_TOOL`, `INTEGRATION_TOOL` |
| on-call | `API_TOOL`, `FUNCTION_TOOL`, `CALL_TRANSFER_TOOL`, `END_CALL_TOOL`, `DTMF_TOOL`, `WAIT_FOR_DTMF_TOOL`, `STAY_ON_LINE_TOOL`, `CAPTURE_CODE_TOOL`, `COLLECT_LONG_INPUT_TOOL`, `SEND_TEMPLATE_TOOL`, `QUICK_REPLY_TOOL`, `FORM_WIDGET_TOOL`, `CALENDER_WIDGET_TOOL`, `SLOT_PICKER_TOOL`, `WHATSAPP_FORM_TOOL`, `BLOCKS_WIDGET_TOOL`, `DOM_ACTION_TOOL` |
| post-call | `API_TOOL`, `FUNCTION_TOOL`, `CALLBACK_SCHEDULE_TOOL`, `INTEGRATION_TOOL` |

#### `edit_pre_call_tools` / `edit_on_call_tools` / `edit_post_call_tools` (bulk replace)
- **required**: `tool_type` (string), `tools` (list of tool dicts; `[]` removes all tools of that type)
- Semantics: **replaces every tool of `tool_type` in that phase**; other tool types and global-tool references are preserved. Tool renames are detected by `tool_id` and references are rewritten. Removing a tool still referenced by another tool or by the prompt → 400.
- Post-call tools: `trigger_point` is derived by the server (ignore what you send).
- Response `edit_details`: `{ "phase", "tool_type", ...change summary }`.

#### `edit_on_call_tool` (single upsert)
- **required**: `on_call_tool` (one tool dict with `tool_type`; include `tool_id` to update in place, omit to create)
- Response `edit_details`: `{ "tool_id", "tool_name" }` — persist `tool_id` for the next edit.

#### `remove_on_call_tool`
- **required**: `tool_id` (string). 404 if not found; 400 if the tool is enabled and still referenced in prompts.

#### Minimal `API_TOOL` shape

```json
{
  "tool_type": "API_TOOL",
  "tool_name": "get_order_status",
  "description": "Looks up an order",
  "tool_id": "optional-on-create",
  "enabled": true,
  "failure_behavior": "non-blocking" | "blocked" | "fallback",
  "config": {
    "url": "https://api.example.com/orders/{order_id}",
    "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    "headers": [ { "key": "Authorization", "value": "Bearer x", "type": "static" } ],
    "query":   [ ],
    "path":    [ { "key": "order_id", "value": "order id spoken by the user", "type": "dynamic", "data_type": "string", "required": true } ],
    "body":    [ ],
    "responseSelectedKeys": [ "status" ],
    "responseJqTransform": null
  },
  "auth_config": { "auth_type": "none" | "api_key" | "bearer" | "basic" | "oauth2" | "hmac" },
  "failure_status_codes": [],
  "body_content_type": "json" | "form_data" | "x_www_form_urlencoded",
  "connect_timeout_ms": 5000, "read_timeout_ms": 30000, "timeout_ms": 60000,
  "retry_config": { "max_retries": 0, "backoff": "exponential", "initial_delay_ms": 0, "max_delay_ms": 30000 },
  "conditions": { "combinator": "and", "rules": [], "negate": false },
  "pre_call_message": null,
  "execute_after_intro_message": false,
  "cache_response": false, "cache_ttl": 300
}
```

Param `type` values: `static`, `variable`, `dynamic` (LLM-filled), `api_res`, `jq`, `custom_args`, `call_data`, `platform_analysis`, `client_analysis`, `tool_output`, `object`, `array`. `data_type`: `string | integer | number | boolean | object | array`. jq expressions are syntax- and safety-checked on save.

`FUNCTION_TOOL` uses `config: { "engine": "jq", "program": "<jq>", "body": [params], "output_max_bytes": 262144 }`.
`CALLBACK_SCHEDULE_TOOL` fields: `schedule_callback_instructions`, `max_callback_attempts`, `max_schedule_time_minutes`, `default_callback_delay_minutes`, `callback_call_introduction_message`, `callback_from_numbers`, `conditions`, `condition_callbacks`.

The legacy `api_config` field (list of `{name, config, failure_status_codes}`) is still accepted by the schema but the dispatcher only forwards `tools`; send `tools`.

### 4.5 A/B testing and versions

These operate on the agent, not on a specific version's config.

| Operation | Required | Notes / response |
|---|---|---|
| `add_new_ab_version` | — (optional `base_version_id`) | A/B must be enabled; max 5 active versions. Clones the base (or latest) version incl. nodes/edges/KB links. Returns `{ message, agent_id, version_id, version_slug }`. |
| `edit_version_description` | `version_id`, `description` | Returns `{ message, version_id }`. |
| `edit_traffic` | `traffic_split` — `{ "<version_id>": 0.5, ... }` | Must sum to 1.0 (±0.001); all ids must belong to the agent. Returns `{ message, traffic_split }`. |
| `toggle_ab_testing` | `ab_enabled` (bool) | Disabling requires exactly one active/production version and no calls in registered/retry status. |
| `delete_version` | `version_id` | Cannot delete the last active version or one with in-flight calls. Soft-deletes (archives) and drops its draft. |
| `push_to_prod` | `prod_version_id` | Makes that version the sole production version, archives the others; blocked while calls are in flight. |

### 4.6 Flow graph — nodes and edges (multi-node agents)

All operations here **require** `version_id`, `is_draft`, `new_draft` (send `false`/`false` when editing a version directly). Node types:

`start_node`, `end_node`, `agent_node` (LLM), `speak_node`, `router_node`, `action_node`, `transfer_node`, `keypad_menu_node`, `collect_node`, `widget_node`.

Entry-node rule: wiring `start_node → agent_node | speak_node | router_node | action_node | widget_node` auto-sets the version's entry node. Self-loops are allowed only on `agent_node`, `router_node`, `keypad_menu_node`.

#### `add_flow_node`
- **required**: `node_id` (client-generated uuid), `node_type`, `position` `{ "x": 0, "y": 0 }`
- optional: `node_config` (object, see below), `prev_node_id` (creates an edge from that node; returns `edge_id`), `source_node_id` (agent_node only: copy prompts/tools/actions from an existing agent_node in the same version)
- `node_config` keys read: `label`, `description`, `intro_message`, `role_messages`, `task_messages`, `functions`, `pre_actions`, `post_actions`, `context_strategy`, `respond_immediately` (default `true`), `predefined_tools`, `overrides`, `per_type_config` (deterministic node config, see 4.8). `name` is server-generated from `label`; any `name` sent is ignored. `agent_node` gets `end_call` prepended to `predefined_tools` if missing.
- Response: `{ message, agent_id, version_id, node_id, edge_id? }`

#### `delete_flow_node`
- **required**: `node_id`

#### `add_flow_edge`
- **required**: `edge_id` (client-generated uuid), `source_id`, `target_id`
- optional: `condition` (string — for LLM routers this is the branch description), `transition_config` (object; `branch_id` for router/keypad branches, `digit` legacy keypad), `transition_message`
- Router sources get a `branch_id` generated if not supplied. An existing edge with the same (source, target, branch) is replaced.
- Response: `{ message, agent_id, version_id, edge_id, source_id, target_id }`

#### `update_agent_edge`
- **required**: `edge_id`
- optional: `new_source_id`, `new_target_id`, `condition`, `transition_message`
- Response: `{ message, agent_id, version_id, edge_id, source_id, target_id, condition, transition_message }`

#### `delete_flow_edge`
- **required**: `edge_id`

### 4.7 Flow graph — node fields (multi-node agents)

All **require** `version_id`, `is_draft`, `new_draft`, `node_id` plus the field listed. Response is `{ "message": "...", "node_id": "..." }` unless noted.

| Operation | Field(s) | Notes |
|---|---|---|
| `edit_node_position` | `position` `{x, y}` | |
| `edit_node_positions` | `positions` `[{ "node_id", "x", "y" }]` (no single `node_id` needed) | Unknown ids are skipped. Returns `{ message, updated, skipped }`. |
| `edit_node_meta` | at least one of `label`, `description` | `label` change regenerates the internal `name`. (`name` in the payload is ignored.) |
| `edit_node_intro_message` | `intro_message` | Jinja validated. |
| `edit_node_messages` | at least one of `intro_message`, `role_messages`, `task_messages` | Message item shape: `{ "role": "system", "content": "..." }` (editor shape with `prompt_sections` also accepted). Returns `updated_fields`. |
| `edit_node_functions` | `functions` (list of API tool / on-call tool dicts) | Full replacement. Same validation as agent tools (jq safety, prompt references). |
| `edit_node_pre_actions` | `pre_actions` (list; `[]` clears) | e.g. `{ "type": "tts_say", "text": "..." }` |
| `edit_node_post_actions` | `post_actions` (list) | |
| `edit_node_predefined_tools` | `predefined_tools` (list of strings, e.g. `["end_call"]`) | Stored as `[{ "name": "end_call" }]`. |
| `edit_node_context_strategy` | `context_strategy` `{ "strategy": "append" \| "reset" \| "reset_with_summary" \| "reset_with_conversation", "summary_prompt": "..." }` | `summary_prompt` required for `reset_with_summary` (checked at publish). |
| `edit_node_respond_immediately` | `respond_immediately` (bool) | |
| `edit_node_voice_override` | `voice_id`, `language`; optional `secondary_voice_id` (`""` clears), `secondary_language` | Stored in `node.overrides.tts`. Returns `overrides.tts`. |
| `edit_node_dtmf_override` | `dtmf_settings` (same shape as agent-level; `end` stored as list) | Stored in `node.overrides.dtmf`. |
| `edit_node_pre_query_phrases` | `pre_query_response_phrases` (list of strings); optional `pre_query_phrase_probability` | Stored in `node.overrides`. |
| `edit_node_per_type_config` | `per_type_config` (object, shallow-merged into `node.node_config`); optional `label`, `description` | For deterministic nodes. Nested arrays (e.g. router `branches`) must be sent whole. Returns `node_type` too. |

### 4.8 `per_type_config` by node type

Shallow-merged into `node_config`. Node references (`failure_next`, `exhausted_next`, `default_next`, `unclear_next`) accept a node id, base node id, or node name. Full graph validation runs at publish time, not here.

| Node type | Keys |
|---|---|
| `speak_node` | `text` (string, or `{ "<lang>": ["variant", ...] }`), `interruptible` (bool), `voice_override`, `language_override` |
| `router_node` | `mode`: `"llm"` or `"condition"`. LLM: `branches` (staging `[{ id, description }]`, promoted onto edges), `unclear_next`, `exhausted_next`, `reprompt_message`, `max_attempts`, `extract`. Condition: `conditions` (`[{ id, rules... }]`, `id` = edge `branch_id`), `default_next`. |
| `action_node` | `action_type`: `"webhook"` \| `"kb_lookup"` \| `"integration"`; `webhook` `{ url, method, headers, body, query_params }`; `kb` `{ kb_id }`; `integration` `{...}`; `failure_next` (required at publish), `store_as`, `store_response` (`{ name: jsonpath }` or `[{ variable_name, jsonpath }]`), `retries` (0–3), `timeout_ms`, `on_running_say` |
| `transfer_node` | `target` (phone number) or `target_id` (agent id), `pre_say`, `handoff_message` |
| `keypad_menu_node` | `branches` `[{ id, digit }]` (digit ∈ 0–9, `*`, `#`, unique; each wired via an edge whose `transition_config.branch_id` = `id`), `exhausted_next` / `default_next` (one required), `max_attempts`, `reprompt`, `dtmf`, `store_variable` |
| `collect_node` | `collect_type`: `phone` \| `email` \| `otp` \| `pin`; `failure_next` (required); `store_variable`; `max_attempts`; `reask_prompt`; `country_default` (1–4 digits, phone); `num_digits` (3–10, otp/pin); `allow_keypad`; `keypad_dtmf` |
| `widget_node` | `tool_id` of an enabled `BLOCKS_WIDGET_TOOL` on the agent (static widgets only) |

---

## 5. Full field reference

Every field the schema accepts, with type and which operations read it.

| Field | Type | Used by |
|---|---|---|
| `operation` | enum | all |
| `agent_id` | uuid | all |
| `version_id` | uuid | all non-A/B ops (optional), flow ops (required), `edit_version_description`, `delete_version` |
| `is_draft` / `new_draft` | bool | flow ops (required), others optional |
| `config_type` | `outbound` \| `inbound` | runtime-config ops on `outbound_inbound` agents |
| `number_id` | uuid | attach/remove inbound number |
| `kb_id` | uuid | KB ops |
| `node_id` | uuid | node KB ops, all node-field ops, `add_flow_node`, `delete_flow_node` |
| `custom_variables` | list[str] | `edit_custom_vars` |
| `agent_display_name` | str | `edit_agent_display_name` |
| `agent_prompt` | str \| object | `edit_prompt` |
| `intro_message` | str | `edit_intro_message`, `edit_node_intro_message`, `edit_node_messages` |
| `pre_query_response_phrases` | list[str] | `edit_query_phrases`, `edit_node_pre_query_phrases` |
| `pre_query_phrase_probability` | float 0–1 | same |
| `mute_while_bot_speaking`, `mute_during_intro` | bool | `edit_noise_settings` |
| `voice_id`, `language` | uuid, locale | `edit_voice`, `edit_node_voice_override` |
| `secondary_voice_id`, `secondary_language` | uuid/`""`, locale | `edit_voice`, `edit_node_voice_override` |
| `additional_languages` | list[locale] | `edit_voice` |
| `voice_speed` | float | `edit_voice_speed` |
| `vocab` | list[str] | `edit_vocab` |
| `dtmf_settings` | object | `edit_dtmf_settings`, `edit_node_dtmf_override` |
| `vad_settings` | object | `edit_vad_settings` |
| `whitelisted_domains` | list[str] | `edit_agent_whitelisted_domains` |
| `call_config` | object | `edit_call_config` |
| `timezone` | str | `edit_timezone` |
| `llm_temperature` | float | `edit_llm_temperature` |
| `is_demo_enabled` | bool | `edit_demo_settings` |
| `custom_analysis_prompt` | object | `edit_custom_analysis_prompt` |
| `client_analysis` | object | `edit_client_analysis` |
| `classification_labels` | object | `edit_classification_labels` |
| `event_subscriptions` | list[object] | `edit_event_subscriptions` |
| `chat_settings` | object | `edit_chat_settings` |
| `rate_limit` | object \| null | `edit_rate_limit` |
| `analytics_context` | object | `edit_analytics_context` |
| `enable_outbound_inbound` | bool | `edit_outbound_inbound` |
| `tool_type` | str | bulk tool ops |
| `tools` | list[object] | bulk tool ops |
| `on_call_tool` | object | `edit_on_call_tool` |
| `tool_id` | str | `remove_on_call_tool` |
| `base_version_id` | uuid | `add_new_ab_version` |
| `description` | str | `edit_version_description`, `edit_node_meta`, `edit_node_per_type_config` |
| `traffic_split` | `{version_id: float}` | `edit_traffic` |
| `ab_enabled` | bool | `toggle_ab_testing` |
| `prod_version_id` | uuid | `push_to_prod` |
| `node_type` | enum | `add_flow_node` |
| `position` | `{x, y}` | `add_flow_node`, `edit_node_position` |
| `positions` | list | `edit_node_positions` |
| `label` | str | `edit_node_meta`, `edit_node_per_type_config` (and inside `node_config` for `add_flow_node`) |
| `node_config` | object | `add_flow_node` |
| `per_type_config` | object | `edit_node_per_type_config` (and inside `node_config` for `add_flow_node`) |
| `source_node_id`, `prev_node_id` | uuid | `add_flow_node` |
| `edge_id`, `source_id`, `target_id` | uuid | edge ops |
| `condition`, `transition_config`, `transition_message` | str, object, str | `add_flow_edge`, `update_agent_edge` |
| `new_source_id`, `new_target_id` | uuid | `update_agent_edge` |
| `role_messages`, `task_messages` | list[object] | `edit_node_messages` |
| `functions` | list | `edit_node_functions` |
| `pre_actions`, `post_actions` | list | node action ops |
| `predefined_tools` | list[str] | `edit_node_predefined_tools` |
| `context_strategy` | object | `edit_node_context_strategy` |
| `respond_immediately` | bool | `edit_node_respond_immediately` |

**Declared but unused by any operation** (safe to omit): `agent_name`, `name`, `voicemail`, `timeout_msg_on`, `timeout_texts`, `timeout_msg_dur`, `api_config`, `extract_callee_name`, `outbound_from_number_ids`.

---

## 6. Examples

Change the prompt on the active version:
```json
{ "operation": "edit_prompt", "agent_id": "…",
  "agent_prompt": { "prompt_sections": [ { "section_title": "Role", "section_content": "You are a support agent for {{company}}." } ] } }
```

Attach a KB to a draft of a multi-node agent:
```json
{ "operation": "attach_kb", "agent_id": "…", "version_id": "<base version>", "is_draft": true, "new_draft": false, "kb_id": "…" }
```

Add a speak node after start and wire it:
```json
{ "operation": "add_flow_node", "agent_id": "…", "version_id": "…", "is_draft": true, "new_draft": false,
  "node_id": "<new uuid>", "node_type": "speak_node", "position": { "x": 200, "y": 100 },
  "prev_node_id": "<start node id>",
  "node_config": { "label": "Greeting", "per_type_config": { "text": "Hi, this is Ringg.", "interruptible": true } } }
```

Upsert an on-call API tool:
```json
{ "operation": "edit_on_call_tool", "agent_id": "…",
  "on_call_tool": { "tool_type": "API_TOOL", "tool_name": "get_order", "description": "Fetch order status",
    "config": { "url": "https://api.example.com/orders", "method": "GET",
      "query": [ { "key": "id", "value": "the order id the caller gives", "type": "dynamic", "data_type": "string", "required": true } ] } } }
```

Split traffic across two A/B versions:
```json
{ "operation": "edit_traffic", "agent_id": "…", "traffic_split": { "<version A>": 0.5, "<version B>": 0.5 } }
```
