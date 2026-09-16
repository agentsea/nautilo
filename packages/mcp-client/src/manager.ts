/**
 * @nautilo/mcp-client — `McpClientManager` (Phase 0, task 0.3).
 *
 * Owns the lifecycle of every connected MCP server in the host process:
 *
 * - `connect(config)` — resolve auth (fail closed if a vault is required
 *   but not wired), build the transport (stdio today; streamable-http in
 *   Phase 1), run the SDK `Client` initialize handshake, call `tools/list`,
 *   and expose the discovered tools.
 * - `disconnect(id)` — graceful shutdown: close the transport (which
 *   SIGTERM/SIGKILL-ladders the child) and unregister the server's tools
 *   from any attached `ToolCatalog` (Wave 3 wiring calls
 *   `getCatalogBundle` to register them in the first place).
 * - `reconnect(id)` — disconnect + connect.
 * - `startAll` / `stopAll` — for boot/shutdown of the whole fleet.
 * - Per-server state machine: `connecting | connected | disconnected | error`.
 * - Typed event emitter: `mcp:connected | mcp:disconnected | mcp:error |
 *   mcp:tools-changed`.
 * - `dispatch(toolName, args)` — resolve the owning server, then
 *   `tools/call` on that server's client.
 *
 * Dependency injection: `clientFactory` and `transportFactory` are
 * overridable in the constructor so unit tests never spawn a real child
 * process. The defaults use the SDK `Client` and `createStdioTransport`.
 */

import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ToolListChangedNotificationSchema,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import { debug, error, log, warn } from "@nautilo/logger";
import type {
  ToolApprovalLevel,
  ToolCategory,
  ToolImpactLevel,
  ToolResultScanPolicy,
  ToolTrustTier,
} from "@nautilo/types";
import { resolveMcpAuth } from "./resolve-auth.ts";
import {
  createMcpResiliencePolicy,
  type McpResiliencePolicy,
} from "./resilience.ts";
import { createStdioTransport } from "./transports/stdio.ts";
import { createStreamableHttpTransport } from "./transports/streamable-http.ts";
import { redactError } from "./redact.ts";
import { contentToText, mcpToolToLangChain } from "./tool-factory.ts";
import type { McpCallToolClient } from "./tool-factory.ts";
import type {
  McpCatalogBundle,
  McpConnectionState,
  McpDiscoveredTool,
  McpManagerEventMap,
  McpResolvedAuth,
  McpServerConfig,
  McpToolRegistration,
} from "./types.ts";

const DEFAULT_CLIENT_INFO: Implementation = {
  name: "nautilo-mcp-client",
  version: "0.1.0",
};

/**
 * Factory signature for the SDK `Client`. Tests inject a stub that
 * returns a fake client with `connect` / `listTools` / `callTool` /
 * `close`.
 */
export type McpClientFactory = (info: Implementation) => McpManagedClient;

/**
 * The minimal SDK-Client-shaped object the manager drives. The real SDK
 * `Client` satisfies this; tests pass a stub.
 */
export interface McpManagedClient extends McpCallToolClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: ReadonlyArray<McpDiscoveredTool> }>;
  /** RES4 health probe. Optional — stubs/tests may omit it (health check no-ops). */
  ping?(): Promise<void>;
  /**
   * 2.2.1 — subscribe to server-pushed notifications (e.g.
   * `notifications/tools/list_changed`). The real SDK `Client` provides this;
   * stubs/tests may omit it (dynamic reconciliation then no-ops). Typed
   * permissively so the loose zod schema doesn't leak into this seam.
   */
  setNotificationHandler?(
    schema: unknown,
    handler: (notification: unknown) => void,
  ): void;
}

/**
 * Factory signature for the transport wrapper. Receives the config and
 * returns an object with `inner` (the SDK transport to pass to
 * `Client.connect`) and `close()` (graceful shutdown). Tests inject a
 * stub.
 */
export type McpTransportFactory = (
  cfg: McpServerConfig,
) => {
  inner: unknown;
  close(): Promise<void>;
};

