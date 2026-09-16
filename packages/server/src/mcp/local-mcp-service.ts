/**
 * D384 §5.4 — shared local (relay-tier) MCP config service.
 *
 * The single source of truth for local-tier `mcp_servers` mutations. Both
 * the owner-gated `/api/mcp-servers` local-create HTTP branch AND the
 * agent `manage_local_mcp` tool (via {@link createLocalMcpToolRuntime})
 * call these functions so their behavior is identical.
 *
 * SECURITY INVARIANTS:
 * - LOCAL TIER ONLY. Every function refuses server-tier (`host="server"`)
 *   rows: `createLocalMcpServer` only ever writes `host=relay-<id>`;
 *   `setLocalMcpEnabled` rejects a non-`relay-<id>` row; `assertLocalTierOnly`
 *   throws for any non-relay host. There is NO path here that creates,
 *   enables, or edits a `host="server"` row (SEC7 parity for agents).
 * - OWNER-GATED. A local-tier mutation is honored ONLY when the requester
 *   currently owns the connected relay (`listConnectedRelaysForUser`).
 * - `enabled` is ALWAYS `false` on create; enabling is a separate call.
 * - Secrets are never stored: `envLiteral` / `authRef` /
 *   `spawnSandboxProfile` are never set here (`buildMcpInsertRow`).
 */

import { and, eq, mcpServers, type DirectDatabase } from "@nautilo/db";
import type { McpServer } from "@nautilo/db";
import type {
  LocalMcpActionResult,
  LocalMcpServerSummary,
  LocalMcpToolActorContext,
  LocalMcpToolRuntime,
  LocalMcpRegisterInput,
} from "@nautilo/agent";

import type { SecurityAuditEvent } from "../lib/security-audit-log";
import {
  DEFAULT_MCP_TOOLS_WAIT_MS,
  healthForRow,
  listConnectedRelaysForUser,
  parseRelayIdFromHost,
  toolCountForRow,
  waitForRelayMcpTools,
} from "./connection-status";
import { createLocalMcpInstallService } from "./local-mcp-install-service";
import {
  mutateLocalMcpRelayDurably,
  withLocalMcpRelayMutation,
} from "./local-mcp-mutation";
import { buildMcpInsertRow, type McpInsertFields } from "./local-mcp-persistence";


// ---------------------------------------------------------------------------
// Relay-wide mutation coordination
// ---------------------------------------------------------------------------

/**
 * One relay reconciliation replaces its complete MCP fleet. This coordinator
 * therefore serializes every local mutation for that relay. Real Postgres
 * handles take a transaction-scoped advisory lock, which also coordinates
 * concurrent server processes; the tiny in-process queue only avoids needless
 * local connection contention and gives focused database fakes the same order.
 */

// ---------------------------------------------------------------------------
// Insert-row builder (shared by the route's server + local tiers)
// ---------------------------------------------------------------------------

/** Allow-listed, secret-free fields a caller may set on create. */
/**
 * Build the insert row. `host` is decided by the CALLER (the POST handler's
 * tier decision or `relay-<id>` for a local create) — NEVER the raw body.
 * `enabled` is ALWAYS forced false. `envLiteral` / `authRef` /
 * `spawnSandboxProfile` are NEVER set (no secrets, no relay sandbox config).
 */

// ---------------------------------------------------------------------------
// Tier guard
// ---------------------------------------------------------------------------

export class LocalTierViolationError extends Error {
  constructor(public readonly host: string) {
    super(
      `refusing non-local MCP mutation: host="${host}" is not a local (relay-<id>) tier`,
    );
    this.name = "LocalTierViolationError";
  }
}

/** Throw unless `host` is a `relay-<id>` local-tier host. */
export function assertLocalTierOnly(host: string): void {
  if (parseRelayIdFromHost(host) === null) {
    throw new LocalTierViolationError(host);
  }
}

// ---------------------------------------------------------------------------
// createLocalMcpServer — owner-gated local create
// ---------------------------------------------------------------------------

export type CreateLocalMcpResult =
  | { readonly ok: true; readonly row: McpServer }
  | { readonly ok: false; readonly reason: "not_owner" }
  | { readonly ok: false; readonly reason: "duplicate" }
  | { readonly ok: false; readonly reason: "insert_failed" };

