import { z } from "zod";
import { editAgent, getAgentRaw, resolveWriteVersionId } from "../../ringg/agents.js";
import { RinggApiError, RinggShapeError } from "../../ringg/errors.js";
import { isObject, readVersionField } from "../../ringg/normalize.js";
import { defineTool } from "../types.js";

/** Declared types a key may take (docs/edit-agent-api.md section 4.3). */
const KEY_TYPES = ["string", "integer", "number", "boolean", "array", "date", "datetime"] as const;
type KeyType = (typeof KEY_TYPES)[number];

export const updateCustomAnalysisPromptTool = defineTool({
  name: "update_custom_analysis_prompt",
  title: "Update post-call analysis prompt",
  description:
    "Configure the structured data extracted from each call transcript after the call ends. " +
    "'prompt' tells the analyser what to look for; 'keys' declares the fields it returns and " +
    "their types; 'defaults' supplies fallbacks when a field cannot be determined. " +
    "The platform stores prompt and keys as a unit and requires both, so the default 'merge' mode " +
    "reads the current config and overlays only what you supply - letting you add one key without " +
    "restating the whole prompt. Use mode='replace' to set exactly what you pass, or clear=true to " +
    "remove the configuration entirely. Call get_agent first to see the current keys.",
  inputSchema: {
    agent_id: z.string().min(1).describe("The agent's UUID."),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("Instructions for the analyser. Required unless merging into an existing prompt."),
    keys: z
      .record(z.enum(KEY_TYPES))
      .optional()
      .describe(
        "Fields to extract, as { field_name: type }. Types: string, integer, number, boolean, " +
          "array, date, datetime. In merge mode these are added to the existing keys.",
      ),
    remove_keys: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Field names to drop (merge mode). Removing a key that an agent tool still references " +
          "as client_analysis.<key> is rejected by the platform.",
      ),
    defaults: z
      .record(z.unknown())
      .optional()
      .describe(
        "Fallback values, as { field_name: value }. Every name must also appear in keys, and the " +
          "value must match that key's declared type.",
      ),
    mode: z
      .enum(["merge", "replace"])
      .default("merge")
      .describe("'merge' (default) keeps keys you did not mention. 'replace' sets exactly what you pass."),
    clear: z
      .boolean()
      .optional()
      .describe("Remove the analysis configuration entirely. Ignores every other field."),
    version_id: z
      .string()
      .min(1)
      .optional()
      .describe("Target a specific agent version. Defaults to the version the current config was read from."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, { client }) {
    // 'replace' discards keys, so an absent mode must not select it.
    const mode = args.mode ?? "merge";
    const agent = await getAgentRaw(client, args.agent_id);
    const current = readVersionField(agent, "custom_analysis_prompt");
    const versionId = args.version_id ?? resolveWriteVersionId(agent);
    const existing = isObject(current.value) ? current.value : {};

    if (args.clear) {
      const response = await editAgent(
        client,
        "edit_custom_analysis_prompt",
        args.agent_id,
        { custom_analysis_prompt: {} },
        { versionId },
      );
      return {
        agent_id: args.agent_id,
        version_id: versionId,
        cleared: true,
        before: current.value ?? null,
        api_response: response,
        verify_with: "get_agent",
      };
    }

    const existingKeys = isObject(existing.keys) ? { ...(existing.keys as Record<string, unknown>) } : {};
    const existingDefaults = isObject(existing.defaults)
      ? { ...(existing.defaults as Record<string, unknown>) }
      : {};
    const existingPrompt = typeof existing.prompt === "string" ? existing.prompt : undefined;

    let keys: Record<string, unknown>;
    let defaults: Record<string, unknown>;
    let prompt: string | undefined;
    const removed: string[] = [];

    if (mode === "merge") {
      keys = { ...existingKeys, ...(args.keys ?? {}) };
      defaults = { ...existingDefaults, ...(args.defaults ?? {}) };
      prompt = args.prompt ?? existingPrompt;
      for (const name of args.remove_keys ?? []) {
        if (name in keys) {
          delete keys[name];
          delete defaults[name];
          removed.push(name);
        }
      }
    } else {
      keys = { ...(args.keys ?? {}) };
      defaults = { ...(args.defaults ?? {}) };
      prompt = args.prompt;
      removed.push(...Object.keys(existingKeys).filter((k) => !(k in keys)));
    }

    // The platform requires prompt and keys together and rejects the pair otherwise.
    // Checking here turns a generic 400 into a message that names what is missing.
    if (!prompt) {
      throw new RinggShapeError(
        "A prompt is required: the platform stores prompt and keys as a unit. Supply 'prompt', or " +
          "use mode='merge' on an agent that already has one. To remove the configuration, pass clear=true.",
      );
    }
    if (Object.keys(keys).length === 0) {
      throw new RinggShapeError(
        "At least one key is required: the platform stores prompt and keys as a unit. Supply 'keys', " +
          "or pass clear=true to remove the configuration entirely.",
      );
    }

    // defaults must be a subset of keys, and each value must match its declared type.
    const orphaned = Object.keys(defaults).filter((name) => !(name in keys));
    if (orphaned.length > 0) {
      throw new RinggShapeError(
        `These defaults have no matching key, which the platform rejects: ${orphaned.join(", ")}. ` +
          "Declare them in 'keys' or drop them from 'defaults'.",
      );
    }
    const mismatched: string[] = [];
    for (const [name, value] of Object.entries(defaults)) {
      const declared = keys[name];
      if (typeof declared === "string" && !matchesType(value, declared as KeyType)) {
        mismatched.push(`${name} (declared ${declared}, got ${describe(value)})`);
      }
    }
    if (mismatched.length > 0) {
      throw new RinggShapeError(
        `These defaults do not match their declared type, which the platform rejects: ${mismatched.join("; ")}.`,
      );
    }

    const payload: Record<string, unknown> = { prompt, keys };
    if (Object.keys(defaults).length > 0) payload.defaults = defaults;

    let response: unknown;
    try {
      response = await editAgent(
        client,
        "edit_custom_analysis_prompt",
        args.agent_id,
        { custom_analysis_prompt: payload },
        { versionId },
      );
    } catch (err) {
      // Removing a key an agent tool still reads is rejected; name the likely cause.
      if (err instanceof RinggApiError && err.status === 400 && removed.length > 0) {
        throw new RinggShapeError(
          `Ringg rejected the change, and this request removed ${removed.join(", ")}. A tool on this ` +
            `agent may still reference one of them as client_analysis.<key>, which the platform ` +
            `refuses to break. Nothing was written. Original error: ${err.message}`,
        );
      }
      throw err;
    }

    return {
      agent_id: args.agent_id,
      version_id: versionId,
      mode,
      read_from: current.source,
      applies_to: agent.orchestration_mode === "multi_node" ? "targeted version only" : "all active versions",
      keys_before: Object.keys(existingKeys),
      keys_after: Object.keys(keys),
      removed,
      warning:
        mode === "replace" && removed.length > 0
          ? `mode='replace' discarded ${removed.length} key(s): ${removed.join(", ")}`
          : undefined,
      api_response: response,
      verify_with: "get_agent",
    };
  },
});

function matchesType(value: unknown, type: KeyType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "date":
    case "datetime":
      // Carried as ISO strings; the platform does the format checking.
      return typeof value === "string";
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