export interface McpClientManagerOptions {
  clientFactory?: McpClientFactory;
  transportFactory?: McpTransportFactory;
  /** Override the stderr-log dir for stdio transports (tests). */
  logDir?: string;
  /**
   * Richer env baseline for stdio child spawns (see `buildSpawnEnv`).
   * Local-tier hosts (desktop/headless relay) pass the user's shell env so
   * toolchain vars (PATH, JAVA_HOME, ANDROID_HOME, …) reach MCP children —
   * Claude Desktop/Cursor parity. Server-tier omits this (strict SDK
   * safe-list + explicit passthrough only).
   */
  spawnEnvBase?: Record<string, string>;
  /** Client identity advertised in the MCP initialize handshake. */
  clientInfo?: Implementation;
  /** RES4 health-ping interval (ms) per connected server. 0 disables. Default 0. */
  healthCheckIntervalMs?: number;
  /** RES4 max reconnect attempts before a dead server is left in `error`. Default 12. */
  maxReconnectAttempts?: number;
  /** Injectable sleep for backoff (tests pass an immediate resolver). Default real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable auth resolver. The default is the module-level
   * `resolveMcpAuth` from ./resolve-auth.ts; a relay host can pass a
   * relay-local resolver (e.g. one that reads ~/.nautilo/relay/vault.enc)
   * WITHOUT the manager knowing about vaults. Same contract:
   * `(cfg, scope) => McpResolvedAuth` (may throw McpAuthNotAvailableError).
   */
  authResolver?: (
    cfg: McpServerConfig,
    scope: "spawn" | "headers",
  ) => McpResolvedAuth;
}

/**
 * The observed state of one target after a correlated fleet reconciliation.
 * This is deliberately distinct from the old best-effort `reconcile()` API:
 * callers that need an acknowledgement receive the target's real state or a
 * thrown target failure rather than inferring success from the fleet update.
 */
export interface McpTargetReconcileOutcome {
  readonly state: McpConnectionState | undefined;
  readonly tools: readonly McpDiscoveredTool[];
}

interface ManagedServer {
  config: McpServerConfig;
  state: McpConnectionState;
  client: McpManagedClient | null;
  transport: { close(): Promise<void> } | null;
  tools: readonly McpDiscoveredTool[];
  lastError: Error | null;
  /** Shared per-server resilience policy (breaker state shared across calls). */
  policy: McpResiliencePolicy;
  /** RES4 health-check interval handle (null when disabled/stopped). */
  healthTimer: ReturnType<typeof setInterval> | null;
}

/**
 * RES4 — exponential backoff schedule for reconnect attempts:
 * `min(baseMs * 2^attempt, capMs)`. Default 1s → 2s → 4s … capped at 60s.
 */
export function computeBackoffDelay(
  attempt: number,
  baseMs = 1000,
  capMs = 60_000,
): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

/**
 * Map an MCP tool's `annotations` (readOnlyHint / destructiveHint /
 * idempotentHint) to a Nautilo `ToolImpactLevel`. Default for unknown
 * tools is `"high"` — fail safe, never under-rate an external tool.
 */
function deriveImpact(tool: McpDiscoveredTool): ToolImpactLevel {
  const a = tool.annotations;
  if (!a) return "high";
  if (a.destructiveHint === true) return "destructive";
  if (a.readOnlyHint === true) return "read-only";
  if (a.idempotentHint === true) return "low";
  return "high";
}

function impactRequiresApproval(impact: ToolImpactLevel): boolean {
  return impact === "high" || impact === "destructive";
}

/**
 * RES3 — detect a stale MCP session. Streamable-HTTP transports invalidate
 * their session id when the server restarts; the next call fails with
 * "Server not initialized" (or a session error). stdio pipes fail differently
 * (EPIPE / process exit), which the reconnect supervisor handles separately.
 */
function isStaleSessionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /server not initialized|session (?:not found|expired|invalid|id)/i.test(
    msg,
  );
}

function impactApprovalLevel(
  impact: ToolImpactLevel,
): ToolApprovalLevel | undefined {
  if (impact === "destructive") return "prove_it";
  if (impact === "high") return "confirm";
  return undefined;
}

/**
 * D384 Phase 5 — build a catalog registration for a **relay-hosted** MCP tool
 * (advertised by a relay via `relay:advertise-mcp-tools`). Mirrors the
 * per-tool block of {@link McpClientManager.getCatalogBundle} — same impact
 * derivation, same trust/scan defaults — but stamps `executor:"relay"` +
 * `hostedBy:<relayId>` so the agent's tools node routes the call to the owning
 * relay (NOT a local `manager.dispatch`). The factory's body is never invoked
 * for a relay tool (the relay-dispatch path intercepts by executor); it exists
 * only to give the LLM a schema/description, and throws defensively if ever
 * called locally.
 */