/**
 * Create a local-tier `mcp_servers` row for `relayId`, owner-gated. The
 * requester must currently own that connected relay. Application-level
 * name-uniqueness is checked AFTER ownership (so a non-owner learns
 * nothing about name availability). Writes `host=relay-<relayId>`,
 * `enabled=false`. Does NOT write an audit row — the caller (route /
 * runtime) owns that, because the audit envelope is context-specific.
 */
export async function createLocalMcpServer(
  db: DirectDatabase,
  input: { userId: string; relayId: string; fields: McpInsertFields },
): Promise<CreateLocalMcpResult> {
  const host: `relay-${string}` = `relay-${input.relayId}`;
  return withLocalMcpRelayMutation(db, input.relayId, async (tx) => {
    const owned = await listConnectedRelaysForUser(input.userId);
    if (!owned.includes(input.relayId)) {
      return { ok: false, reason: "not_owner" };
    }
    const existing = await tx
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(and(eq(mcpServers.name, input.fields.name), eq(mcpServers.host, host)));
    if (existing.length > 0) {
      return { ok: false, reason: "duplicate" };
    }

    const inserted = await tx
      .insert(mcpServers)
      .values(buildMcpInsertRow(input.fields, host))
      .returning();
    const row = inserted[0];
    if (!row) return { ok: false, reason: "insert_failed" };
    return { ok: true, row };
  });
}

// ---------------------------------------------------------------------------
// setLocalMcpEnabled — owner-gated local enable/disable
// ---------------------------------------------------------------------------

export type SetLocalMcpEnabledResult =
  | {
      readonly ok: true;
      readonly row: McpServer;
      /** True when the config was pushed to a currently-connected relay (so
       *  it's actually starting now); false when the relay is offline (it will
       *  pick the config up on reconnect). Lets the caller decide whether it's
       *  worth waiting for tools to advertise. */
      readonly relayLive: boolean;
    }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "not_local_tier" }
  | { readonly ok: false; readonly reason: "not_owner" }
  | { readonly ok: false; readonly reason: "ambiguous" }
  | { readonly ok: false; readonly reason: "update_failed" };

/**
 * Flip `enabled` on an owned local-tier row. Refuses server-tier rows
 * (`not_local_tier`) and rows on a relay the requester doesn't own
 * (`not_owner`). The live relay reconcile is driven by the relay session;
 * this only writes config.
 */
export async function setLocalMcpEnabled(
  db: DirectDatabase,
  input: { userId: string; name: string; enabled: boolean; relayId?: string | undefined },
): Promise<SetLocalMcpEnabledResult> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.name, input.name));
  const owned = await listConnectedRelaysForUser(input.userId);
  const candidates = rows.filter((row) => {
    const relayId = parseRelayIdFromHost(row.host);
    return relayId !== null && owned.includes(relayId) &&
      (input.relayId === undefined || relayId === input.relayId);
  });
  if (candidates.length > 1) {
    return new Set(candidates.map((row) => row.host)).size === 1
      ? { ok: false, reason: "update_failed" }
      : { ok: false, reason: "ambiguous" };
  }
  const existing = candidates[0];
  if (!existing) {
    if (rows.some((row) => parseRelayIdFromHost(row.host) === null)) {
      return { ok: false, reason: "not_local_tier" };
    }
    return rows.length > 0 ? { ok: false, reason: "not_owner" } : { ok: false, reason: "not_found" };
  }
  const relayId = parseRelayIdFromHost(existing.host);
  if (relayId === null) return { ok: false, reason: "not_local_tier" };

  try {
    const durable = await mutateLocalMcpRelayDurably({
      db,
      relayId,
      targetName: input.name,
      mutate: async (tx): Promise<Omit<Extract<SetLocalMcpEnabledResult, { ok: true }>, "relayLive"> | Exclude<SetLocalMcpEnabledResult, { ok: true }>> => {
        if (!(await listConnectedRelaysForUser(input.userId)).includes(relayId)) {
          return { ok: false, reason: "not_owner" };
        }
        const current = await tx.select().from(mcpServers)
          .where(and(eq(mcpServers.name, input.name), eq(mcpServers.host, existing.host)));
        if (current.length !== 1) return { ok: false, reason: "update_failed" };
        const updated = await tx.update(mcpServers)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(and(eq(mcpServers.name, input.name), eq(mcpServers.host, existing.host)))
          .returning();
        if (updated.length !== 1) return { ok: false, reason: "update_failed" };
        return { ok: true, row: updated[0]! };
      },
      shouldReconcile: (result) => result.ok,
    });
    return durable.value.ok
      ? { ...durable.value, relayLive: durable.relayLive }
      : durable.value;
  } catch {
    return { ok: false, reason: "update_failed" };
  }
}

