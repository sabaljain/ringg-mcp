/**
 * Error types and secret redaction for the Ringg API client.
 */

/** Registered secrets, longest first, so overlapping values redact predictably. */
const secrets: string[] = [];

/**
 * Registers a value that must never appear in logs, error messages, or tool output.
 * Short values are ignored: redacting a 3-character string would mangle unrelated text.
 */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  if (!secrets.includes(trimmed)) {
    secrets.push(trimmed);
    secrets.sort((a, b) => b.length - a.length);
  }
}

/** Replaces every registered secret in `input` with a placeholder. */
export function redact(input: string): string {
  let out = input;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** Recursively redacts strings inside an arbitrary structure. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface RinggApiErrorInit {
  status: number;
  statusText: string;
  method: string;
  path: string;
  /** Parsed or raw response body, already redacted. */
  body?: unknown;
}

/** An error returned by the Ringg API (non-2xx response). */
export class RinggApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(init: RinggApiErrorInit) {
    super(redact(RinggApiError.buildMessage(init)));
    this.name = "RinggApiError";
    this.status = init.status;
    this.statusText = init.statusText;
    this.method = init.method;
    this.path = init.path;
    this.body = redactDeep(init.body);
  }

  private static buildMessage(init: RinggApiErrorInit): string {
    const detail = RinggApiError.extractDetail(init.body);
    const hint = RinggApiError.hintFor(init.status);
    // HTTP/2 carries no status text, so statusText is often empty.
    const status = init.statusText ? `${init.status} ${init.statusText}` : String(init.status);
    const parts = [`Ringg API ${status} on ${init.method} ${init.path}`];
    if (detail) parts.push(`- ${detail}`);
    if (hint) parts.push(`(${hint})`);
    return parts.join(" ");
  }

  /**
   * Ringg returns errors in at least two shapes: `{detail: "..."}` (agent endpoints)
   * and `{error: {code, message}}` (documented in api-overview.md). Handle both.
   */
  private static extractDetail(body: unknown): string | undefined {
    if (!body) return undefined;
    if (typeof body === "string") return body.slice(0, 500) || undefined;
    if (typeof body !== "object") return undefined;
    const b = body as Record<string, unknown>;
    if (typeof b.detail === "string") return b.detail;
    if (typeof b.message === "string") return b.message;
    const err = b.error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const code = typeof e.code === "string" ? e.code : undefined;
      const message = typeof e.message === "string" ? e.message : undefined;
      if (code && message) return `${code}: ${message}`;
      return message ?? code;
    }
    if (typeof b.error === "string") return b.error;
    return undefined;
  }

  private static hintFor(status: number): string | undefined {
    switch (status) {
      case 400:
        return "invalid parameters or request format";
      case 401:
        return "RINGG_API_KEY is missing, invalid, or was rotated";
      case 403:
        return "key is valid but lacks permission for this action";
      case 404:
        return "resource does not exist in this workspace";
      case 429:
        return "rate limit exceeded; back off and retry";
      default:
        return status >= 500 ? "Ringg server or upstream provider issue; retry with backoff" : undefined;
    }
  }
}

/** A network-level failure: DNS, TLS, connection reset, or timeout. */
export class RinggTransportError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(redact(`Could not reach the Ringg API on ${method} ${path}: ${reason}`));
    this.name = "RinggTransportError";
    this.method = method;
    this.path = path;
    this.cause = cause;
  }
}

/** A request that exceeded the configured timeout. */
export class RinggTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`Ringg API request timed out after ${timeoutMs}ms on ${method} ${path}`);
    this.name = "RinggTimeoutError";
  }
}

/** Raised when the API responds 2xx but the payload is not what the tool needs. */
export class RinggShapeError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = "RinggShapeError";
  }
}

/** Converts any thrown value into a redacted, human-readable message. */
export function toUserMessage(err: unknown): string {
  if (
    err instanceof RinggApiError ||
    err instanceof RinggTransportError ||
    err instanceof RinggTimeoutError ||
    err instanceof RinggShapeError
  ) {
    return err.message;
  }
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
