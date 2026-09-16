/**
 * D384 Phase 5 / task 3.4.1 — live MCP connection health + catalog helpers
 * for the `/api/mcp-servers` Connections API.
 */
import { getToolCatalog } from "@nautilo/catalog";
import type { McpServer } from "@nautilo/db";
import { getRelayRegistry } from "@nautilo/agent";
import type { McpConnectionState } from "@nautilo/mcp-client";
import { getMcpClientManager } from "./mcp-manager-singleton";
import { relayScopedSource } from "./relay-mcp-bridge";

const RELAY_HOST_PREFIX = "relay-";

/** Runtime registry (`InMemoryRelayRegistry`) exposes more than `ToolRelayRegistry`. */
interface RelayRegistryHealthView {
  listConnected?(): Promise<readonly string[]> | readonly string[];
  getUserId?(relayId: string): string | null;
}

function relayHealthRegistry(): RelayRegistryHealthView | null {
  return getRelayRegistry() as RelayRegistryHealthView | null;
}

export type McpServerHealth =
  | "connected"
  | "disconnected"
  | "error"
  | "circuit-open"
  | "unknown";

export interface McpServerToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
}

/** Parse `relay-<relayId>` → relayId; null for server-tier or malformed hosts. */
export function parseRelayIdFromHost(host: string): string | null {
  if (!host.startsWith(RELAY_HOST_PREFIX)) return null;
  const relayId = host.slice(RELAY_HOST_PREFIX.length);
  return relayId.length > 0 ? relayId : null;
}

export function isLocalTierHost(host: string): boolean {
  return host.startsWith(RELAY_HOST_PREFIX);
}

/** Catalog grouping key for a row — `name` (server) or `<relayId>:<name>` (local). */
export function catalogSourceServerForRow(row: McpServer): string {
  const relayId = parseRelayIdFromHost(row.host);
  if (relayId) return relayScopedSource(relayId, row.name);
  return row.name;
}

function catalogEntriesForSource(sourceServer: string) {
  const catalog = getToolCatalog();
  if (!catalog) return [];
  return catalog.query({}).filter((e) => e.sourceServer === sourceServer);
}

export function toolCountForRow(row: McpServer): number {
  return catalogEntriesForSource(catalogSourceServerForRow(row)).length;
}

/**
 * Realistic default wait for a freshly-enabled relay MCP to spawn + advertise
 * its tools. Covers the stdio spawn + `tools/list` round-trip; the slow case
 * is a first-run `npx`/`uvx` install. If a server isn't ready by then it's
 * almost always a genuinely slow install or a bad command — the caller reports
 * that state deterministically and points at `status` for a later re-check.
 */
export const DEFAULT_MCP_TOOLS_WAIT_MS = 20_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D384 Phase 5 — poll the catalog until the row's relay has advertised at
 * least one tool, or the timeout elapses. DETERMINISTIC: returns the ACTUAL
 * post-wait tool count + health so a caller reports facts instead of asking
 * the agent to guess. Exits early the moment a tool appears. Never throws.
 */
export async function waitForRelayMcpTools(
  row: McpServer,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<{ toolCount: number; health: McpServerHealth }> {
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? DEFAULT_MCP_TOOLS_WAIT_MS);
  const pollIntervalMs = Math.max(10, opts?.pollIntervalMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let count = toolCountForRow(row);
  while (count === 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    count = toolCountForRow(row);
  }
  return { toolCount: count, health: await healthForRow(row) };
}

export function toolsForRow(row: McpServer): McpServerToolSummary[] {
  const exclude = new Set(row.excludeTools ?? []);
  return catalogEntriesForSource(catalogSourceServerForRow(row)).map((e) => ({
    name: e.name,
    ...(e.description ? { description: e.description } : {}),
    enabled: !exclude.has(e.name),
  }));
}

function mapManagerState(
  state: McpConnectionState | undefined,
  enabled: boolean,
): McpServerHealth {
  if (!enabled) return "disconnected";
  if (state === undefined) return "unknown";
  switch (state) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "error":
      return "error";
    case "connecting":
      return "unknown";
    default:
      return "unknown";
  }
}

function serverTierHealth(row: McpServer): McpServerHealth {
  if (!row.enabled) return "disconnected";
  const mgr = getMcpClientManager();
  // Defensive: the singleton may be mid-init or a partial stand-in — never
  // let a missing `getState` turn a health read into a 500.
  if (!mgr || typeof mgr.getState !== "function") return "unknown";
  return mapManagerState(mgr.getState(row.name), row.enabled);
}

async function relayTierHealth(row: McpServer): Promise<McpServerHealth> {
  if (!row.enabled) return "disconnected";
  const relayId = parseRelayIdFromHost(row.host);
  if (!relayId) return "unknown";
  const registry = relayHealthRegistry();
  if (!registry?.listConnected) return "disconnected";
  const connected = await registry.listConnected();
  if (!connected.includes(relayId)) return "disconnected";
  const count = toolCountForRow(row);
  return count > 0 ? "connected" : "disconnected";
}

export async function healthForRow(row: McpServer): Promise<McpServerHealth> {
  if (isLocalTierHost(row.host)) return relayTierHealth(row);
  return serverTierHealth(row);
}

/**
 * Resolve the owning user for a local-tier row via the live relay registry.
 * Returns null when the relay is not connected or no registry is installed.
 */
export function localTierOwnerUserId(host: string): string | null {
  const relayId = parseRelayIdFromHost(host);
  if (!relayId) return null;
  return relayHealthRegistry()?.getUserId?.(relayId) ?? null;
}

/**
 * D384 §5.5.1 — list the relay ids currently connected AND owned by the
 * given user. Source: the live relay registry
 * (`relayHealthRegistry().listConnected()` + `getUserId`). Empty when no
 * registry is installed, the user owns no connected relays, or none are
 * connected. Used by `GET /api/mcp-servers/relays` so the UI can offer
 * the Local tier for a relay the signed-in user owns.
 */
export async function listConnectedRelaysForUser(userId: string): Promise<string[]> {
  const registry = relayHealthRegistry();
  if (!registry?.listConnected || !registry.getUserId) return [];
  const connected = await registry.listConnected();
  return connected.filter(
    (relayId) => registry.getUserId!(relayId) === userId,
  );
}