// ---------------------------------------------------------------------------
// removeLocalMcpServer — owner-gated local stop + delete
// ---------------------------------------------------------------------------

export type RemoveLocalMcpResult =
  | { readonly ok: true; readonly row: McpServer; readonly relayLive: boolean }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "not_local_tier" }
  | { readonly ok: false; readonly reason: "not_owner" }
  | { readonly ok: false; readonly reason: "ambiguous" }
  | { readonly ok: false; readonly reason: "delete_failed" };

/**
 * Permanently remove one owned local MCP. The row deletion and complete-fleet
 * relay reconcile share the same durable mutation boundary as enable/disable,
 * so a live process is stopped before success is reported and commit failure
 * is compensated back to durable truth.
 */
export async function removeLocalMcpServer(
  db: DirectDatabase,
  input: { userId: string; name: string; relayId?: string | undefined },
): Promise<RemoveLocalMcpResult> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.name, input.name));
  const owned = await listConnectedRelaysForUser(input.userId);
  const candidates = rows.filter((row) => {
    const relayId = parseRelayIdFromHost(row.host);
    return relayId !== null && owned.includes(relayId) &&
      (input.relayId === undefined || relayId === input.relayId);
  });
  if (candidates.length > 1) {
    return new Set(candidates.map((row) => row.host)).size === 1
      ? { ok: false, reason: "delete_failed" }
      : { ok: false, reason: "ambiguous" };
  }
  const existing = candidates[0];
  if (!existing) {
    if (rows.some((row) => parseRelayIdFromHost(row.host) === null)) {
      return { ok: false, reason: "not_local_tier" };
    }
    return rows.length > 0 ? { ok: false, reason: "not_owner" } : { ok: false, reason: "not_found" };
  }
  const relayId = parseRelayIdFromHost(existing.host);
  if (relayId === null) return { ok: false, reason: "not_local_tier" };

  try {
    const durable = await mutateLocalMcpRelayDurably({
      db,
      relayId,
      targetName: input.name,
      mutate: async (tx): Promise<Omit<Extract<RemoveLocalMcpResult, { ok: true }>, "relayLive"> | Exclude<RemoveLocalMcpResult, { ok: true }>> => {
        if (!(await listConnectedRelaysForUser(input.userId)).includes(relayId)) {
          return { ok: false, reason: "not_owner" };
        }
        const current = await tx.select().from(mcpServers)
          .where(and(eq(mcpServers.name, input.name), eq(mcpServers.host, existing.host)));
        if (current.length !== 1) return { ok: false, reason: "delete_failed" };
        const deleted = await tx.delete(mcpServers)
          .where(and(eq(mcpServers.name, input.name), eq(mcpServers.host, existing.host)))
          .returning();
        if (deleted.length !== 1) return { ok: false, reason: "delete_failed" };
        return { ok: true, row: deleted[0]! };
      },
      shouldReconcile: (result) => result.ok,
    });
    return durable.value.ok
      ? { ...durable.value, relayLive: durable.relayLive }
      : durable.value;
  } catch {
    return { ok: false, reason: "delete_failed" };
  }
}

// ---------------------------------------------------------------------------
// listLocalMcpServersForUser — the user's own local-tier rows
// ---------------------------------------------------------------------------

/**
 * Every local-tier row hosted on a relay the user currently owns +
 * connects. Server-tier rows and rows on other users' relays are excluded.
 */
export async function listLocalMcpServersForUser(
  db: DirectDatabase,
  userId: string,
): Promise<McpServer[]> {
  const owned = new Set(await listConnectedRelaysForUser(userId));
  const rows = await db.select().from(mcpServers);
  return rows.filter((r) => {
    const relayId = parseRelayIdFromHost(r.host);
    return relayId !== null && owned.has(relayId);
  });
}

// ---------------------------------------------------------------------------
// Agent runtime adapter (D384 §5.4)
// ---------------------------------------------------------------------------

