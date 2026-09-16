import * as db from "@nautilo/db";
import type { AgentDatabase } from "@nautilo/db";

export type AgentTrustContext = {
  /** Authenticated speaker users.id; required for RLS-protected reads/writes. */
  userId: string;
  /** Multi-agent room scoping. Optional. */
  agentId?: string | undefined;
};

export type TrustAgentTx = Parameters<Parameters<AgentDatabase["transaction"]>[0]>[0];

let _trustAgentDb: AgentDatabase | null = null;

/**
 * Module-scoped postgres-js handle connected as `nautilo_agent`. Required
 * by `withTrustContext` (SET LOCAL GUCs must run inside a transaction).
 * Pool size 5 matches the existing memory-store / session-store singletons.
 */
function trustAgentDb(): AgentDatabase {
  if (!_trustAgentDb) {
    const getSharedDirectAgentDb = db.getSharedDirectAgentDb;
    if (typeof getSharedDirectAgentDb !== "function") {
      throw new Error(
        "@nautilo/db getSharedDirectAgentDb is required for agent trust context",
      );
    }
    _trustAgentDb = getSharedDirectAgentDb();
  }
  return _trustAgentDb;
}

/**
 * Run `fn` inside a `withTrustContext` transaction on the shared
 * `trustAgentDb()` handle. Use for any agent-side query that touches an
 * RLS-gated table.
 *
 * Fails closed: `userId` is required (enforced by `withTrustContext`).
 */
export function withAgentTrustContext<T>(
  ctx: AgentTrustContext,
  fn: (tx: TrustAgentTx) => Promise<T>,
): Promise<T> {
  return db.withTrustContext(
    { userId: ctx.userId, ...(ctx.agentId ? { agentId: ctx.agentId } : {}) },
    fn,
    trustAgentDb(),
  );
}

/**
 * D476 — the projection write must validate its authority and write under one
 * serializable transaction.  `withTrustContext` intentionally sets its GUCs
 * first, while PostgreSQL requires the isolation declaration to be the first
 * command in a transaction, so this narrow companion establishes the same
 * trusted context in the required order.
 */
export async function withSerializableAgentTrustContext<T>(
  ctx: AgentTrustContext,
  fn: (tx: TrustAgentTx) => Promise<T>,
): Promise<T> {
  if (!ctx.userId || ctx.userId.length === 0) {
    throw new Error("withSerializableAgentTrustContext: ctx.userId is required (non-empty string)");
  }
  const handle = trustAgentDb();
  return await handle.transaction(async (tx) => {
    // Must be the first statement after BEGIN. This makes an unchecked
    // membership/capability phantom abort rather than authorize a stale share.
    await tx.execute(db.sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await db.setTrustContextOnTx(tx, {
      userId: ctx.userId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    });
    return await fn(tx);
  });
}

/** Normalise `tx.execute()` rows whether Drizzle returns `T[]` or `{ rows: T[] }`. */
export type ExecuteResultRows<T> = T[] | { rows: T[] };

export function rowsFromExecute<T>(result: ExecuteResultRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}
