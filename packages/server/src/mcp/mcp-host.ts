/**
 * MCP host boot wiring (D384 Stack 146, Phase 0 tasks 0.6.1 + 0.7.1).
 *
 * At server boot, this reads enabled `mcp_servers` config rows, connects
 * each via `McpClientManager` (stdio in Phase 0), and registers the
 * discovered tools into the live `ToolCatalog`. The manager's tool
 * factories close over the MCP client, so once registered the agent
 * invokes MCP tools like any other `executor: "cloud"` tool — no special
 * dispatch path.
 *
 * Phase-0 scope boundaries:
 * - Credentials: env-passthrough only; a config with `authRef` fails
 *   closed in `resolveMcpAuth` (vault wiring is Phase 4). A failed server
 *   is logged and skipped — it never blocks boot.
 * - Namespace scoping: tools register globally here. The namespace-aware
 *   catalog visibility filter is Phase 2 (D384 C6); `namespaceId` rides on
 *   the bundle for that later work but is not yet enforced.
 * - Relay-hosted (`host = 'relay-*'`) servers are Phase 5 (D135) and are
 *   skipped here.
 */

import type { ToolCatalog, ToolRegistration } from "@nautilo/catalog";
import { eq, mcpServers, type DirectDatabase } from "@nautilo/db";
import { log, warn } from "@nautilo/logger";
import {
  McpClientManager,
  type McpAuthRef,
  type McpServerConfig,
  type McpTransportConfig,
  type McpTransportKind,
} from "@nautilo/mcp-client";
import type { ToolTrustTier } from "@nautilo/types";
import { getServerDirectDb } from "../lib/server-direct-db";

type McpServerRow = typeof mcpServers.$inferSelect;

/**
 * Map a `mcp_servers` DB row to the transport-neutral `McpServerConfig`
 * the client consumes. `jsonb` columns are typed `unknown` by drizzle, so
 * `transport` / `authRef` / `envLiteral` are cast to their declared shapes.
 */
export function dbRowToMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    name: row.name,
    host: row.host,
    transportKind: row.transportKind as McpTransportKind,
    transport: row.transport as McpTransportConfig,
    envPassthrough: row.envPassthrough ?? null,
    envLiteral: (row.envLiteral as Record<string, string> | null) ?? null,
    authRef: (row.authRef as McpAuthRef | null) ?? null,
    namespaceId: row.namespaceId ?? null,
    includeTools: row.includeTools ?? null,
    excludeTools: row.excludeTools ?? null,
    enabled: row.enabled,
    trustTier: (row.trustTier as ToolTrustTier | null) ?? null,
    spawnSandboxProfile: row.spawnSandboxProfile ?? undefined,
  };
}

export interface StartMcpHostOptions {
  /** Live tool catalog to register discovered MCP tools into. */
  readonly catalog: ToolCatalog;
  /** DB handle for reading `mcp_servers`. Defaults to the direct server pool. */
  readonly db?: DirectDatabase;
  /** Optional lifecycle owner, primarily for embedding and integration tests. */
  readonly manager?: McpClientManager;
}

/**
 * Register one server's discovered tools into the catalog (idempotent via
 * `catalog.refresh`, which reconciles adds/removals for that sourceServer).
 */
function registerServerTools(
  manager: McpClientManager,
  catalog: ToolCatalog,
  serverName: string,
): void {
  const bundle = manager.getCatalogBundle(serverName);
  // McpToolRegistration is a structural superset of ToolRegistration;
  // `mcpToolName` is manager-only metadata the catalog ignores. D384 C6:
  // stamp the server's namespace onto every registration so the catalog's
  // actor-filter can scope MCP tool visibility (null = global).
  const registrations: ToolRegistration[] = bundle.registrations.map(
    (reg) => ({ ...reg, namespaceId: bundle.namespaceId }) as ToolRegistration,
  );
  catalog.refresh(bundle.serverName, registrations);
  log(
    `[mcp] registered ${bundle.registrations.length} tool${bundle.registrations.length === 1 ? "" : "s"} from "${serverName}"`,
  );
}

/**
 * Boot the server-side MCP host. Reads enabled server-tier `mcp_servers`
 * rows, connects each, and registers their tools into `catalog`. Returns
 * the manager so the caller can wire `stopAll()` on shutdown.
 *
 * Never throws for operational failures (missing table, unreachable server,
 * bad config) — MCP is additive and must not block server boot. A returned
 * manager with zero connected servers is a valid state.
 */
export async function startMcpHost(
  options: StartMcpHostOptions,
): Promise<McpClientManager> {
  const { catalog } = options;
  const db = options.db ?? getServerDirectDb();
  // RES4 — a 30s health ping detects zombie connections and drives
  // backoff reconnect (1s→60s cap, 12 attempts) without blocking boot.
  const manager = options.manager ?? new McpClientManager({ healthCheckIntervalMs: 30_000 });

  let rows: McpServerRow[];
  try {
    rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true));
  } catch (e) {
    warn(
      `[mcp] host boot: could not read mcp_servers (${e instanceof Error ? e.message : String(e)}); starting with no MCP tools.`,
    );
    return manager;
  }

  // Phase 0 = server-tier only. Relay-hosted servers (host = 'relay-*')
  // are Phase 5 (D135) and are skipped with a note.
  const serverTier = rows.filter((r) => r.host === "server");
  const relayCount = rows.length - serverTier.length;
  if (relayCount > 0) {
    log(
      `[mcp] host boot: skipping ${relayCount} relay-hosted server(s) — relay tier is D384 Phase 5 (D135).`,
    );
  }
  if (serverTier.length === 0) {
    return manager;
  }

  const configs = serverTier.map(dbRowToMcpServerConfig);
  const results = await manager.startAll(configs);
  for (const [name, result] of Object.entries(results)) {
    if (result.ok) {
      registerServerTools(manager, catalog, name);
    } else {
      warn(`[mcp] server "${name}" failed to connect: ${result.error}`);
    }
  }

  // Reconcile the catalog when a server changes its tool list. A connected
  // server re-registers its (possibly changed) tools; a server that has gone
  // away (disconnect emits tools-changed with an empty list) is unregistered.
  manager.on("mcp:tools-changed", (serverName: string) => {
    try {
      if (manager.getState(serverName) === "connected") {
        registerServerTools(manager, catalog, serverName);
      } else {
        catalog.unregisterByServer(serverName);
      }
    } catch (e) {
      warn(
        `[mcp] tools-changed reconcile failed for "${serverName}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  return manager;
}
