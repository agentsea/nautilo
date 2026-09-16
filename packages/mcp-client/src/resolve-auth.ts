/**
 * @nautilo/mcp-client — auth resolution seam (Phase 0, task 0.5).
 *
 * THE single place MCP credentials are resolved. The contract:
 *
 * - `cfg.authRef == null` → return `null` (no auth required).
 * - `cfg.envPassthrough` declares env var NAMES; their VALUES are read
 *   from `process.env` here at call time and returned to the caller (the
 *   stdio transport merges them into the child's spawn env). Values are
 *   NEVER stored on the config or anywhere else — they live only in the
 *   returned object for the brief moment between resolve and spawn.
 * - `cfg.authRef != null` → throw `McpAuthNotAvailableError`. Vault
 *   wiring is Phase 4; until then we fail closed rather than silently
 *   spawning a server that expects auth we can't provide.
 *
 * Scope is the call site's choice (e.g. "spawn", "headers") so callers
 * can record WHICH resolution path was used in logs without this module
 * knowing about transport kinds.
 */

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpAuthRef, McpResolvedAuth, McpServerConfig } from "./types.ts";

/** A name-only environment readiness check safe to return over the relay wire. */
export interface McpEnvironmentPresence {
  readonly name: string;
  readonly present: boolean;
}

/**
 * Thrown when a config declares `authRef` (vault-backed auth) but no
 * vault is wired yet. Phase 4 will replace this with real vault reads.
 */
export class McpAuthNotAvailableError extends Error {
  readonly authRef: McpAuthRef;
  readonly serverName: string;
  constructor(serverName: string, authRef: McpAuthRef) {
    const kind =
      authRef !== null && authRef !== undefined ? authRef.type : "unknown";
    super(
      `[mcp] Server "${serverName}" declares authRef (type=${kind}) but vault wiring is not available yet (Phase 4). Refusing to spawn.`,
    );
    this.name = "McpAuthNotAvailableError";
    this.authRef = authRef;
    this.serverName = serverName;
  }
}

/**
 * Thrown when a config declares `authRef: { type: "env", envVar }` but the
 * named env var is unset/empty. Fail closed rather than connect unauthenticated.
 */
export class McpEnvTokenMissingError extends Error {
  readonly serverName: string;
  readonly envVar: string;
  constructor(serverName: string, envVar: string) {
    super(
      `[mcp] Server "${serverName}" declares an env-token auth ref but env var "${envVar}" is unset. Refusing to connect.`,
    );
    this.name = "McpEnvTokenMissingError";
    this.serverName = serverName;
    this.envVar = envVar;
  }
}

/**
 * Resolve auth for an MCP server config.
 *
 * Returns:
 * - `null` when no auth is required (no authRef and no env passthrough
 *   credential resolution was requested — passthrough VALUES are
 *   returned via {@link resolveEnvPassthrough}, a separate function, so
 *   that the spawn path can merge them into the child env without
 *   conflating them with "auth" in the bearer/header sense).
 * - Throws `McpAuthNotAvailableError` when `authRef` is set.
 *
 * The `scope` argument is purely informational (used in future logging).
 */
export function resolveMcpAuth(
  cfg: McpServerConfig,
  scope: "spawn" | "headers" = "spawn",
): McpResolvedAuth {
  void scope;
  const ref = cfg.authRef;
  if (ref === null || ref === undefined) return null;
  if (ref.type === "env") {
    // Phase-1 interim: bearer token from a server-env var. No vault.
    const token = process.env[ref.envVar];
    if (token === undefined || token === "") {
      throw new McpEnvTokenMissingError(cfg.name, ref.envVar);
    }
    return { bearerToken: token, headers: { Authorization: `Bearer ${token}` } };
  }
  // Vault-backed bearer/oauth — Phase 4.
  throw new McpAuthNotAvailableError(cfg.name, ref);
}

/**
 * Resolve env-passthrough variable VALUES from `process.env` at call time.
 * Returns a fresh record each call — values are never cached on the config.
 *
 * Missing vars are skipped silently: a server that declares a passthrough
 * var the host doesn't have gets an env without that var, matching the
 * MCP SDK's own `getDefaultEnvironment()` behavior for missing inherited
 * vars. Callers that need to surface "you asked for FOO but it's unset"
 * should compare `cfg.envPassthrough` against the returned keys.
 *
 * This is split from {@link resolveMcpAuth} because env passthrough is NOT
 * auth — it's the spawn env for the child process. Keeping them separate
 * preserves the "single place credentials are resolved" property: only
 * `resolveMcpAuth` may yield bearer tokens / auth headers.
 */
export function resolveEnvPassthrough(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const names = cfg.envPassthrough ?? [];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    // Skip shell function exports (security risk, matches SDK behavior).
    if (value.startsWith("()")) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Report whether every declared passthrough variable will be present in the
 * exact child environment, without returning any value. This intentionally
 * shares {@link buildSpawnEnv}'s merge semantics so a preflight cannot claim
 * a variable is missing when the configured local spawn baseline supplies it.
 */
export function inspectEnvPassthrough(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  spawnEnvBase?: Record<string, string>,
): readonly McpEnvironmentPresence[] {
  const childEnv = buildSpawnEnv(cfg, env, spawnEnvBase);
  const names = [...new Set(cfg.envPassthrough ?? [])];
  return names.map((name) => ({
    name,
    present: typeof childEnv[name] === "string" && childEnv[name] !== "",
  }));
}

/**
 * Build the full child-process env for an MCP stdio spawn. Merge order
 * (later wins):
 *
 *   1. SDK `getDefaultEnvironment()` — safe-inheritance baseline
 *      (HOME/PATH/SHELL/TERM/USER/LOGNAME only).
 *   2. `spawnEnvBase` — an OPTIONAL richer host-provided baseline. The SDK
 *      safe-list drops toolchain vars like JAVA_HOME / ANDROID_HOME even when
 *      the parent has them, which breaks toolchain-dependent MCP servers
 *      (e.g. maestro needs a JVM). LOCAL-tier hosts (desktop / headless
 *      relay) pass the user's real environment here — Claude Desktop/Cursor
 *      parity, on the user's own machine. Server-tier managers pass nothing,
 *      keeping the strict explicit-passthrough posture.
 *   3. Config `envPassthrough` — explicitly declared var VALUES.
 *   4. Config `envLiteral` — non-secret literals.
 *
 * Exported for the stdio transport; not part of the auth seam per se,
 * but lives here so the "values never stored on config" invariant has
 * one obvious construction site.
 */
export function buildSpawnEnv(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  spawnEnvBase?: Record<string, string>  ,
): Record<string, string> {
  const base = getDefaultEnvironment();
  const passthrough = resolveEnvPassthrough(cfg, env);
  const literal = cfg.envLiteral ?? {};
  return { ...base, ...(spawnEnvBase ?? {}), ...passthrough, ...literal };
}