export function buildRelayToolRegistration(
  tool: McpDiscoveredTool,
  opts: { relayId: string; serverName: string; trustTier?: ToolTrustTier | null },
): McpToolRegistration {
  const impact = deriveImpact(tool);
  return {
    name: tool.name,
    factory: () =>
      mcpToolToLangChain(tool, () => {
        throw new Error(
          `[mcp] relay-hosted tool "${tool.name}" must be dispatched via its relay, not invoked locally.`,
        );
      }),
    source: "mcp",
    exposure: "discoverable",
    executor: "relay",
    hostedBy: opts.relayId,
    sourceServer: opts.serverName,
    category: "meta" as ToolCategory,
    trustTier: opts.trustTier ?? "standard",
    impact,
    tags: ["mcp", "relay"],
    requiresApproval: impactRequiresApproval(impact),
    approvalLevel: impactApprovalLevel(impact),
    resultScanPolicy: "on-suspicious" as ToolResultScanPolicy,
    mcpToolName: tool.name,
  };
}

/**
 * Apply include/exclude tool filters from the server config. Returns the
 * tools that survive the filter, in the order they were declared.
 */
function applyToolFilter(
  cfg: McpServerConfig,
  tools: readonly McpDiscoveredTool[],
): readonly McpDiscoveredTool[] {
  const include = cfg.includeTools ? new Set(cfg.includeTools) : null;
  const exclude = cfg.excludeTools ? new Set(cfg.excludeTools) : null;
  return tools.filter((t) => {
    if (exclude && exclude.has(t.name)) return false;
    if (include && !include.has(t.name)) return false;
    return true;
  });
}

/**
 * The default transport factory: stdio today, streamable-http stub for
 * Phase 1. Throws on unknown transport kinds.
 */
function defaultTransportFactory(
  cfg: McpServerConfig,
  logDir?: string,
  spawnEnvBase?: Record<string, string>,
): { inner: unknown; close(): Promise<void> } {
  if (cfg.transportKind === "stdio") {
    const t = createStdioTransport(cfg, {
      ...(logDir ? { logDir } : {}),
      ...(spawnEnvBase ? { spawnEnvBase } : {}),
    });
    return { inner: t.inner, close: () => t.close() };
  }
  if (cfg.transportKind === "streamable-http" || cfg.transportKind === "sse-legacy") {
    const t = createStreamableHttpTransport(cfg);
    return { inner: t.inner, close: () => t.close() };
  }
  throw new Error(
    `[mcp] Unknown transportKind "${String(cfg.transportKind)}" for server "${cfg.name}".`,
  );
}

/**
 * McpClientManager — the MCP host's per-server lifecycle owner.
 *
 * Events (typed via {@link McpManagerEventMap}):
 * - `mcp:connected`    (serverName)
 * - `mcp:disconnected` (serverName, reason?)
 * - `mcp:error`        (serverName, error)
 * - `mcp:tools-changed`(serverName, tools)
 */
