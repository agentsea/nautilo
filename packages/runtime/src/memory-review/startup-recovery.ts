import { checkpointSaverForConversationExecution } from "../conversation/conversation-execution-services";
import { and, asc, eq, gt, inArray, isNull, lt, memoryReviewTurns, type DirectDatabase } from "@nautilo/db";

/** Only a matching interrupt proves a paused turn; callers fence active execution. */
export function recoveredMemoryReviewTurnState(
  turnId: string,
  tuple: unknown,
): "awaiting" | "interrupted" {
  if (!tuple || typeof tuple !== "object") return "interrupted";
  const checkpoint = "checkpoint" in tuple ? tuple.checkpoint : undefined;
  if (!checkpoint || typeof checkpoint !== "object") return "interrupted";
  const values = "channel_values" in checkpoint ? checkpoint.channel_values : undefined;
  if (!values || typeof values !== "object" || !("turnId" in values) || values.turnId !== turnId) return "interrupted";
  const writes = "pendingWrites" in tuple ? tuple.pendingWrites : undefined;
  return Array.isArray(writes) && writes.some((write: unknown) =>
    Array.isArray(write) && write[1] === "__interrupt__"
      && (!Array.isArray(write[2]) || write[2].length > 0))
    ? "awaiting" : "interrupted";
}

/**
 * Run at startup after opening the canonical ordinary
 * availability gate. A checkpoint load is confidential and never precedes it.
 * The caller owns page policy and the existing checkpoint saver lifetime.
 */
export async function recoverMemoryReviewTurnsAtStartup(options: {
  db: DirectDatabase;
  pageSize: number;
  bootCutoff: Date;
  isTurnActive(turnId: string): boolean;
  checkAvailable(): Promise<boolean>;
  readCheckpoint(threadId: string): Promise<unknown>;
}): Promise<{ recovered: number; unavailable: boolean }> {
  let cursor: string | undefined;
  let recovered = 0;
  for (;;) {
    if (!(await options.checkAvailable())) return { recovered, unavailable: true };
    const rows = await options.db.select({
      id: memoryReviewTurns.id,
      checkpointThreadId: memoryReviewTurns.checkpointThreadId,
      turnId: memoryReviewTurns.turnId,
      updatedAt: memoryReviewTurns.updatedAt,
    }).from(memoryReviewTurns).where(and(
      inArray(memoryReviewTurns.state, ["pending", "awaiting"]),
      isNull(memoryReviewTurns.receiptId),
      lt(memoryReviewTurns.updatedAt, options.bootCutoff),
      ...(cursor === undefined ? [] : [gt(memoryReviewTurns.id, cursor)]),
    )).orderBy(asc(memoryReviewTurns.id)).limit(options.pageSize);
    if (!rows.length) return { recovered, unavailable: false };
    for (const row of rows) {
      if (!(await options.checkAvailable())) return { recovered, unavailable: true };
      cursor = row.id;
      if (options.isTurnActive(row.turnId)) continue;
      // Read failure leaves durable pending state unchanged for honest recovery.
      const tuple = await options.readCheckpoint(row.checkpointThreadId);
      if (options.isTurnActive(row.turnId)) continue;
      await options.db.update(memoryReviewTurns).set({
        state: recoveredMemoryReviewTurnState(row.turnId, tuple), updatedAt: new Date(),
      }).where(and(eq(memoryReviewTurns.id, row.id), inArray(memoryReviewTurns.state, ["pending", "awaiting"]), isNull(memoryReviewTurns.receiptId), eq(memoryReviewTurns.updatedAt, row.updatedAt)));
      recovered++;
      cursor = row.id;
    }
  }
}

/** Uses the existing shared checkpoint saver and its registered pool lifetime. */
export async function readOrdinaryMemoryReviewCheckpoint(threadId: string): Promise<unknown> {
  return checkpointSaverForConversationExecution(undefined).getTuple({ configurable: { thread_id: threadId } });
}
