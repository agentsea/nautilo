import { randomUUID } from "node:crypto";
import { and, eq, mcpServers, sql, type DirectDatabase, type McpServer } from "@nautilo/db";
import { getRelayRegistry } from "@nautilo/agent";
import { RELAY_MCP_TRUTH_PROTOCOL_VERSION, type RelayMcpConfigureResultMessage, type RelayMcpServerConfig } from "@nautilo/relay";
import { relayHostId } from "./relay-mcp-bridge";

const localMcpMutationTails = new Map<string, Promise<void>>();

type TransactionalDatabase = {
  transaction?<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
};

type ExecutableTransaction = {
  execute?(query: unknown): Promise<unknown>;
};

interface RelayMutationRegistry {
  getDesktopSessionId?(relayId: string): string | null | undefined;
  getProtocolVersion?(relayId: string): number | null | undefined;
  sendConfigureMcp?(relayId: string, servers: RelayMcpServerConfig[]): boolean;
  configureMcpWithOutcome?(relayId: string, request: {
    readonly servers: readonly RelayMcpServerConfig[];
    readonly operation: {
      readonly operationId: string;
      readonly digest: string;
      readonly targetName: string;
      readonly phase: "start" | "rollback";
    };
    readonly expectedDesktopSessionId: string;
    readonly timeoutMs?: number;
  }): Promise<RelayMcpConfigureResultMessage>;
}

interface RelaySocketSafetyCloser {
  forceCloseRelays?(relayIds: readonly string[], expectedDesktopSessionId: string): number;
}

let relaySocketSafetyCloser: RelaySocketSafetyCloser | null = null;

export function setLocalMcpMutationRelaySocketSafetyCloser(
  closer: RelaySocketSafetyCloser | null,
): void {
  relaySocketSafetyCloser = closer;
}

export function forceCloseLocalMcpRelay(relayId: string, expectedDesktopSessionId: string): void {
  try {
    relaySocketSafetyCloser?.forceCloseRelays?.([relayId], expectedDesktopSessionId);
  } catch {
    // The caller already fails closed; socket close is the final safety action.
  }
}

class LocalMcpRelayMutationError extends Error {
  constructor(public readonly code: "reconcile_failed" | "rollback_unconfirmed") {
    super(code);
    this.name = "LocalMcpRelayMutationError";
  }
}

function toRelayConfig(row: McpServer): RelayMcpServerConfig {
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

async function exactTargetState(
  db: DirectDatabase,
  relayId: string,
  targetName: string,
): Promise<{ enabled: boolean; rows: McpServer[] }> {
  const host = relayHostId(relayId);
  const targetRows = await db.select().from(mcpServers)
    .where(and(eq(mcpServers.host, host), eq(mcpServers.name, targetName)));
  if (targetRows.length > 1) throw new LocalMcpRelayMutationError("reconcile_failed");
  const enabledRows = await db.select().from(mcpServers)
    .where(and(eq(mcpServers.host, host), eq(mcpServers.enabled, true)));
  return { enabled: targetRows[0]?.enabled === true, rows: enabledRows };
}

async function reconcileRelayTruth(input: {
  db: DirectDatabase;
  relayId: string;
  targetName: string;
  expectedDesktopSessionId: string;
}): Promise<boolean> {
  const registry = getRelayRegistry() as RelayMutationRegistry | null;
  if (!registry || registry.getDesktopSessionId?.(input.relayId) !== input.expectedDesktopSessionId) {
    throw new LocalMcpRelayMutationError("reconcile_failed");
  }
  const state = await exactTargetState(input.db, input.relayId, input.targetName);
  const servers = state.rows.map(toRelayConfig);
  if ((registry.getProtocolVersion?.(input.relayId) ?? 0) >= RELAY_MCP_TRUTH_PROTOCOL_VERSION) {
    if (!registry.configureMcpWithOutcome) throw new LocalMcpRelayMutationError("reconcile_failed");
    const phase = state.enabled ? "start" : "rollback";
    const outcome = await registry.configureMcpWithOutcome(input.relayId, {
      servers,
      operation: {
        operationId: randomUUID(),
        digest: `local-mcp-mutation-${randomUUID()}`,
        targetName: input.targetName,
        phase,
      },
      expectedDesktopSessionId: input.expectedDesktopSessionId,
      timeoutMs: 20_000,
    });
    if ((phase === "start" && outcome.state !== "connected") ||
      (phase === "rollback" && outcome.state !== "stopped")) {
      throw new LocalMcpRelayMutationError("reconcile_failed");
    }
    return true;
  }
  if (!registry.sendConfigureMcp?.(input.relayId, servers)) {
    throw new LocalMcpRelayMutationError("reconcile_failed");
  }
  return true;
}

/** Serialize complete local-MCP fleet reconciles across this process and Postgres. */
export async function withLocalMcpRelayMutation<T>(
  db: DirectDatabase,
  relayId: string,
  operation: (tx: DirectDatabase) => Promise<T>,
): Promise<T> {
  const lockKey = `local-mcp-relay:${relayId}`;
  const prior = localMcpMutationTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => gate);
  localMcpMutationTails.set(lockKey, tail);
  await prior;
  try {
    const transactable = db as unknown as TransactionalDatabase;
    if (typeof transactable.transaction !== "function") return await operation(db);
    return await transactable.transaction(async (rawTx) => {
      const executable = rawTx as ExecutableTransaction;
      if (typeof executable.execute === "function") {
        await executable.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))
        `);
      }
      return operation(rawTx as DirectDatabase);
    });
  } finally {
    release();
    if (localMcpMutationTails.get(lockKey) === tail) localMcpMutationTails.delete(lockKey);
  }
}

/**
 * Commit a local row mutation and its live reconcile as one durable outcome.
 * If commit fails after a send, reconcile the durable fleet under a new lock;
 * a replacement Desktop is never touched and the initiating socket is closed
 * only when durable truth cannot be confirmed.
 */
export async function mutateLocalMcpRelayDurably<T>(input: {
  db: DirectDatabase;
  relayId: string;
  targetName: string;
  mutate: (tx: DirectDatabase) => Promise<T>;
  shouldReconcile: (value: T) => boolean;
}): Promise<{ value: T; relayLive: boolean }> {
  const registry = getRelayRegistry() as RelayMutationRegistry | null;
  const expectedDesktopSessionId = registry?.getDesktopSessionId?.(input.relayId) ?? null;
  let sideEffect = false;
  try {
    return await withLocalMcpRelayMutation(input.db, input.relayId, async (tx) => {
      const value = await input.mutate(tx);
      if (!input.shouldReconcile(value) || !expectedDesktopSessionId) {
        return { value, relayLive: false };
      }
      sideEffect = true;
      await reconcileRelayTruth({
        db: tx,
        relayId: input.relayId,
        targetName: input.targetName,
        expectedDesktopSessionId,
      });
      return { value, relayLive: true };
    });
  } catch (error) {
    if (!sideEffect || !expectedDesktopSessionId) throw error;
    try {
      await withLocalMcpRelayMutation(input.db, input.relayId, async (tx) => {
        await reconcileRelayTruth({
          db: tx,
          relayId: input.relayId,
          targetName: input.targetName,
          expectedDesktopSessionId,
        });
      });
    } catch {
      forceCloseLocalMcpRelay(input.relayId, expectedDesktopSessionId);
      throw new LocalMcpRelayMutationError("rollback_unconfirmed");
    }
    throw error;
  }
}
