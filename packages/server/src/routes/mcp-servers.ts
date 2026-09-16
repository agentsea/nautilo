/**
 * D384 Phase 3 §3.0 (SEC7) + §3.1 + Phase 5 task 3.4.1 — MCP Connections API.
 *
 * Surface (NO PIN required):
 *
 *   GET    /api/mcp-servers           — list visible rows (verified user);
 *                                        enriched with `health` + `toolCount`
 *   GET    /api/mcp-servers/relays    — the requesting user's currently-
 *                                        connected relay ids (verified user);
 *                                        D384 §5.5.1 relay-id source
 *   GET    /api/mcp-servers/:name       — single row (verified user); 404 if
 *                                        missing or not visible
 *   GET    /api/mcp-servers/:name/tools — discovered tools + enabled flags
 *                                        (verified user)
 *   POST   /api/mcp-servers           — create (`enabled:false`,
 *                                        tier decided by handler:
 *                                          · server tier — `host="server"`
 *                                            forced, `manage_server_security`
 *                                            only (SEC7); or
 *                                          · local tier — `host="relay-<id>"`
 *                                            honored when the requester OWNS
 *                                            that connected relay; verified-
 *                                            user gate only; D384 §5.5.2);
 *                                        409 on duplicate name)
 *   PUT    /api/mcp-servers/:name     — update config fields; 404 if missing;
 *                                        server-tier = admin; local-tier = owner
 *   PATCH  /api/mcp-servers/:name/enabled
 *                                    — body `{ enabled: boolean }`;
 *                                       tier-scoped mutation gate
 *   PATCH  /api/mcp-servers/:name/tools/:tool
 *                                    — body `{ enabled: boolean }`; toggles
 *                                       `excludeTools`; tier-scoped
 *   DELETE /api/mcp-servers/:name     — delete; tier-scoped
 *
 * Each successful mutation:
 *   1. writes an `mcp_server_config` audit row,
 *   2. best-effort hot-reloads the live `McpClientManager` via
 *      `getMcpClientManager().reconcile(...)` — a reconcile failure
 *      is logged and does NOT roll back the DB write.
 *
 * Denials (401 unauth / 403 missing-cap) reuse the existing
 * `capability_check_failed` audit kind. The route takes injected deps
 * (`getCapabilities`, `auditEvent`, optional `db`) so tests can
 * exercise the full surface without a real Postgres — mirroring how
 * `securityRoutes` is tested.
 *
 * SECURITY INVARIANTS:
 * - `host` is decided by the POST handler, NEVER trusted from the
 *   body. Two tiers, two gates:
 *     • Server tier (`host="server"`) — forced when `host` is absent,
 *       `"server"`, or a `relay-<id>` the requester does NOT own / is
 *       not connected. Requires `manage_server_security` (SEC7).
 *     • Local tier (`host="relay-<id>"`) — honored ONLY when the
 *       requester owns that connected relay
 *       (`registry.getUserId(relayId) === sessionUserId` AND the relay
 *       is currently connected). Allowed for any verified user; SEC7
 *       is bypassed. The boundary is the ownership check.
 *   A caller CANNOT create a `host="server"` row without the cap, nor
 *   a `relay-<id>` row they don't own. Fail closed (403 + audit).
 * - `enabled` is ALWAYS `false` on create; the PATCH-enabled route is
 *   the only way to flip it.
 * - Only the allow-listed columns are persisted. `envLiteral`,
 *   `authRef`, and `spawnSandboxProfile` are silently dropped — this
 *   API never stores secret values or relay-tier sandbox config.
 * - The `name` uniqueness check is application-level (SELECT-by-name
 *   before insert) because the table has no unique constraint on
 *   `name`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, mcpServers, type DirectDatabase } from "@nautilo/db";
import type { McpServer, NewMcpServer } from "@nautilo/db";
import { getRelayRegistry } from "@nautilo/agent";
import {
  RELAY_MCP_TRUTH_PROTOCOL_VERSION,
  type RelayMcpFailure,
  type RelayMcpPreflightResultMessage,
  type RelayMcpServerConfig,
} from "@nautilo/relay";
import { randomUUID } from "node:crypto";
import { warn } from "@nautilo/logger";
import { CAP_MANAGE_SERVER_SECURITY } from "@nautilo/trust";
import type { SecurityAuditEvent } from "../lib/security-audit-log";
import { getServerDirectDb } from "../lib/server-direct-db";
import { dbRowToMcpServerConfig } from "../mcp/mcp-host";
import { getMcpClientManager } from "../mcp/mcp-manager-singleton";
import {
  healthForRow,
  isLocalTierHost,
  listConnectedRelaysForUser,
  localTierOwnerUserId,
  parseRelayIdFromHost,
  toolCountForRow,
  toolsForRow,
  type McpServerHealth,
} from "../mcp/connection-status";
// D384 §5.4 — the local-tier create logic lives in the shared service so
// the `manage_local_mcp` agent tool and this route behave identically.
import { createLocalMcpServer } from "../mcp/local-mcp-service";
import { mutateLocalMcpRelayDurably } from "../mcp/local-mcp-mutation";
import { buildMcpInsertRow } from "../mcp/local-mcp-persistence";
import { relayHostId } from "../mcp/relay-mcp-bridge";

const ALLOWED_TRANSPORT_KINDS = [
  "stdio",
  "streamable-http",
  "sse-legacy",
] as const;
type TransportKind = (typeof ALLOWED_TRANSPORT_KINDS)[number];

const TRANSPORT_KIND_SET: ReadonlySet<string> = new Set(ALLOWED_TRANSPORT_KINDS);

/**
 * Audit dependency — same shape as `SecurityAuditor` in routes/security.ts.
 * May throw; the route wraps every call in `safeAudit` so a thrown
 * auditor cannot surface as a 500 to the caller (PR-017 MINOR #6
 * invariant, mirrored here).
 */
