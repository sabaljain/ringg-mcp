/**
 * Configuration loaded from the environment at startup.
 *
 * The API key lives here and in the RinggClient's request headers only. It is never
 * returned by a tool, never logged, and never included in tool output. `redact()` in
 * ringg/errors.ts scrubs it from anything that could reach stderr or a tool result.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_URL = "https://prod-api.ringg.ai/ca/api/v0";
export const DEFAULT_STT_BASE_URL = "https://prod-api.ringg.ai/stt/v1";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_STT_TIMEOUT_MS = 120_000;

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Config {
  /** Workspace API key sent as the X-API-KEY header. Treat as a secret. */
  apiKey: string;
  /** Base URL with no trailing slash. */
  baseUrl: string;
  /** Speech-to-text base URL with no trailing slash. A separate service; the same key. */
  sttBaseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Timeout for one transcription request, upload included. */
  sttTimeoutMs: number;
  /** Whether to probe GET /workspace at startup to validate the key. */
  verifyOnStart: boolean;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer. Received: ${raw}`);
  }
  return parsed;
}

function parseBaseUrl(raw: string | undefined, fallback: string, name: string): string {
  const trimmed = raw?.trim();
  const baseUrl = (trimmed && trimmed.length > 0 ? trimmed : fallback).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError(`${name} is not a valid URL. Received: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new ConfigError(`${name} must use https. Received: ${baseUrl}`);
  }
  return baseUrl;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/**
 * Minimal .env reader, so the API key can live in one gitignored file instead of being
 * embedded in the MCP client's config. No dependency: the format we need is trivial.
 *
 * Real environment variables always win over the file, so an explicit `--env` on the
 * MCP registration still overrides it.
 */
function loadDotEnv(env: NodeJS.ProcessEnv): void {
  const explicit = env.RINGG_ENV_FILE?.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = explicit
    ? [resolve(explicit)]
    : [resolve(here, "../.env"), resolve(here, "../../.env"), resolve(process.cwd(), ".env")];

  for (const path of candidates) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (env[key] !== undefined) continue; // real env wins
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return; // first file found wins
  }
}

/**
 * Reads and validates configuration. Throws ConfigError with an actionable message
 * rather than exiting, so the caller controls the exit path (and the exit code).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv(env);

  const apiKey = env.RINGG_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "RINGG_API_KEY is not set. Put it in a .env file at the project root " +
        "(RINGG_API_KEY=...), set RINGG_ENV_FILE to point at one, or add it to the env " +
        "block of this server's entry in your MCP client config, then restart. " +
        "Generate a key at https://www.ringg.ai/dashboard/api under Settings -> API Key.",
    );
  }

  const baseUrl = parseBaseUrl(env.RINGG_BASE_URL, DEFAULT_BASE_URL, "RINGG_BASE_URL");
  const sttBaseUrl = parseBaseUrl(env.RINGG_STT_BASE_URL, DEFAULT_STT_BASE_URL, "RINGG_STT_BASE_URL");

  const rawLevel = env.RINGG_LOG_LEVEL?.trim().toLowerCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel ?? "")
    ? (rawLevel as LogLevel)
    : "info";

  return {
    apiKey,
    baseUrl,
    sttBaseUrl,
    timeoutMs: parsePositiveInt(env.RINGG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "RINGG_TIMEOUT_MS"),
    sttTimeoutMs: parsePositiveInt(env.RINGG_STT_TIMEOUT_MS, DEFAULT_STT_TIMEOUT_MS, "RINGG_STT_TIMEOUT_MS"),
    verifyOnStart: parseBool(env.RINGG_VERIFY_ON_START, false),
    logLevel,
  };
}
