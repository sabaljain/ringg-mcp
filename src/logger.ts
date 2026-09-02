/**
 * stderr-only logger.
 *
 * HARD CONSTRAINT: stdout carries the JSON-RPC stream when running over stdio. There is
 * deliberately no stdout code path in this module. Do not add one.
 */

import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
}

/** Scrubs secrets before anything is written. Set by createLogger's caller. */
type Redactor = (input: string) => string;

let redactor: Redactor = (s) => s;

/** Installs the secret redactor used by every log line. Call once at startup. */
export function setLogRedactor(fn: Redactor): void {
  redactor = fn;
}

function write(level: LogLevel, msg: string, meta: unknown): void {
  const ts = new Date().toISOString();
  let line = `${ts} [ringg-mcp] ${level.toUpperCase()} ${msg}`;
  if (meta !== undefined) {
    let rendered: string;
    try {
      rendered = typeof meta === "string" ? meta : JSON.stringify(meta);
    } catch {
      rendered = "[unserializable]";
    }
    line += ` ${rendered}`;
  }
  process.stderr.write(`${redactor(line)}\n`);
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = RANK[level];
  const at = (l: LogLevel) => (msg: string, meta?: unknown) => {
    if (RANK[l] <= threshold) write(l, msg, meta);
  };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
}

/** Logger usable before config is parsed (e.g. to report a config failure). */
export const bootLogger: Logger = createLogger("info");
