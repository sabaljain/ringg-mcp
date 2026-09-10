/**
 * Ringg REST API client.
 *
 * Transport-agnostic: knows nothing about MCP or stdio. The only place the API key is
 * attached to a request. Envelope unwrapping is per-endpoint (see note below) rather
 * than assumed, because Ringg is not consistent about it:
 *
 *   GET /agent/all          -> { status, data: { agents: [...] } }
 *   GET /agent/{id}         -> { agents: {...} }            (no status/data wrapper)
 *   GET /external/kb/all    -> [ ... ]                      (bare array)
 *   GET /calling/history    -> { calls: [...], limit, ... } (no wrapper)
 *   GET /calling/call-details -> { status, data: {...} }
 *
 * Speech-to-text is a separate service under its own base URL (RINGG_STT_BASE_URL). The
 * same workspace key authenticates it, so its requests come through here too.
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
  RinggApiError,
  RinggTimeoutError,
  RinggTransportError,
  redactDeep,
  registerSecret,
} from "./errors.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Query;
  /** Sent as JSON, except FormData, which goes out as multipart with fetch's own boundary. */
  body?: unknown;
  /** Which service `path` is relative to. Defaults to the platform API. */
  service?: "platform" | "stt";
}

export class RinggClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #sttBaseUrl: string;
  readonly #timeoutMs: number;
  readonly #sttTimeoutMs: number;
  readonly #log: Logger;

  constructor(config: Config, logger: Logger) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl;
    this.#sttBaseUrl = config.sttBaseUrl;
    this.#timeoutMs = config.timeoutMs;
    this.#sttTimeoutMs = config.sttTimeoutMs;
    this.#log = logger;
    registerSecret(config.apiKey);
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  #buildUrl(base: string, path: string, query?: Query): string {
    const url = new URL(base + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const { method, query, body } = options;
    const stt = options.service === "stt";
    const url = this.#buildUrl(stt ? this.#sttBaseUrl : this.#baseUrl, options.path, query);
    // Errors and logs name the path. An STT path carries its service prefix so it cannot
    // be mistaken for a platform endpoint.
    const path = stt ? new URL(url).pathname : options.path;
    const timeoutMs = stt ? this.#sttTimeoutMs : this.#timeoutMs;
    const isForm = body instanceof FormData;

    const headers: Record<string, string> = {
      "X-API-KEY": this.#apiKey,
      Accept: "application/json",
    };
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

    // Log the path and query but never the headers - they carry the key.
    this.#log.debug("ringg request", { method, path, query: query ?? {} });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RinggTimeoutError(method, path, timeoutMs);
      }
      throw new RinggTransportError(method, path, err);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      throw new RinggApiError({
        status: response.status,
        statusText: response.statusText,
        method,
        path,
        body: parsed,
      });
    }

    this.#log.debug("ringg response", { method, path, status: response.status });
    return redactDeep(parsed) as T;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>({ method: "GET", path, query });
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "PATCH", path, body });
  }

  /** Multipart POST to the speech-to-text service. */
  postStt<T = unknown>(path: string, form: FormData): Promise<T> {
    return this.request<T>({ method: "POST", path, body: form, service: "stt" });
  }

  /**
   * Documented authentication check (api-reference/quick-start/authentication.md).
   * Used only by the opt-in startup probe; not exposed as a tool.
   */
  async verifyCredentials(): Promise<{ id?: string; name?: string }> {
    const res = await this.get<{ workspace_info?: { id?: string; name?: string } }>("/workspace");
    return res?.workspace_info ?? {};
  }
}
