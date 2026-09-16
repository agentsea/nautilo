import { apiClient } from "./api";
import { workbenchFetch } from "./admission-fetch";

export type McpTransportKind = "stdio" | "streamable-http" | "sse-legacy";

/**
 * Live per-server health as reported by GET `/api/mcp-servers` (D384 UI6).
 * Server tier is sourced from `getMcpClientManager().getState`; local tier
 * from the relay's advertised set. Absent on older servers → treat as unknown.
 */
export type McpHealth =
  | "connected"
  | "disconnected"
  | "error"
  | "circuit-open"
  | "unknown";

export type LocalMcpCheckStatus = "connected" | "ready" | "needs_attention" | "failed";

export interface McpTransport {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

/** A single discovered tool for a server (D384 UI7). `enabled` = not in excludeTools. */
export interface McpTool {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * Server-tier MCP connection row as returned by `GET /api/mcp-servers`.
 * Mirrors the DB shape but is declared locally (Skills pattern) so the
 * browser bundle never imports from `@nautilo/db`.
 */
export interface McpServer {
  id: string;
  name: string;
  host: string;
  transportKind: McpTransportKind;
  transport: McpTransport;
  envPassthrough: string[] | null;
  envLiteral: unknown;
  authRef: unknown;
  namespaceId: string | null;
  includeTools: string[] | null;
  excludeTools: string[] | null;
  enabled: boolean;
  trustTier: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live health (UI6). Optional — absent on older servers (degrade to no dot). */
  health?: McpHealth | null;
  /** Live discovered tool count (UI6). Optional — absent on older servers. */
  toolCount?: number | null;
  /** Safe persisted local-MCP recovery evidence. Never contains stderr or secret values. */
  lastCheckStatus?: LocalMcpCheckStatus | null;
  lastCheckFailureCode?: string | null;
  lastCheckMissingEnvironment?: string[] | null;
  lastCheckedAt?: string | null;
  lastConnectedAt?: string | null;
}

/** Config fields accepted by POST (create) and PUT (update). */
export interface McpServerConfig {
  transportKind: McpTransportKind;
  transport: McpTransport;
  envPassthrough?: string[];
  namespaceId?: string | null;
  includeTools?: string[];
  excludeTools?: string[];
  trustTier?: string | null;
  /**
   * Host tier (D384). `"server"` = official (admin-managed, SEC7-gated);
   * `relay-<relayId>` = local (owner self-service). Server forces `"server"`
   * for legacy creates; the local tier sends an explicit `relay-*` host.
   */
  host?: string;
}

export interface McpServerCreateInput extends McpServerConfig {
  name: string;
}

export interface McpServersListResponse {
  servers: McpServer[];
}

function authHeaders(): HeadersInit {
  const token = apiClient.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function exactHostQuery(host: string): string {
  return `?host=${encodeURIComponent(host)}`;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let detail = fallback;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) detail = json.error;
  } catch {
    /* ignore */
  }
  throw new Error(detail);
}

export async function fetchMcpServers(): Promise<McpServer[]> {
  const res = await workbenchFetch("/api/mcp-servers", { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load connections");
  const json = (await res.json()) as McpServersListResponse;
  return json.servers;
}

export async function updateMcpServer(
  name: string,
  config: McpServerConfig,
  host: string,
): Promise<McpServer> {
  const res = await workbenchFetch(`/api/mcp-servers/${encodeURIComponent(name)}${exactHostQuery(host)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!res.ok) await parseError(res, "Failed to save connection");
  const json = (await res.json()) as { server: McpServer };
  return json.server;
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  host: string,
): Promise<McpServer> {
  const res = await workbenchFetch(`/api/mcp-servers/${encodeURIComponent(name)}/enabled${exactHostQuery(host)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await parseError(res, "Failed to update connection");
  const json = (await res.json()) as { server: McpServer };
  return json.server;
}

export async function deleteMcpServer(name: string, host: string): Promise<void> {
  const res = await workbenchFetch(`/api/mcp-servers/${encodeURIComponent(name)}${exactHostQuery(host)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to delete connection");
}

/**
 * List a server's discovered tools (D384 UI7).
 * `GET /api/mcp-servers/:name/tools` → `{ tools: [{name, description, enabled}] }`.
 * Degrades gracefully: returns `null` when the endpoint is absent (404 on an
 * older server) so the UI can hide the drill-down instead of erroring.
 */
export async function fetchMcpServerTools(name: string, host: string): Promise<McpTool[] | null> {
  const res = await workbenchFetch(`/api/mcp-servers/${encodeURIComponent(name)}/tools${exactHostQuery(host)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) await parseError(res, "Failed to load tools");
  const json = (await res.json()) as { tools?: McpTool[] };
  return json.tools ?? [];
}

/** Read-only relay prerequisite check for one existing local MCP. */
export async function checkLocalMcpServer(name: string, host: string): Promise<McpServer> {
  const res = await workbenchFetch(
    `/api/mcp-servers/${encodeURIComponent(name)}/check${exactHostQuery(host)}`,
    { method: "POST", headers: authHeaders() },
  );
  if (!res.ok) await parseError(res, "Failed to check MCP prerequisites");
  const json = (await res.json()) as { server: McpServer };
  return json.server;
}

/**
 * Persist a per-tool enable/disable (D384 UI7) by PUTting the full config with
 * the mutated `excludeTools` list. The caller computes `config` from the server
 * row via the view-model (`serverToConfig` + `computeNextExcludeTools`) so the
 * enable/disable logic stays pure and unit-tested.
 */
export async function setMcpServerToolEnabled(
  name: string,
  toolName: string,
  enabled: boolean,
  host: string,
): Promise<McpServer> {
  const res = await workbenchFetch(
    `/api/mcp-servers/${encodeURIComponent(name)}/tools/${encodeURIComponent(toolName)}${exactHostQuery(host)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) await parseError(res, "Failed to update tool");
  const json = (await res.json()) as { server: McpServer };
  return json.server;
}