export type McpServersAuditor = (event: SecurityAuditEvent) => Promise<void>;

export interface McpServersRouteDeps {
  /** Caller Capability lookup — production wires `getUserCapabilities`. */
  readonly getCapabilities: (userId: string) => Promise<readonly string[]>;
  /** Audit writer closure — production wraps `writeSecurityAuditEvent`. */
  readonly auditEvent: McpServersAuditor;
  /** DB handle; defaults to the process-wide direct pool. */
  readonly db?: DirectDatabase;
  /** Injectable clock for deterministic audit timestamps in tests. */
  readonly now?: () => Date;
}

type CapCheckResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

/** Public row shape — secrets never cross the wire. */
interface PublicMcpServer {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly transportKind: McpServer["transportKind"];
  readonly transport: McpServer["transport"];
  readonly envPassthrough: McpServer["envPassthrough"];
  readonly namespaceId: McpServer["namespaceId"];
  readonly includeTools: McpServer["includeTools"];
  readonly excludeTools: McpServer["excludeTools"];
  readonly enabled: boolean;
  readonly trustTier: McpServer["trustTier"];
  readonly createdAt: McpServer["createdAt"];
  readonly updatedAt: McpServer["updatedAt"];
  readonly health: McpServerHealth;
  readonly toolCount: number;
  readonly lastCheckStatus: McpServer["lastCheckStatus"];
  readonly lastCheckFailureCode: McpServer["lastCheckFailureCode"];
  readonly lastCheckMissingEnvironment: McpServer["lastCheckMissingEnvironment"];
  readonly lastCheckedAt: McpServer["lastCheckedAt"];
  readonly lastConnectedAt: McpServer["lastConnectedAt"];
}

interface CreateBody {
  readonly name: string;
  readonly transportKind: TransportKind;
  readonly transport: Record<string, unknown>;
  readonly envPassthrough?: readonly string[] | null;
  readonly namespaceId?: string | null;
  readonly includeTools?: readonly string[] | null;
  readonly excludeTools?: readonly string[] | null;
  readonly trustTier?: string | null;
  /**
   * D384 §5.5.2 — optional caller-requested `host`. Parsed WITHOUT
   * trust; the POST handler decides the tier + gate. A `relay-<id>`
   * string is honored ONLY when the requester owns that connected
   * relay (owner-gated local create); anything else collapses to the
   * server-tier path (host forced to `"server"`, SEC7 admin gate).
   */
  readonly host?: string;
}

interface UpdateBody {
  transportKind?: TransportKind;
  transport?: Record<string, unknown>;
  envPassthrough?: readonly string[] | null;
  namespaceId?: string | null;
  includeTools?: readonly string[] | null;
  excludeTools?: readonly string[] | null;
  trustTier?: string | null;
}

class McpRevisionConflictError extends Error {
  constructor() { super("mcp_revision_conflict"); }
}

