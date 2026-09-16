/**
 * @nautilo/mcp-client — stdio transport wrapper (Phase 0, task 0.4).
 *
 * Wraps the SDK `StdioClientTransport` to:
 *
 * - Build the child env from the operator config: SDK safe-inheritance
 *   baseline + env-passthrough VALUES resolved at spawn time (never
 *   stored) + non-secret literal env. Auth env (bearer tokens etc.) is
 *   Phase 4; until then `resolveMcpAuth` throws if a config requires it.
 * - Redirect the child's stderr to `~/.nautilo/logs/mcp-stderr-<server>.log`
 *   so server diagnostics survive but never bleed into the JSON-RPC
 *   stdin/stdout stream.
 * - Provide a graceful shutdown ladder: close SDK transport (which does
 *   stdin.end → SIGTERM after 2s → SIGKILL after another 2s) and then
 *   flush + destroy the stderr log stream.
 *
 * Streamable-HTTP transport is Phase 1 — see `./streamable-http.ts`.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildSpawnEnv } from "../resolve-auth.ts";
import type { McpServerConfig, McpStdioTransportConfig } from "../types.ts";

export interface StdioTransportOptions {
  /**
   * Directory for the per-server stderr log file. Defaults to
   * `~/.nautilo/logs`. Override in tests to keep logs out of the
   * operator's home dir.
   */
  logDir?: string;
  /**
   * Richer host-provided env baseline merged UNDER passthrough/literal but
   * OVER the SDK safe-list (see `buildSpawnEnv`). Local-tier hosts pass the
   * user's real shell env (PATH, JAVA_HOME, …) so toolchain-dependent MCP
   * servers actually start. Server-tier omits this.
   */
  spawnEnvBase?: Record<string, string> | undefined;
}

export interface NautiloStdioTransport {
  /**
   * The underlying SDK transport. Pass this to `Client.connect()` — the
   * SDK `Client` owns `start()` / `send()` / the JSON-RPC callbacks.
   */
  readonly inner: StdioClientTransport;
  /** Stop the child process (graceful ladder) and clean up the stderr log stream. */
  close(): Promise<void>;
  /** Absolute path of the stderr log file this wrapper writes to. */
  readonly logPath: string;
}

/**
 * Sanitize a server name for use as a log file basename. Strips path
 * separators and shell metacharacters; collapses runs of non-word chars
 * to a single `-`.
 */
function safeLogBasename(serverName: string): string {
  const cleaned = serverName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "server";
}

function resolveLogDir(override?: string): string {
  if (override) return override;
  return join(homedir(), ".nautilo", "logs");
}

/**
 * Create a stdio transport for an MCP server config. Does NOT spawn yet —
 * the SDK spawns inside `start()`, which `Client.connect()` calls.
 *
 * Throws if the config's transport isn't a stdio transport config.
 */
export function createStdioTransport(
  cfg: McpServerConfig,
  options: StdioTransportOptions = {},
): NautiloStdioTransport {
  if (cfg.transportKind !== "stdio") {
    throw new Error(
      `[mcp] createStdioTransport: server "${cfg.name}" has transportKind "${cfg.transportKind}", expected "stdio".`,
    );
  }
  const transportCfg = cfg.transport as McpStdioTransportConfig;
  if (!transportCfg || typeof transportCfg.command !== "string") {
    throw new Error(
      `[mcp] createStdioTransport: server "${cfg.name}" stdio transport config missing "command".`,
    );
  }

  const env = buildSpawnEnv(cfg, process.env, options.spawnEnvBase);

  const logDir = resolveLogDir(options.logDir);
  const logPath = join(logDir, `mcp-stderr-${safeLogBasename(cfg.name)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const stderrLog = createWriteStream(logPath, { flags: "a" });

  // Pass `stderr: "pipe"` and pipe the PassThrough to our log file. The
  // SDK constructs the PassThrough eagerly in the constructor when
  // `stderr === "pipe"`, so we can attach the pipe BEFORE start() and
  // lose no early output.
  const inner = new StdioClientTransport({
    command: transportCfg.command,
    ...(transportCfg.args ? { args: [...transportCfg.args] } : {}),
    env,
    ...(transportCfg.cwd ? { cwd: transportCfg.cwd } : {}),
    stderr: "pipe",
  });
  const stderrStream = inner.stderr;
  if (stderrStream !== null) {
    (stderrStream as unknown as Writable).pipe(stderrLog);
  }

  return {
    inner,
    logPath,
    async close(): Promise<void> {
      await inner.close();
      stderrLog.end();
      stderrLog.destroy();
    },
  };
}
