/**
 * stdio transport edge. The ONLY place in this codebase aware of stdio.
 *
 * HARD CONSTRAINT: stdout carries the JSON-RPC stream. A single stray write to stdout
 * corrupts the session. guardStdout() below redirects console.* to stderr before the
 * transport connects, so a stray console.log anywhere - ours or a dependency's - is
 * defused rather than fatal.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError, type Config } from "../config.js";
import { bootLogger, createLogger, setLogRedactor } from "../logger.js";
import { redact, registerSecret, toUserMessage } from "../ringg/errors.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../server.js";

/**
 * Redirects every console method to stderr. Must run before the transport connects,
 * so that a stray console.log anywhere - ours or a dependency's - cannot reach stdout.
 */
export function guardStdout(): void {
  const toStderr =
    (label: string) =>
    (...args: unknown[]): void => {
      const rendered = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      process.stderr.write(`${redact(`[${label}] ${rendered}`)}\n`);
    };

  console.log = toStderr("console.log");
  console.info = toStderr("console.info");
  console.warn = toStderr("console.warn");
  console.debug = toStderr("console.debug");
  console.error = toStderr("console.error");
  console.trace = toStderr("console.trace");
}

/**
 * Loads config or terminates the process. Returns `Config` (never undefined) so the
 * caller does not have to reason about a partially-initialised startup.
 */
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    // Fail fast: one clear line on stderr, nothing on stdout, no interactive prompt.
    const message =
      err instanceof ConfigError ? err.message : `startup failed: ${toUserMessage(err)}`;
    process.stderr.write(`${SERVER_NAME}: ${message}\n`);
    process.exit(1);
  }
}

export async function runStdioServer(): Promise<void> {
  guardStdout();
  setLogRedactor(redact);

  const config = loadConfigOrExit();
  registerSecret(config.apiKey);
  const logger = createLogger(config.logLevel);

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", toUserMessage(reason));
    process.exitCode = 1;
  });
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", toUserMessage(err));
    process.exit(1);
  });

  const { server, client } = createServer({ config, logger });

  if (config.verifyOnStart) {
    try {
      const workspace = await client.verifyCredentials();
      logger.info("API key verified", { workspace: workspace.name ?? workspace.id ?? "(unnamed)" });
    } catch (err) {
      // Do not exit: the key may be fine and the network merely unavailable. Report and continue.
      logger.error(
        "startup verification against GET /workspace failed; tools will report the same error when called",
        toUserMessage(err),
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`, { baseUrl: config.baseUrl });

  const shutdown = (signal: string) => () => {
    logger.info(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
}