export class McpClientManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly emitter = new EventEmitter();
  private readonly clientFactory: McpClientFactory;
  private readonly transportFactory: McpTransportFactory;
  private readonly clientInfo: Implementation;
  private readonly healthCheckIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * Auth resolution seam — the ONLY place credentials are resolved.
   * Defaults to `resolveMcpAuth` from ./resolve-auth.ts; injectable via
   * {@link McpClientManagerOptions.authResolver} so a relay host can
   * supply a relay-local resolver without the manager knowing about
   * vaults.
   */
  private readonly authResolver: (
    cfg: McpServerConfig,
    scope: "spawn" | "headers",
  ) => McpResolvedAuth;
  /** Servers currently in a backoff-reconnect loop (guards re-entry). */
  private readonly reconnecting = new Set<string>();
  /**
   * C5 (2.2.2) — session-scoped server tags: `serverName → sessionId`.
   * Kept OFF the `ManagedServer` entry on purpose so the tag survives a
   * reconnect / list_changed cycle (which recreate the entry). Cleared by
   * {@link removeServer} and {@link stopSession}.
   */
  private readonly sessionServers = new Map<string, string>();

  constructor(options: McpClientManagerOptions = {}) {
    this.emitter.setMaxListeners(100);
    this.clientFactory =
      options.clientFactory ??
      ((info: Implementation) => new Client(info) as unknown as McpManagedClient);
    this.transportFactory =
      options.transportFactory ??
      ((cfg: McpServerConfig) =>
        defaultTransportFactory(cfg, options.logDir, options.spawnEnvBase));
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 12;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.authResolver = options.authResolver ?? resolveMcpAuth;
  }

  // ---------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------

  on<K extends keyof McpManagerEventMap>(
    event: K,
    handler: (...args: McpManagerEventMap[K]) => void,
  ): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof McpManagerEventMap>(
    event: K,
    handler: (...args: McpManagerEventMap[K]) => void,
  ): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  private emit<K extends keyof McpManagerEventMap>(
    event: K,
    ...args: McpManagerEventMap[K]
  ): void {
    this.emitter.emit(event, ...(args as unknown[]));
  }

  // ---------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------

  hasServer(name: string): boolean {
    return this.servers.has(name);
  }

  getState(name: string): McpConnectionState | undefined {
    return this.servers.get(name)?.state;
  }

  getTools(name: string): readonly McpDiscoveredTool[] {
    return this.servers.get(name)?.tools ?? [];
  }

  /** Safe for structured relay diagnostics; never returns a raw Error object. */
  getSafeLastError(name: string): string | null {
    const error = this.servers.get(name)?.lastError;
    return error ? redactError(error) : null;
  }

  listServers(): readonly string[] {
    return [...this.servers.keys()];
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  /**
   * Connect to an MCP server. Resolves auth, builds the transport, runs
   * the initialize handshake, lists tools, and records state. Emits
   * `mcp:connected` (then `mcp:tools-changed`) on success, `mcp:error`
   * on failure (and rethrows).
   */
  /**
   * Connect to an MCP server. Resolves auth, builds the transport, runs
   * the initialize handshake, lists tools, and records state. Emits
   * `mcp:connected` (then `mcp:tools-changed`) on success, `mcp:error`
   * on failure (and rethrows).
   *
   * Re-connecting a server currently in the `disconnected` or `error`
   * state is allowed and overwrites the prior entry. A server in the
   * `connecting` or `connected` state must be disconnected first.
   */
  async connect(cfg: McpServerConfig): Promise<readonly McpDiscoveredTool[]> {
    const existing = this.servers.get(cfg.name);
    if (existing && (existing.state === "connecting" || existing.state === "connected")) {
      throw new Error(
        `[mcp] Server "${cfg.name}" is already connected (state=${existing.state}). Call disconnect() first.`,
      );
    }
    if (cfg.enabled === false) {
      throw new Error(
        `[mcp] Server "${cfg.name}" is disabled in config; refusing to connect.`,
      );
    }

    // Auth seam — the ONLY place credentials are resolved. Throws
    // McpAuthNotAvailableError if a vault is required but not wired.
    // The resolver is injectable via McpClientManagerOptions.authResolver
    // (defaults to resolveMcpAuth) so a relay host can supply a relay-local
    // resolver without the manager knowing about vaults.
    this.authResolver(cfg, "spawn");

    const entry: ManagedServer = {
      config: cfg,
      state: "connecting",
      client: null,
      transport: null,
      tools: [],
      lastError: null,
      policy: createMcpResiliencePolicy(cfg.name),
      healthTimer: null,
    };
    this.servers.set(cfg.name, entry);

    try {
      const transport = this.transportFactory(cfg);
      entry.transport = transport;

      const client = this.clientFactory(this.clientInfo);
      entry.client = client;
      await client.connect(transport.inner);

      const listResult = await client.listTools();
      const filtered = applyToolFilter(cfg, listResult.tools);
      entry.tools = filtered;
      entry.state = "connected";

      // 2.2.1 — reconcile on server-pushed `notifications/tools/list_changed`.
      // The handler re-lists, re-applies the include/exclude filter, and
      // re-emits `mcp:tools-changed` so the catalog hot-updates without a
      // reconnect or restart. No-op when the client seam lacks the method
      // (test stubs). The handler always targets the CURRENT entry, so it
      // survives a reconnect that swaps the client.
      client.setNotificationHandler?.(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(cfg.name);
      });

      log(
        `[mcp] Connected "${cfg.name}" (${filtered.length} tool${filtered.length === 1 ? "" : "s"}).`,
      );
      this.emit("mcp:connected", cfg.name);
      this.emit("mcp:tools-changed", cfg.name, filtered);
      this.startHealthCheck(cfg.name);
      return filtered;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      entry.state = "error";
      entry.lastError = e;
      warn(`[mcp] Connect failed for "${cfg.name}": ${redactError(e)}`);
      // Best-effort cleanup before rethrowing.
      await this.cleanupServer(cfg.name);
      this.emit("mcp:error", cfg.name, e);
      throw e;
    }
  }

  /**
   * Disconnect a single server: close the client + transport (graceful
   * shutdown ladder), drop tools, set state=`disconnected`, and emit
   * `mcp:disconnected` (then `mcp:tools-changed` with an empty tool list
   * so subscribers clear their per-server tool views). The entry is
   * retained so `getState()` continues to report `disconnected` until
   * the operator reconnects.
   */
  async disconnect(name: string, reason?: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) {
      debug(`[mcp] disconnect("${name}"): not managed, no-op.`);
      return;
    }
    await this.cleanupServer(name);
    entry.state = "disconnected";
    log(`[mcp] Disconnected "${name}"${reason ? ` (${reason})` : ""}.`);
    this.emit("mcp:disconnected", name, reason);
    this.emit("mcp:tools-changed", name, []);
  }

  /**
   * Reconnect: disconnect (forgetting tools) then connect again with
   * the same config. Useful for `tools/list_changed`-style refreshes
   * that the SDK's auto-listChanged handler doesn't cover, or for
   * operator-initiated restarts.
   */
  async reconnect(name: string): Promise<readonly McpDiscoveredTool[]> {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new Error(`[mcp] reconnect("${name}"): server not managed.`);
    }
    const cfg = entry.config;
    await this.disconnect(name, "reconnect");
    return this.connect(cfg);
  }

  /**
   * R2 (2.2.3) — apply a possibly-changed config to a managed-or-new
   * server WITHOUT a process restart (hot-reload). Semantics:
   * - currently connected/connecting → disconnect, then reconnect with the
   *   NEW config (picks up transport/auth/filter changes);
   * - `enabled: false` → ensure the server is down and stays down (no
   *   reconnect), tools cleared via the disconnect above;
   * - not yet managed and enabled → connect fresh.
   * Idempotent and safe to call repeatedly (see {@link reconcile}).
   */
  async updateServer(cfg: McpServerConfig): Promise<void> {
    const existing = this.servers.get(cfg.name);
    const isUp =
      existing &&
      (existing.state === "connected" || existing.state === "connecting");
    if (isUp) await this.disconnect(cfg.name, "config-reload");
    if (cfg.enabled === false) {
      log(`[mcp] updateServer("${cfg.name}"): disabled — left down.`);
      return;
    }
    await this.connect(cfg);
  }

  /**
   * R2 (2.2.3) — fully tear down a server and forget it (unlike
   * {@link disconnect}, which retains the entry as `disconnected`). After
   * this, `getState(name)` returns `undefined`. Used when a config row is
   * DELETED. Emits `mcp:tools-changed` (empty) via disconnect so the
   * catalog unregisters the server's tools.
   */
  async removeServer(name: string): Promise<void> {
    if (!this.servers.has(name)) return;
    await this.disconnect(name, "removed");
    this.servers.delete(name);
    this.sessionServers.delete(name);
    log(`[mcp] removeServer("${name}"): forgotten.`);
  }

  // ---------------------------------------------------------------
  // C5 (2.2.2) — session-scoped registration
  // ---------------------------------------------------------------

  /**
   * C5 (2.2.2) — register ephemeral, session-scoped MCP servers (e.g. ones
   * a user attaches for a single working session, NOT persisted in
   * `mcp_servers`). Connects each via {@link updateServer} and tags it with
   * `sessionId` so {@link stopSession} can tear down exactly this session's
   * servers, leaving boot/persistent servers untouched. Best-effort: one
   * server's connect failure is logged and does not abort the rest.
   */
  async registerSessionServers(
    sessionId: string,
    configs: readonly McpServerConfig[],
  ): Promise<void> {
    for (const cfg of configs) {
      try {
        await this.updateServer(cfg);
        this.sessionServers.set(cfg.name, sessionId);
      } catch (e) {
        warn(
          `[mcp] registerSessionServers("${sessionId}"): "${cfg.name}" failed: ${redactError(e)}`,
        );
      }
    }
  }

  /** C5 (2.2.2) — the server names currently tagged to `sessionId`. */
  listSessionServers(sessionId: string): readonly string[] {
    return [...this.sessionServers.entries()]
      .filter(([, s]) => s === sessionId)
      .map(([name]) => name);
  }

  /**
   * C5 (2.2.2) — tear down every server tagged to `sessionId` (session end).
   * Persistent/boot servers (untagged, or tagged to another session) are
   * left running.
   */
  async stopSession(sessionId: string): Promise<void> {
    const names = this.listSessionServers(sessionId);
    for (const name of names) {
      await this.removeServer(name);
    }
    log(`[mcp] stopSession("${sessionId}"): removed ${names.length} server(s).`);
  }

  /**
   * R2 (2.2.3) — reconcile the live fleet against a desired config set
   * (e.g. re-read from `mcp_servers` after a mutation): update/connect
   * every desired server and remove any managed server no longer desired.
   * Best-effort — a single server's failure is logged and does not abort
   * the rest of the reconcile.
   */
  async reconcile(desired: readonly McpServerConfig[]): Promise<void> {
    const desiredNames = new Set(desired.map((c) => c.name));
    for (const name of [...this.servers.keys()]) {
      if (!desiredNames.has(name)) {
        try {
          await this.removeServer(name);
        } catch (e) {
          warn(`[mcp] reconcile: removeServer("${name}") failed: ${redactError(e)}`);
        }
      }
    }
    for (const cfg of desired) {
      try {
        await this.updateServer(cfg);
      } catch (e) {
        warn(`[mcp] reconcile: updateServer("${cfg.name}") failed: ${redactError(e)}`);
      }
    }
  }

  /**
   * Reconcile the same full desired fleet as {@link reconcile}, but make one
   * target authoritative. Non-target entries retain the legacy best-effort
   * behavior. A failure to start or stop the target rejects so the relay can
   * return an exact correlated outcome instead of a false acknowledgement.
   */
  async reconcileTarget(
    desired: readonly McpServerConfig[],
    targetName: string,
  ): Promise<McpTargetReconcileOutcome> {
    const desiredNames = new Set(desired.map((cfg) => cfg.name));
    for (const name of [...this.servers.keys()]) {
      if (desiredNames.has(name)) continue;
      if (name === targetName) {
        await this.removeServer(name);
        continue;
      }
      try {
        await this.removeServer(name);
      } catch (error) {
        warn(`[mcp] reconcileTarget: removeServer("${name}") failed: ${redactError(error)}`);
      }
    }
    for (const cfg of desired) {
      if (cfg.name === targetName) {
        await this.updateServer(cfg);
        continue;
      }
      try {
        await this.updateServer(cfg);
      } catch (error) {
        warn(`[mcp] reconcileTarget: updateServer("${cfg.name}") failed: ${redactError(error)}`);
      }
    }
    return {
      state: this.getState(targetName),
      tools: this.getTools(targetName),
    };
  }

  /**
   * 2.2.1 — re-list a connected server's tools and re-emit
   * `mcp:tools-changed`. Invoked by the `notifications/tools/list_changed`
   * handler registered in {@link connect}. Never throws: a failed re-list
   * leaves the last-known tool set in place and logs (graceful degradation,
   * RES2 spirit — a flaky list_changed must not tear down a working server).
   */
  private async refreshTools(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || entry.state !== "connected" || !entry.client) return;
    try {
      const listResult = await entry.client.listTools();
      const filtered = applyToolFilter(entry.config, listResult.tools);
      entry.tools = filtered;
      log(
        `[mcp] "${name}" tools/list_changed → ${filtered.length} tool${filtered.length === 1 ? "" : "s"}.`,
      );
      this.emit("mcp:tools-changed", name, filtered);
    } catch (e) {
      warn(`[mcp] refreshTools("${name}") failed: ${redactError(e)}`);
    }
  }

  // ---------------------------------------------------------------
  // RES4 — health supervisor + backoff reconnect
  // ---------------------------------------------------------------

  /**
   * Start a periodic health-ping for a connected server (no-op when
   * `healthCheckIntervalMs <= 0`). A failed ping means a zombie
   * (connected-but-dead) transport → trigger a backoff reconnect.
   */
  private startHealthCheck(name: string): void {
    if (this.healthCheckIntervalMs <= 0) return;
    const entry = this.servers.get(name);
    if (!entry) return;
    this.stopHealthCheck(entry);
    entry.healthTimer = setInterval(() => {
      void this.healthTick(name);
    }, this.healthCheckIntervalMs);
    // Do not keep the process alive solely for health pings.
    (entry.healthTimer as { unref?: () => void }).unref?.();
  }

  private stopHealthCheck(entry: ManagedServer): void {
    if (entry.healthTimer !== null) {
      clearInterval(entry.healthTimer);
      entry.healthTimer = null;
    }
  }

  /** One health probe: ping the server; on failure, kick off a reconnect. */
  private async healthTick(name: string): Promise<void> {
    if (this.reconnecting.has(name)) return;
    const entry = this.servers.get(name);
    if (!entry || entry.state !== "connected" || !entry.client) return;
    const ping = entry.client.ping?.bind(entry.client);
    if (!ping) return; // server can't be health-probed; skip
    try {
      await ping();
    } catch (e) {
      warn(
        `[mcp] health ping failed for "${name}" (${redactError(e)}); connection looks dead — reconnecting.`,
      );
      await this.reconnectWithBackoff(name);
    }
  }

  /**
   * Reconnect a server with exponential backoff (1s → 60s cap, up to
   * `maxReconnectAttempts`). On success the health check restarts (via
   * `connect`); on exhaustion the server is left in `error` state.
   * Idempotent per server via the `reconnecting` guard.
   */
  async reconnectWithBackoff(name: string): Promise<void> {
    if (this.reconnecting.has(name)) return;
    if (!this.servers.has(name)) return;
    this.reconnecting.add(name);
    try {
      for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
        try {
          await this.reconnect(name);
          log(`[mcp] reconnected "${name}" after ${attempt + 1} attempt(s).`);
          return;
        } catch (e) {
          const delay = computeBackoffDelay(attempt);
          warn(
            `[mcp] reconnect ${attempt + 1}/${this.maxReconnectAttempts} for "${name}" failed (${redactError(e)}); retrying in ${delay}ms.`,
          );
          await this.sleep(delay);
        }
      }
      const cur = this.servers.get(name);
      if (cur) {
        cur.state = "error";
        cur.lastError = new Error(
          `reconnect exhausted after ${this.maxReconnectAttempts} attempts`,
        );
      }
      error(
        `[mcp] giving up reconnect for "${name}" after ${this.maxReconnectAttempts} attempts.`,
      );
    } finally {
      this.reconnecting.delete(name);
    }
  }

  /**
   * Connect every config in order. Returns a map of serverName →
   * `{ ok, tools?, error? }`. A failure for one server does NOT abort
   * the rest — partial fleets are a real operating mode.
   */
  async startAll(
    configs: readonly McpServerConfig[],
  ): Promise<Record<string, { ok: true; tools: readonly McpDiscoveredTool[] } | { ok: false; error: string }>> {
    const out: Record<
      string,
      { ok: true; tools: readonly McpDiscoveredTool[] } | { ok: false; error: string }
    > = {};
    for (const cfg of configs) {
      if (cfg.enabled === false) {
        out[cfg.name] = { ok: false, error: "disabled in config" };
        continue;
      }
      try {
        const tools = await this.connect(cfg);
        out[cfg.name] = { ok: true, tools };
      } catch (e) {
        out[cfg.name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return out;
  }

  /**
   * Disconnect every managed server. Best-effort: each disconnect is
   * awaited in turn and failures are logged but do not abort the loop.
   */
  async stopAll(): Promise<void> {
    // RES6 — LIFO teardown: disconnect newest-first so later servers that may
    // depend on earlier ones are torn down before their dependencies.
    const names = [...this.servers.keys()].reverse();
    for (const name of names) {
      try {
        await this.disconnect(name, "stopAll");
      } catch (e) {
        error(
          `[mcp] stopAll: error disconnecting "${name}": ${redactError(e)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // Tool dispatch
  // ---------------------------------------------------------------

  /**
   * Resolve which server owns `toolName` and call it. Throws if no
   * connected server exposes that tool. Returns the concatenated text
   * content of the MCP `callTool` result.
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const owning = this.findOwningServer(toolName);
    if (!owning) {
      throw new Error(`[mcp] dispatch: no connected server exposes tool "${toolName}".`);
    }
    const { entry } = owning;
    if (entry.state !== "connected" || !entry.client) {
      throw new Error(
        `[mcp] dispatch: server "${entry.config.name}" for tool "${toolName}" is in state ${entry.state}, not connected.`,
      );
    }
    debug(`[mcp] dispatch: tool "${toolName}" → server "${entry.config.name}"`);
    try {
      return await this.callViaPolicy(entry, toolName, args);
    } catch (e) {
      // RES3 — stale session (e.g. a Streamable-HTTP server restart):
      // reconnect once and retry the call on the fresh session.
      if (isStaleSessionError(e)) {
        warn(
          `[mcp] stale session on "${entry.config.name}"; reconnecting and retrying "${toolName}".`,
        );
        await this.reconnect(entry.config.name);
        const fresh = this.servers.get(entry.config.name);
        if (
          fresh &&
          fresh.state === "connected" &&
          fresh.client &&
          fresh.tools.some((t) => t.name === toolName)
        ) {
          return await this.callViaPolicy(fresh, toolName, args);
        }
      }
      throw e;
    }
  }

  /**
   * Run a single `tools/call` through the server's shared resilience policy
   * and coerce the result to text. Throws on transport failure (surfaced to
   * RES3) or an MCP `isError` result.
   */
  private async callViaPolicy(
    entry: ManagedServer,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const client = entry.client;
    if (!client) {
      throw new Error(
        `[mcp] callViaPolicy: server "${entry.config.name}" has no client.`,
      );
    }
    const result = await entry.policy.execute(() =>
      client.callTool({ name: toolName, arguments: args }),
    );
    if (result.isError) {
      throw new Error(
        `[mcp] Tool "${toolName}" on server "${entry.config.name}" returned an error: ${contentToText(result.content)}`,
      );
    }
    return contentToText(result.content);
  }

  private findOwningServer(
    toolName: string,
  ): { entry: ManagedServer; tool: McpDiscoveredTool } | null {
    for (const entry of this.servers.values()) {
      const tool = entry.tools.find((t) => t.name === toolName);
      if (tool) return { entry, tool };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Catalog integration
  // ---------------------------------------------------------------

  /**
   * Produce a {@link McpCatalogBundle} for the given server: one
   * `McpToolRegistration` per discovered tool (after include/exclude
   * filtering), each carrying a `factory` that builds a fresh LangChain
   * `StructuredTool` from the raw MCP `inputSchema` (per the C4 decision:
   * no Zod, no Ajv). Wave 3 server wiring iterates `registrations` and
   * calls `ToolCatalog.register(reg)` for each.
   *
   * Throws if the server is not connected.
   */
  getCatalogBundle(serverName: string): McpCatalogBundle {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(
        `[mcp] getCatalogBundle: server "${serverName}" is not managed.`,
      );
    }
    if (entry.state !== "connected" || !entry.client) {
      throw new Error(
        `[mcp] getCatalogBundle: server "${serverName}" is in state ${entry.state}, not connected.`,
      );
    }
    const cfg = entry.config;
    const trustTier: ToolTrustTier = cfg.trustTier ?? "standard";
    const registrations: McpToolRegistration[] = entry.tools.map((tool) => {
      const impact = deriveImpact(tool);
      const requiresApproval = impactRequiresApproval(impact);
      const approvalLevel = impactApprovalLevel(impact);
      const reg: McpToolRegistration = {
        name: tool.name,
        // Factory relays through dispatch → shared resilience policy + RES3
        // reconnect, and always targets the CURRENT client (survives reconnect).
        factory: () => mcpToolToLangChain(tool, (n, a) => this.dispatch(n, a)),
        source: "mcp",
        exposure: "discoverable",
        executor: "cloud",
        sourceServer: cfg.name,
        category: "meta" as ToolCategory,
        trustTier,
        impact,
        tags: ["mcp"],
        requiresApproval,
        approvalLevel,
        resultScanPolicy: "on-suspicious" as ToolResultScanPolicy,
        mcpToolName: tool.name,
      };
      return reg;
    });
    return {
      serverName: cfg.name,
      namespaceId: cfg.namespaceId ?? null,
      registrations,
    };
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  private async cleanupServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    this.stopHealthCheck(entry);
    const client = entry.client;
    const transport = entry.transport;
    entry.client = null;
    entry.transport = null;
    entry.tools = [];
    try {
      if (client) await client.close();
    } catch (e) {
      warn(
        `[mcp] cleanup("${name}"): client.close failed: ${redactError(e)}`,
      );
    }
    try {
      if (transport) await transport.close();
    } catch (e) {
      warn(
        `[mcp] cleanup("${name}"): transport.close failed: ${redactError(e)}`,
      );
    }
  }
}