function expectedRevision(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)["expectedRevision"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Wrap an audit call so a thrown auditor cannot bubble up into the
 * route handler. Mirrors the `safeAudit` helper in routes/security.ts
 * — the PR-017 MINOR #6 invariant: a forensic-row write failure must
 * never convert a 4xx into a 500.
 */
async function safeAudit(
  auditor: McpServersAuditor,
  event: SecurityAuditEvent,
): Promise<void> {
  try {
    await auditor(event);
  } catch (err) {
    warn(
      `[mcp-servers] auditor threw on ${event.kind} — ` +
        `forensic row missing but response proceeds: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseCreateBody(raw: unknown):
  | { readonly ok: true; readonly body: CreateBody }
  | { readonly ok: false; readonly error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid body" };
  }
  const r = raw as Record<string, unknown>;

  const name = r["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "name must be a non-empty string" };
  }

  const transportKind = r["transportKind"];
  if (
    typeof transportKind !== "string" ||
    !TRANSPORT_KIND_SET.has(transportKind)
  ) {
    return {
      ok: false,
      error: "transportKind must be one of stdio | streamable-http | sse-legacy",
    };
  }

  const transport = r["transport"];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    return { ok: false, error: "transport must be an object" };
  }

  const envPassthrough = r["envPassthrough"];
  if (envPassthrough !== undefined && envPassthrough !== null) {
    if (!isStringArray(envPassthrough)) {
      return { ok: false, error: "envPassthrough must be an array of strings" };
    }
  }

  const namespaceId = r["namespaceId"];
  if (
    namespaceId !== undefined &&
    namespaceId !== null &&
    typeof namespaceId !== "string"
  ) {
    return { ok: false, error: "namespaceId must be a string or null" };
  }

  const includeTools = r["includeTools"];
  if (includeTools !== undefined && includeTools !== null) {
    if (!isStringArray(includeTools)) {
      return { ok: false, error: "includeTools must be an array of strings" };
    }
  }

  const excludeTools = r["excludeTools"];
  if (excludeTools !== undefined && excludeTools !== null) {
    if (!isStringArray(excludeTools)) {
      return { ok: false, error: "excludeTools must be an array of strings" };
    }
  }

  const trustTier = r["trustTier"];
  if (
    trustTier !== undefined &&
    trustTier !== null &&
    typeof trustTier !== "string"
  ) {
    return { ok: false, error: "trustTier must be a string or null" };
  }

  // D384 §5.5.2 — optional `host`. Parsed WITHOUT trust; the POST
  // handler decides whether to honor it (owner-gated local create) or
  // collapse to the server-tier path (forced to "server"). A non-string
  // `host` is rejected to keep the downstream tier decision type-safe.
  const host = r["host"];
  if (host !== undefined && host !== null && typeof host !== "string") {
    return { ok: false, error: "host must be a string or null" };
  }

  // Silently drop disallowed fields (envLiteral, authRef,
  // spawnSandboxProfile, enabled). `enabled` is forced to false at
  // insert time; `host` is decided by the handler.
  return {
    ok: true,
    body: {
      name,
      transportKind: transportKind as TransportKind,
      transport: transport as Record<string, unknown>,
      ...(envPassthrough !== undefined ? { envPassthrough } : {}),
      ...(namespaceId !== undefined ? { namespaceId } : {}),
      ...(includeTools !== undefined ? { includeTools } : {}),
      ...(excludeTools !== undefined ? { excludeTools } : {}),
      ...(trustTier !== undefined ? { trustTier } : {}),
      ...(host !== undefined && host !== null ? { host } : {}),
    },
  };
}

function parseUpdateBody(raw: unknown):
  | { readonly ok: true; readonly body: UpdateBody }
  | { readonly ok: false; readonly error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid body" };
  }
  const r = raw as Record<string, unknown>;
  const out: UpdateBody = {};

  if ("transportKind" in r) {
    const v = r["transportKind"];
    if (typeof v !== "string" || !TRANSPORT_KIND_SET.has(v)) {
      return {
        ok: false,
        error:
          "transportKind must be one of stdio | streamable-http | sse-legacy",
      };
    }
    out.transportKind = v as TransportKind;
  }

  if ("transport" in r) {
    const v = r["transport"];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "transport must be an object" };
    }
    out.transport = v as Record<string, unknown>;
  }

  if ("envPassthrough" in r) {
    const v = r["envPassthrough"];
    if (v !== null && !isStringArray(v)) {
      return { ok: false, error: "envPassthrough must be an array of strings" };
    }
    out.envPassthrough = v;
  }

  if ("namespaceId" in r) {
    const v = r["namespaceId"];
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "namespaceId must be a string or null" };
    }
    out.namespaceId = v;
  }

  if ("includeTools" in r) {
    const v = r["includeTools"];
    if (v !== null && !isStringArray(v)) {
      return { ok: false, error: "includeTools must be an array of strings" };
    }
    out.includeTools = v;
  }

  if ("excludeTools" in r) {
    const v = r["excludeTools"];
    if (v !== null && !isStringArray(v)) {
      return { ok: false, error: "excludeTools must be an array of strings" };
    }
    out.excludeTools = v;
  }

  if ("trustTier" in r) {
    const v = r["trustTier"];
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "trustTier must be a string or null" };
    }
    out.trustTier = v;
  }

  if (Object.keys(out).length === 0) {
    return { ok: false, error: "no recognized fields to update" };
  }
  return { ok: true, body: out };
}

function toPublicRow(row: McpServer, health: McpServerHealth): PublicMcpServer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    transportKind: row.transportKind,
    transport: row.transport,
    envPassthrough: row.envPassthrough,
    namespaceId: row.namespaceId,
    includeTools: row.includeTools,
    excludeTools: row.excludeTools,
    enabled: row.enabled,
    trustTier: row.trustTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health,
    toolCount: toolCountForRow(row),
    lastCheckStatus: row.lastCheckStatus,
    lastCheckFailureCode: row.lastCheckFailureCode,
    lastCheckMissingEnvironment: row.lastCheckMissingEnvironment,
    lastCheckedAt: row.lastCheckedAt,
    lastConnectedAt: row.lastConnectedAt,
  };
}

async function enrichRow(row: McpServer): Promise<PublicMcpServer> {
  const health = await healthForRow(row);
  return toPublicRow(row, health);
}

function rowVisibleToUser(
  row: McpServer,
  userId: string,
  canViewOfficial: boolean,
): boolean {
  if (row.host === "server") return canViewOfficial;
  if (isLocalTierHost(row.host)) {
    return localTierOwnerUserId(row.host) === userId;
  }
  return false;
}

function toggleExcludeTool(
  current: readonly string[] | null,
  toolName: string,
  enabled: boolean,
): string[] {
  const set = new Set(current ?? []);
  if (enabled) set.delete(toolName);
  else set.add(toolName);
  return [...set];
}

type LocalMcpCheckStatus = "connected" | "ready" | "needs_attention" | "failed";

interface RelayMcpCheckRegistry {
  getUserId?(relayId: string): string | null;
  getDesktopSessionId?(relayId: string): string | null;
  getProtocolVersion?(relayId: string): number;
  preflightMcp?(relayId: string, request: {
    requestId: string;
    digest: string;
    expectedDesktopSessionId: string;
    server: RelayMcpServerConfig;
    timeoutMs: number;
  }): Promise<RelayMcpPreflightResultMessage>;
}

const SAFE_RELAY_FAILURE_CODES = new Set<RelayMcpFailure["code"]>([
  "invalid_request",
  "missing_launcher",
  "missing_environment",
  "spawn_failed",
  "protocol_failed",
  "discovery_timeout",
  "empty_toolset",
  "internal",
]);

function relayConfigForCheck(row: McpServer): RelayMcpServerConfig {
  return {
    name: row.name,
    transportKind: row.transportKind as RelayMcpServerConfig["transportKind"],
    transport: row.transport as Record<string, unknown>,
    envPassthrough: row.envPassthrough ?? null,
    namespaceId: row.namespaceId ?? null,
    includeTools: row.includeTools ?? null,
    excludeTools: row.excludeTools ?? null,
    trustTier: row.trustTier ?? null,
  };
}

async function checkLocalMcpPrerequisites(
  row: McpServer,
  userId: string,
): Promise<{
  status: LocalMcpCheckStatus;
  failureCode: string | null;
  missingEnvironment: string[];
}> {
  const relayId = parseRelayIdFromHost(row.host);
  const registry = getRelayRegistry() as RelayMcpCheckRegistry | null;
  if (!relayId || !registry || registry.getUserId?.(relayId) !== userId) {
    return { status: "failed", failureCode: "relay_unavailable", missingEnvironment: [] };
  }
  const desktopSessionId = registry.getDesktopSessionId?.(relayId);
  if (!desktopSessionId) {
    return { status: "failed", failureCode: "relay_unavailable", missingEnvironment: [] };
  }
  if ((registry.getProtocolVersion?.(relayId) ?? 0) < RELAY_MCP_TRUTH_PROTOCOL_VERSION ||
    typeof registry.preflightMcp !== "function") {
    return { status: "failed", failureCode: "relay_protocol_unsupported", missingEnvironment: [] };
  }
  let result: RelayMcpPreflightResultMessage;
  try {
    const correlation = randomUUID();
    result = await registry.preflightMcp(relayId, {
      requestId: correlation,
      digest: correlation,
      expectedDesktopSessionId: desktopSessionId,
      server: relayConfigForCheck(row),
      timeoutMs: 20_000,
    });
  } catch {
    return { status: "failed", failureCode: "relay_unavailable", missingEnvironment: [] };
  }
  const missingEnvironment = result.environment
    .filter((entry) => !entry.present)
    .map((entry) => entry.name);
  if (missingEnvironment.length > 0) {
    return { status: "needs_attention", failureCode: "missing_environment", missingEnvironment };
  }
  if (result.status !== "ready") {
    const code = result.failure?.code;
    const failureCode = code && SAFE_RELAY_FAILURE_CODES.has(code) ? code : "internal";
    return {
      status: failureCode === "missing_launcher" || failureCode === "missing_environment"
        ? "needs_attention"
        : "failed",
      failureCode,
      missingEnvironment,
    };
  }
  return {
    status: await healthForRow(row) === "connected" ? "connected" : "ready",
    failureCode: null,
    missingEnvironment: [],
  };
}

// D384 §5.4 — the insert-row builder was extracted to `mcp/local-mcp-service.ts`
// (`buildMcpInsertRow`) so the route and the `manage_local_mcp` agent tool
// share one secret-free, `enabled=false`-forcing builder.

function toUpdateSet(
  body: UpdateBody,
): Partial<NewMcpServer> & { readonly updatedAt: Date } {
  const set: Partial<NewMcpServer> = {};
  if (body.transportKind !== undefined) set.transportKind = body.transportKind;
  if (body.transport !== undefined) set.transport = body.transport;
  if (body.envPassthrough !== undefined) {
    set.envPassthrough =
      body.envPassthrough === null ? null : [...body.envPassthrough];
  }
  if (body.namespaceId !== undefined) set.namespaceId = body.namespaceId;
  if (body.includeTools !== undefined) {
    set.includeTools =
      body.includeTools === null ? null : [...body.includeTools];
  }
  if (body.excludeTools !== undefined) {
    set.excludeTools =
      body.excludeTools === null ? null : [...body.excludeTools];
  }
  if (body.trustTier !== undefined) set.trustTier = body.trustTier;
  // Drizzle's `set` expects a Date for timestamp columns.
  return { ...set, updatedAt: new Date() } as Partial<NewMcpServer> & {
    readonly updatedAt: Date;
  };
}

/**
 * Best-effort hot-reload of the live `McpClientManager` after a
 * successful DB write. Re-reads enabled server-tier rows and asks
 * the manager to reconcile. Failures are logged and do NOT roll back
 * the DB write — the config is the source of truth, the live fleet
 * will catch up on the next boot if this call fails.
 */
async function reconcileLiveFleet(db: DirectDatabase): Promise<void> {
  const mgr = getMcpClientManager();
  if (!mgr) return;
  let rows: McpServer[];
  try {
    rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true));
  } catch (e) {
    warn(
      `[mcp-servers] reconcile: failed to re-read mcp_servers: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  const configs = rows
    .filter((r) => r.host === "server")
    .map(dbRowToMcpServerConfig);
  try {
    await mgr.reconcile(configs);
  } catch (e) {
    warn(
      `[mcp-servers] reconcile: manager.reconcile failed: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function mcpServersRoutes(
  app: FastifyInstance,
  deps: McpServersRouteDeps,
): void {
  const { getCapabilities, auditEvent } = deps;
  const db = deps.db ?? getServerDirectDb();
  const now = deps.now ?? ((): Date => new Date());

  function checkVerifiedUser(request: FastifyRequest): CapCheckResult {
    const userId = request.sessionUserId;
    if (!userId) {
      return { ok: false, status: 401, body: { error: "Authentication required" } };
    }
    return { ok: true, userId };
  }

  async function checkServerSecurityCap(
    request: FastifyRequest,
    attemptedRoute: string,
  ): Promise<CapCheckResult> {
    const userId = request.sessionUserId;
    if (!userId) {
      return { ok: false, status: 401, body: { error: "Authentication required" } };
    }
    const caps = await getCapabilities(userId);
    if (!caps.includes(CAP_MANAGE_SERVER_SECURITY)) {
      await safeAudit(auditEvent, {
        kind: "capability_check_failed",
        ts: now().toISOString(),
        actorId: request.sessionActorId ?? userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        capability: CAP_MANAGE_SERVER_SECURITY,
        attemptedRoute,
      });
      return {
        ok: false,
        status: 403,
        body: {
          error: "capability_missing",
          capability: CAP_MANAGE_SERVER_SECURITY,
        },
      };
    }
    return { ok: true, userId };
  }

  async function checkMutationAccess(
    request: FastifyRequest,
    row: McpServer,
    attemptedRoute: string,
  ): Promise<CapCheckResult> {
    if (isLocalTierHost(row.host)) {
      const gate = checkVerifiedUser(request);
      if (!gate.ok) return gate;
      const ownerId = localTierOwnerUserId(row.host);
      if (ownerId !== gate.userId) {
        return {
          ok: false,
          status: 403,
          body: { error: "forbidden", message: "not the owner of this local connection" },
        };
      }
      return gate;
    }
    return checkServerSecurityCap(request, attemptedRoute);
  }

  async function rowsByName(name: string): Promise<McpServer[]> {
    return db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name));
  }

  function requestedHost(request: FastifyRequest): string | undefined {
    const query = request.query as Record<string, unknown> | undefined;
    const host = typeof query?.["host"] === "string" ? query["host"] : undefined;
    const relayId = typeof query?.["relayId"] === "string" ? query["relayId"] : undefined;
    if (host && relayId) return "__invalid__";
    return host ?? (relayId ? relayHostId(relayId) : undefined);
  }

  function ambiguousBody(name: string): object {
    return { error: "ambiguous_mcp_server", name };
  }

  async function resolveVisibleRow(
    request: FastifyRequest,
    name: string,
    userId: string,
  ): Promise<{ row?: McpServer; ambiguous?: true }> {
    const host = requestedHost(request);
    const caps = await getCapabilities(userId);
    const canViewOfficial = caps.includes(CAP_MANAGE_SERVER_SECURITY);
    const visible = (await rowsByName(name)).filter((row) =>
      rowVisibleToUser(row, userId, canViewOfficial));
    const candidates = host ? visible.filter((row) => row.host === host) : visible;
    return candidates.length === 1
      ? { row: candidates[0]! }
      : candidates.length > 1 || host === "__invalid__" ? { ambiguous: true } : {};
  }

  async function resolveMutableRow(
    request: FastifyRequest,
    name: string,
  ): Promise<{ row?: McpServer; ambiguous?: true }> {
    const userId = request.sessionUserId;
    if (!userId) return {};
    const host = requestedHost(request);
    const caps = await getCapabilities(userId);
    const accessible = (await rowsByName(name)).filter((row) =>
      row.host === "server"
        ? caps.includes(CAP_MANAGE_SERVER_SECURITY)
        : localTierOwnerUserId(row.host) === userId,
    );
    const candidates = host ? accessible.filter((row) => row.host === host) : accessible;
    return candidates.length === 1
      ? { row: candidates[0]! }
      : candidates.length > 1 || host === "__invalid__" ? { ambiguous: true } : {};
  }

  /**
   * Mutate exactly the already-authorized host/name row. Relay-tier updates
   * hold the same relay-wide Postgres advisory lock as the installer through
   * their complete fleet reconciliation; otherwise two requests could each
   * send a complete but stale fleet and silently stop one another's MCP.
   */
  async function mutateExactRow(
    existing: McpServer,
    revision: string | null,
    mutate: (mutationDb: DirectDatabase, current: McpServer) => Promise<McpServer | undefined>,
  ): Promise<McpServer | undefined> {
    const relayId = parseRelayIdFromHost(existing.host);
    const apply = async (mutationDb: DirectDatabase): Promise<McpServer | undefined> => {
      const exact = await mutationDb.select().from(mcpServers)
        .where(and(eq(mcpServers.name, existing.name), eq(mcpServers.host, existing.host)));
      if (exact.length > 1) throw new Error("ambiguous exact MCP row");
      if (exact.length === 0) return undefined;
      if (revision !== null && exact[0]!.updatedAt.toISOString() !== revision) {
        throw new McpRevisionConflictError();
      }
      return mutate(mutationDb, exact[0]!);
    };
    if (relayId) {
      const durable = await mutateLocalMcpRelayDurably({
        db,
        relayId,
        targetName: existing.name,
        mutate: apply,
        shouldReconcile: (row) => row !== undefined,
      });
      return durable.value;
    }
    const row = await apply(db);
    if (row) await reconcileLiveFleet(db);
    return row;
  }

  /**
   * Fail-closed 404 for a MUTATION on a missing row. We can't know the tier
   * of a row that doesn't exist, so we require the server-security cap (the
   * safe default) BEFORE revealing 404 — this keeps SEC7's "deny before you
   * learn it exists" guarantee: a non-admin gets 403 (+ audit), never a 404
   * that leaks whether the name is taken. Returns a sent reply.
   */
  async function denyOrNotFound(
    request: FastifyRequest,
    reply: import("fastify").FastifyReply,
    name: string,
    attemptedRoute: string,
  ) {
    const gate = await checkServerSecurityCap(request, attemptedRoute);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    return reply.status(404).send({ error: "not_found", name });
  }

  // -----------------------------------------------------------------------
  // GET /api/mcp-servers — personal local rows plus admin-only official rows
  // -----------------------------------------------------------------------
  app.get("/api/mcp-servers", async (request, reply) => {
    const gate = checkVerifiedUser(request);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const caps = await getCapabilities(gate.userId);
    const canViewOfficial = caps.includes(CAP_MANAGE_SERVER_SECURITY);
    const rows = await db.select().from(mcpServers);
    const visible = rows.filter((r) =>
      rowVisibleToUser(r, gate.userId, canViewOfficial));
    const servers = await Promise.all(visible.map((r) => enrichRow(r)));
    return reply.send({ servers });
  });

  // -----------------------------------------------------------------------
  // GET /api/mcp-servers/relays — D384 §5.5.1 relay-id source for the
  // Connections editor. Registered BEFORE the `/api/mcp-servers/:name`
  // param route so "relays" is not captured as `:name`. Returns the
  // requesting user's currently-connected relay ids from the live
  // relay registry. Verified-user gated; empty when the user owns no
  // connected relay.
  // -----------------------------------------------------------------------
  app.get("/api/mcp-servers/relays", async (request, reply) => {
    const gate = checkVerifiedUser(request);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const relayIds = await listConnectedRelaysForUser(gate.userId);
    return reply.send({
      relays: relayIds.map((relayId) => ({ relayId })),
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/mcp-servers/:name — single row (verified user)
  // -----------------------------------------------------------------------
  app.get<{
    Params: { name: string };
  }>("/api/mcp-servers/:name", async (request, reply) => {
    const gate = checkVerifiedUser(request);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { name } = request.params;
    const resolved = await resolveVisibleRow(request, name, gate.userId);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const row = resolved.row;
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }
    return reply.send({ server: await enrichRow(row) });
  });

  // -----------------------------------------------------------------------
  // GET /api/mcp-servers/:name/tools — catalog tools + enabled flags
  // -----------------------------------------------------------------------
  app.get<{
    Params: { name: string };
  }>("/api/mcp-servers/:name/tools", async (request, reply) => {
    const gate = checkVerifiedUser(request);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { name } = request.params;
    const resolved = await resolveVisibleRow(request, name, gate.userId);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const row = resolved.row;
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }
    return reply.send({ tools: toolsForRow(row) });
  });

  // -----------------------------------------------------------------------
  // POST /api/mcp-servers/:name/check — owner-only, read-only relay
  // prerequisite check for an existing local MCP. The only durable mutation
  // is fixed, secret-free status evidence on the existing row.
  // -----------------------------------------------------------------------
  app.post<{
    Params: { name: string };
  }>("/api/mcp-servers/:name/check", async (request, reply) => {
    const gate = checkVerifiedUser(request);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { name } = request.params;
    const resolved = await resolveVisibleRow(request, name, gate.userId);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const row = resolved.row;
    if (!row || !isLocalTierHost(row.host)) {
      return reply.status(404).send({ error: "not_found", name });
    }
    const access = await checkMutationAccess(request, row, "POST /api/mcp-servers/:name/check");
    if (!access.ok) return reply.status(access.status).send(access.body);

    const check = await checkLocalMcpPrerequisites(row, gate.userId);
    const checkedAt = now();
    const statusSet: Partial<NewMcpServer> = {
      lastCheckStatus: check.status,
      lastCheckFailureCode: check.failureCode,
      lastCheckMissingEnvironment: check.missingEnvironment.length > 0
        ? check.missingEnvironment
        : null,
      lastCheckedAt: checkedAt,
      ...(check.status === "connected" ? { lastConnectedAt: checkedAt } : {}),
    };
    const updated = await db.update(mcpServers)
      .set(statusSet)
      .where(and(eq(mcpServers.id, row.id), eq(mcpServers.host, row.host)))
      .returning();
    if (updated.length !== 1) {
      return reply.status(409).send({ error: "connection_changed", name });
    }
    return reply.send({ server: await enrichRow(updated[0]!), check });
  });

  // -----------------------------------------------------------------------
  // POST /api/mcp-servers — create (tier decided by handler)
  // -----------------------------------------------------------------------
  app.post("/api/mcp-servers", async (request, reply) => {
    const ROUTE = "POST /api/mcp-servers";

    // Always authenticate first — both tiers require a verified user.
    const authGate = checkVerifiedUser(request);
    if (!authGate.ok) return reply.status(authGate.status).send(authGate.body);
    const userId = authGate.userId;

    const parsed = parseCreateBody(request.body);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error });
    const body = parsed.body;

    // D384 §5.5.2 — decide tier from the (untrusted, parsed) `host`.
    // A `relay-<id>` request is the local tier; everything else
    // (absent, "server", malformed) collapses to the server tier.
    const requestedHost = body.host;
    const requestedRelayId =
      typeof requestedHost === "string" ? parseRelayIdFromHost(requestedHost) : null;

    if (requestedRelayId !== null) {
      // Local-tier create — owner-gated. Delegates to the shared
      // `createLocalMcpServer` service (D384 §5.4) so this route and the
      // `manage_local_mcp` agent tool are guaranteed identical. The
      // service checks ownership BEFORE the name-uniqueness probe so a
      // non-owner learns nothing about name availability (mirrors the
      // deny-before-you-leak-it guarantee in `denyOrNotFound`). SEC7 is
      // NOT required; the ownership check IS the boundary. Fail closed.
      const result = await createLocalMcpServer(db, {
        userId,
        relayId: requestedRelayId,
        fields: body,
      });
      if (!result.ok) {
        if (result.reason === "not_owner") {
          await safeAudit(auditEvent, {
            kind: "capability_check_failed",
            ts: now().toISOString(),
            actorId: request.sessionActorId ?? userId,
            ip: request.ip,
            userAgent: request.headers["user-agent"],
            capability: "own_relay",
            attemptedRoute: ROUTE,
          });
          return reply.status(403).send({
            error: "forbidden",
            message: "not the owner of this relay, or relay is not connected",
          });
        }
        if (result.reason === "duplicate") {
          return reply.status(409).send({
            error: "conflict",
            message: `an mcp_server named "${body.name}" already exists`,
          });
        }
        return reply.status(500).send({ error: "insert returned no row" });
      }
      const row = result.row;
      await safeAudit(auditEvent, {
        kind: "mcp_server_config",
        ts: now().toISOString(),
        actorId: request.sessionActorId ?? userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        action: "create",
        serverName: row.name,
        outcome: "ok",
      });
      // Local tier is reconciled by the relay, not the server-tier
      // fleet manager; skip reconcileLiveFleet.
      return reply.status(201).send({ server: await enrichRow(row) });
    }

    // Server-tier create — SEC7 admin gate, host forced to "server".
    // SEC7 fires BEFORE the name-uniqueness probe so a non-admin
    // learns nothing about name availability (the
    // deny-before-you-leak-it guarantee).
    const gate = await checkServerSecurityCap(request, ROUTE);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);

    // Application-level name-uniqueness (no DB unique constraint).
    const existing = await db
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.name, body.name));
    if (existing.length > 0) {
      return reply.status(409).send({
        error: "conflict",
        message: `an mcp_server named "${body.name}" already exists`,
      });
    }

    const inserted = await db
      .insert(mcpServers)
      .values(buildMcpInsertRow(body, "server"))
      .returning();

    const row = inserted[0];
    if (!row) {
      return reply.status(500).send({ error: "insert returned no row" });
    }

    await safeAudit(auditEvent, {
      kind: "mcp_server_config",
      ts: now().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      action: "create",
      serverName: row.name,
      outcome: "ok",
    });

    await reconcileLiveFleet(db);

    return reply.status(201).send({ server: await enrichRow(row) });
  });

  // -----------------------------------------------------------------------
  // PUT /api/mcp-servers/:name — update config fields
  // -----------------------------------------------------------------------
  app.put<{
    Params: { name: string };
  }>("/api/mcp-servers/:name", async (request, reply) => {
    const ROUTE = "PUT /api/mcp-servers/:name";
    const { name } = request.params;
    const resolved = await resolveMutableRow(request, name);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const existing = resolved.row;
    if (!existing) return denyOrNotFound(request, reply, name, ROUTE);
    const gate = await checkMutationAccess(request, existing, ROUTE);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { userId } = gate;

    const parsed = parseUpdateBody(request.body);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error });

    const row = await mutateExactRow(existing, null, async (mutationDb) => {
      const updated = await mutationDb
        .update(mcpServers)
        .set(toUpdateSet(parsed.body))
        .where(and(eq(mcpServers.name, name), eq(mcpServers.host, existing.host)))
        .returning();
      return updated[0];
    });
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }

    await safeAudit(auditEvent, {
      kind: "mcp_server_config",
      ts: now().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      action: "update",
      serverName: row.name,
      outcome: "ok",
    });

    return reply.send({ server: await enrichRow(row) });
  });

  // -----------------------------------------------------------------------
  // PATCH /api/mcp-servers/:name/enabled — enable / disable
  // -----------------------------------------------------------------------
  app.patch<{
    Params: { name: string };
    Body: { enabled?: unknown };
  }>("/api/mcp-servers/:name/enabled", async (request, reply) => {
    const ROUTE = "PATCH /api/mcp-servers/:name/enabled";
    const { name } = request.params;
    const resolved = await resolveMutableRow(request, name);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const existing = resolved.row;
    if (!existing) return denyOrNotFound(request, reply, name, ROUTE);
    const gate = await checkMutationAccess(request, existing, ROUTE);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { userId } = gate;

    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({ error: "invalid body" });
    }
    const enabled = body.enabled;
    if (typeof enabled !== "boolean") {
      return reply.status(400).send({ error: "enabled must be a boolean" });
    }

    const revision = expectedRevision(request.body);
    let row: McpServer | undefined;
    try { row = await mutateExactRow(existing, revision, async (mutationDb, current) => {
      const updated = await mutationDb
        .update(mcpServers)
        .set({
          enabled,
          updatedAt: new Date(Math.max(now().getTime(), current.updatedAt.getTime() + 1)),
        })
        .where(and(eq(mcpServers.name, name), eq(mcpServers.host, existing.host)))
        .returning();
      return updated[0];
    }); } catch (error) {
      if (error instanceof McpRevisionConflictError) return reply.status(409).send({ error: error.message });
      throw error;
    }
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }

    await safeAudit(auditEvent, {
      kind: "mcp_server_config",
      ts: now().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      action: enabled ? "enable" : "disable",
      serverName: row.name,
      outcome: "ok",
    });

    return reply.send({ server: await enrichRow(row) });
  });

  // -----------------------------------------------------------------------
  // PATCH /api/mcp-servers/:name/tools/:tool — per-tool enable toggle
  // -----------------------------------------------------------------------
  app.patch<{
    Params: { name: string; tool: string };
    Body: { enabled?: unknown };
  }>("/api/mcp-servers/:name/tools/:tool", async (request, reply) => {
    const ROUTE = "PATCH /api/mcp-servers/:name/tools/:tool";
    const { name, tool } = request.params;
    const resolved = await resolveMutableRow(request, name);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const existing = resolved.row;
    if (!existing) return denyOrNotFound(request, reply, name, ROUTE);
    const gate = await checkMutationAccess(request, existing, ROUTE);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { userId } = gate;

    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({ error: "invalid body" });
    }
    const enabled = body.enabled;
    if (typeof enabled !== "boolean") {
      return reply.status(400).send({ error: "enabled must be a boolean" });
    }

    const revision = expectedRevision(request.body);
    let row: McpServer | undefined;
    try { row = await mutateExactRow(existing, revision, async (mutationDb, current) => {
      const updated = await mutationDb
        .update(mcpServers)
        .set({
          excludeTools: toggleExcludeTool(current.excludeTools, tool, enabled),
          updatedAt: new Date(Math.max(now().getTime(), current.updatedAt.getTime() + 1)),
        })
        .where(and(eq(mcpServers.name, name), eq(mcpServers.host, existing.host)))
        .returning();
      return updated[0];
    }); } catch (error) {
      if (error instanceof McpRevisionConflictError) return reply.status(409).send({ error: error.message });
      throw error;
    }
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }

    await safeAudit(auditEvent, {
      kind: "mcp_server_config",
      ts: now().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      action: "update",
      serverName: row.name,
      outcome: "ok",
    });

    return reply.send({ server: await enrichRow(row), tools: toolsForRow(row) });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/mcp-servers/:name — delete
  // -----------------------------------------------------------------------
  app.delete<{
    Params: { name: string };
  }>("/api/mcp-servers/:name", async (request, reply) => {
    const ROUTE = "DELETE /api/mcp-servers/:name";
    const { name } = request.params;
    const resolved = await resolveMutableRow(request, name);
    if (resolved.ambiguous) return reply.status(409).send(ambiguousBody(name));
    const existing = resolved.row;
    if (!existing) return denyOrNotFound(request, reply, name, ROUTE);
    const gate = await checkMutationAccess(request, existing, ROUTE);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const { userId } = gate;

    const revision = expectedRevision(request.body);
    let row: McpServer | undefined;
    try { row = await mutateExactRow(existing, revision, async (mutationDb) => {
      const deleted = await mutationDb
        .delete(mcpServers)
        .where(and(eq(mcpServers.name, name), eq(mcpServers.host, existing.host)))
        .returning();
      return deleted[0];
    }); } catch (error) {
      if (error instanceof McpRevisionConflictError) return reply.status(409).send({ error: error.message });
      throw error;
    }
    if (!row) {
      return reply.status(404).send({ error: "not_found", name });
    }

    await safeAudit(auditEvent, {
      kind: "mcp_server_config",
      ts: now().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      action: "delete",
      serverName: row.name,
      outcome: "ok",
    });

    return reply.send({ ok: true, name: row.name });
  });
}