async function summarizeRow(row: McpServer): Promise<LocalMcpServerSummary> {
  return {
    name: row.name,
    host: row.host,
    enabled: row.enabled,
    transportKind: row.transportKind,
    health: await healthForRow(row),
    toolCount: toolCountForRow(row),
  };
}

function mutationAuditEvent(
  userId: string,
  action: "create" | "enable" | "disable" | "delete",
  serverName: string,
): SecurityAuditEvent {
  return {
    kind: "mcp_server_config",
    ts: new Date().toISOString(),
    actorId: userId,
    ip: "",
    userAgent: undefined,
    action,
    serverName,
    outcome: "ok",
  };
}

/**
 * Adapt the service to the agent-side {@link LocalMcpToolRuntime} DI seam.
 * Wired at server boot via `setLocalMcpToolRuntime(...)`. Every mutation
 * writes an `mcp_server_config` audit row through the injected `audit`.
 */
export function createLocalMcpToolRuntime(deps: {
  db: DirectDatabase;
  audit: (event: SecurityAuditEvent) => void;
  /** Override the bounded wait for tools to advertise after `enable`
   *  (defaults to {@link DEFAULT_MCP_TOOLS_WAIT_MS}). Tests set this small. */
  toolsWaitMs?: number;
  /** Poll cadence for the tools wait (defaults to 250ms). */
  toolsPollIntervalMs?: number;
}): LocalMcpToolRuntime {
  const { db, audit } = deps;
  const toolsWaitMs = deps.toolsWaitMs ?? DEFAULT_MCP_TOOLS_WAIT_MS;
  const toolsPollIntervalMs = deps.toolsPollIntervalMs ?? 250;
  const installer = createLocalMcpInstallService(db, audit);

  const register = async (
    ctx: LocalMcpToolActorContext,
    input: LocalMcpRegisterInput,
  ): Promise<LocalMcpActionResult> => {
    const connected = await listConnectedRelaysForUser(ctx.userId);
    if (connected.length === 0) {
      return {
        ok: false,
        error:
          "No connected relay found for you. Connect your machine's relay first, then register a local MCP.",
      };
    }
    let relayId = input.relayId;
    if (!relayId) {
      if (connected.length > 1) {
        return {
          ok: false,
          error:
            "You own more than one connected relay; pass `relayId` to choose which machine hosts this MCP.",
          connectedRelays: connected,
        };
      }
      relayId = connected[0]!;
    }

    const result = await createLocalMcpServer(db, {
      userId: ctx.userId,
      relayId,
      fields: {
        name: input.name,
        transportKind: input.transportKind,
        transport: input.transport,
        ...(input.envPassthrough ? { envPassthrough: input.envPassthrough } : {}),
        ...(input.namespaceId !== undefined ? { namespaceId: input.namespaceId } : {}),
        ...(input.includeTools ? { includeTools: input.includeTools } : {}),
        ...(input.excludeTools ? { excludeTools: input.excludeTools } : {}),
      },
    });
    if (!result.ok) {
      switch (result.reason) {
        case "not_owner":
          return {
            ok: false,
            error: `You do not own a connected relay with id "${relayId}".`,
          };
        case "duplicate":
          return { ok: false, error: `An MCP named "${input.name}" already exists.` };
        case "insert_failed":
          return { ok: false, error: "Failed to write the MCP config row." };
      }
    }
    audit(mutationAuditEvent(ctx.userId, "create", result.row.name));
    return { ok: true, server: await summarizeRow(result.row) };
  };

  const setEnabled = async (
    ctx: LocalMcpToolActorContext,
    input: { name: string; enabled: boolean; relayId?: string | undefined },
  ): Promise<LocalMcpActionResult> => {
    const result = await setLocalMcpEnabled(db, {
      userId: ctx.userId,
      name: input.name,
      enabled: input.enabled,
      relayId: input.relayId,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return { ok: false, error: `No MCP named "${input.name}" was found.` };
        case "not_local_tier":
          return {
            ok: false,
            error: `"${input.name}" is a server-wide MCP; this tool only manages your local MCPs.`,
          };
        case "not_owner":
          return {
            ok: false,
            error: `You do not own the relay hosting "${input.name}".`,
          };
        case "ambiguous":
          return { ok: false, error: `More than one local MCP is named "${input.name}"; provide relayId.` };
        case "update_failed":
          return { ok: false, error: "Failed to update the MCP config row." };
      }
    }
    audit(
      mutationAuditEvent(ctx.userId, input.enabled ? "enable" : "disable", result.row.name),
    );

    // Disable / server offline / no wait needed → report the row as-is.
    if (!input.enabled) {
      return { ok: true, server: await summarizeRow(result.row) };
    }

    if (!result.relayLive) {
      // The relay isn't connected right now — nothing will start until it
      // reconnects. Report that deterministically rather than waiting on a
      // relay that can't answer.
      return {
        ok: true,
        server: await summarizeRow(result.row),
        note: `"${result.row.name}" is enabled, but your relay isn't currently connected, so it hasn't started yet. It will start automatically when your relay reconnects — run status then to confirm its tools.`,
      };
    }

    // Enabling on a LIVE relay: deterministically WAIT for the relay to spawn
    // the MCP and advertise its tools (up to a realistic timeout), then report
    // the ACTUAL state — no guessing.
    await waitForRelayMcpTools(result.row, {
      timeoutMs: toolsWaitMs,
      pollIntervalMs: toolsPollIntervalMs,
    });
    const summary = await summarizeRow(result.row);
    if ((summary.toolCount ?? 0) > 0) {
      return { ok: true, server: summary };
    }
    // Waited the full budget and still nothing — a genuinely slow first-run
    // install or a bad command. Report the real (empty) state and point at
    // status for a later re-check.
    return {
      ok: true,
      server: summary,
      note: `"${result.row.name}" is enabled and your relay was told to start it, but it advertised no tools within ${Math.round(toolsWaitMs / 1000)}s. It may be a slow first-run install or the launch command may be wrong — run status again in a moment to re-check.`,
    };
  };

  const remove = async (
    ctx: LocalMcpToolActorContext,
    input: { name: string; relayId?: string | undefined },
  ): Promise<LocalMcpActionResult> => {
    const result = await removeLocalMcpServer(db, {
      userId: ctx.userId,
      name: input.name,
      relayId: input.relayId,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return { ok: false, error: `No MCP named "${input.name}" was found.` };
        case "not_local_tier":
          return {
            ok: false,
            error: `"${input.name}" is a server-wide MCP; this tool only manages your local MCPs.`,
          };
        case "not_owner":
          return { ok: false, error: `You do not own the relay hosting "${input.name}".` };
        case "ambiguous":
          return { ok: false, error: `More than one local MCP is named "${input.name}"; provide relayId.` };
        case "delete_failed":
          return { ok: false, error: "Failed to stop and delete the MCP config row." };
      }
    }
    audit(mutationAuditEvent(ctx.userId, "delete", result.row.name));
    return {
      ok: true,
      server: {
        name: result.row.name,
        host: result.row.host,
        enabled: false,
        transportKind: result.row.transportKind,
        health: "removed",
        toolCount: 0,
      },
    };
  };

  return {
    listConnectedRelays: (ctx) => listConnectedRelaysForUser(ctx.userId),
    register,
    setEnabled,
    remove,
    list: async (ctx) => {
      const rows = await listLocalMcpServersForUser(db, ctx.userId);
      return { ok: true, servers: await Promise.all(rows.map(summarizeRow)) };
    },
    status: async (ctx, { name, relayId }) => {
      const rows = await listLocalMcpServersForUser(db, ctx.userId);
      const candidates = rows.filter((r) => r.name === name &&
        (relayId === undefined || parseRelayIdFromHost(r.host) === relayId));
      if (candidates.length > 1) {
        return { ok: false, error: `More than one local MCP is named "${name}"; provide relayId.` };
      }
      const row = candidates[0];
      if (!row) {
        return { ok: false, error: `No local MCP named "${name}" is registered for you.` };
      }
      return { ok: true, server: await summarizeRow(row) };
    },
    prepareInstall: (ctx, input) => installer.prepare({
      actorId: ctx.userId,
      intent: input.intent,
      approvalId: input.approvalId,
      threadId: input.threadId,
      laneKey: input.laneKey,
      toolCallId: input.toolCallId,
      checkpointKey: input.checkpointKey,
    }),
    install: (ctx, input) => installer.install({
      actorId: ctx.userId,
      prepared: input.prepared,
      approvalId: input.approvalId,
      toolCallId: input.toolCallId,
      digest: input.digest,
    }),
  };
}
