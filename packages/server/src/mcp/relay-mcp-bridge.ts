/**
 * Relay-tier MCP bridge (D384 Phase 5, Layer 2).
 *
 * The server side of relay-hosted MCP:
 *   - {@link buildRelayMcpConfigs} reads the enabled `mcp_servers` rows a relay
 *     should host (`host = 'relay-<relayId>'`) and maps them to the wire config
 *     sent via `relay:configure-mcp`. **Secrets never cross the wire** — only
 *     env-var NAMES, transport, scope, and filters.
 *   - {@link registerRelayAdvertisedTools} takes the tools a relay advertised
 *     (`relay:advertise-mcp-tools`) and registers them in the ToolCatalog with
 *     `executor:"relay"` + `hostedBy:<relayId>` + the config's `namespaceId`
 *     (C6 visibility). Grouped under a **relay-scoped `sourceServer`**
 *     (`<relayId>:<serverName>`) so refresh/unregister isolate per relay —
 *     two relays with same-named servers never clobber each other's *group*.
 *     A live catalogue owner also blocks same-tool-name replacement, including
 *     attempts to shadow built-ins or another relay-hosted MCP.
 *   - {@link unregisterRelayServer} / {@link relayScopedSource} support cleanup
 *     when a relay disconnects.
 */
import type { ToolCatalog, ToolRegistration } from "@nautilo/catalog";
import { and, eq, mcpServers, type DirectDatabase } from "@nautilo/db";
import { log, warn } from "@nautilo/logger";
import {
  buildRelayToolRegistration,
  type McpDiscoveredTool,
} from "@nautilo/mcp-client";
import type { RelayAdvertisedMcpTool, RelayMcpServerConfig } from "@nautilo/relay";
import type { ToolTrustTier } from "@nautilo/types";

const RELAY_HOST_PREFIX = "relay-";

/** The `mcp_servers.host` value for a relay-hosted config. */
export function relayHostId(relayId: string): string {
  return `${RELAY_HOST_PREFIX}${relayId}`;
}

/** Relay-scoped catalog grouping key — isolates refresh/unregister per relay. */
export function relayScopedSource(relayId: string, serverName: string): string {
  return `${relayId}:${serverName}`;
}

/**
 * Read the enabled relay-tier configs a relay should host and map them to the
 * secret-free wire shape. Returns `[]` (never throws) on a DB error so a relay
 * register is never blocked by MCP config.
 */
export async function buildRelayMcpConfigs(
  db: DirectDatabase,
  relayId: string,
): Promise<RelayMcpServerConfig[]> {
  let rows: (typeof mcpServers.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.host, relayHostId(relayId)), eq(mcpServers.enabled, true)));
  } catch (e) {
    warn(
      `[mcp] buildRelayMcpConfigs(${relayId}): DB read failed (${e instanceof Error ? e.message : String(e)}); no relay MCP configs.`,
    );
    return [];
  }
  return rows.map((r) => ({
    name: r.name,
    transportKind: r.transportKind as RelayMcpServerConfig["transportKind"],
    transport: r.transport as Record<string, unknown>,
    envPassthrough: r.envPassthrough ?? null,
    namespaceId: r.namespaceId ?? null,
    includeTools: r.includeTools ?? null,
    excludeTools: r.excludeTools ?? null,
    trustTier: r.trustTier ?? null,
  }));
}

/**
 * Register a relay's advertised tools into the catalog. Looks up the config
 * row for `namespaceId` + `trustTier` (scope + trust are server-owned, not
 * relay-asserted). Idempotent via `catalog.refresh` on the relay-scoped source.
 * Returns the number of tools registered.
 */
export async function registerRelayAdvertisedTools(opts: {
  db: DirectDatabase;
  catalog: ToolCatalog;
  relayId: string;
  serverName: string;
  tools: readonly RelayAdvertisedMcpTool[];
}): Promise<number> {
  const { db, catalog, relayId, serverName, tools } = opts;

  let namespaceId: string | null = null;
  let trustTier: ToolTrustTier | null = null;
  try {
    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.host, relayHostId(relayId)), eq(mcpServers.name, serverName)));
    const row = rows[0];
    if (row) {
      namespaceId = row.namespaceId ?? null;
      trustTier = (row.trustTier as ToolTrustTier | null) ?? null;
    }
  } catch (e) {
    warn(
      `[mcp] registerRelayAdvertisedTools: config lookup for "${serverName}" failed (${e instanceof Error ? e.message : String(e)}); registering global/standard.`,
    );
  }

  const scoped = relayScopedSource(relayId, serverName);
  const registrations: ToolRegistration[] = tools.flatMap((t) => {
    const existing = catalog.get(t.name);
    if (existing !== undefined && existing.sourceServer !== scoped) {
      warn(
        `[mcp] relay ${relayId}: refusing hosted tool "${t.name}" from "${serverName}" ` +
          `because that name is already owned by ${existing.sourceServer ?? existing.source}`,
      );
      return [];
    }
    const discovered: McpDiscoveredTool = {
      name: t.name,
      inputSchema:
        (t.inputSchema as McpDiscoveredTool["inputSchema"]) ?? { type: "object" },
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.annotations !== undefined
        ? { annotations: t.annotations as NonNullable<McpDiscoveredTool["annotations"]> }
        : {}),
    };
    const reg = buildRelayToolRegistration(discovered, {
      relayId,
      serverName: scoped,
      trustTier,
    });
    return [{ ...reg, namespaceId } as ToolRegistration];
  });

  catalog.refresh(scoped, registrations);
  log(
    `[mcp] relay ${relayId}: registered ${registrations.length} tool${registrations.length === 1 ? "" : "s"} from "${serverName}" (ns=${namespaceId ?? "global"})`,
  );
  return registrations.length;
}

/** Remove all catalog tools a relay hosted for `serverName` (relay-scoped). */
export function unregisterRelayServer(
  catalog: ToolCatalog,
  relayId: string,
  serverName: string,
): void {
  catalog.unregisterByServer(relayScopedSource(relayId, serverName));
}
