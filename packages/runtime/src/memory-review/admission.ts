import { getSharedDirectDb, markMemoryReviewTurnInTx, memoryReviewTurns, sessions, and, eq, isNull, type MemoryReviewAdmission } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { reserveMemoryReviewSources } from "@nautilo/agent";
import { warn } from "@nautilo/logger";

/** Coordinates survive coalescing; no copied Human message is ever appended. */
export function memoryReviewSourceIds(input: Record<string, unknown>): number[] {
  const raw = input["memoryReviewSourceMessageIds"];
  const current = input["currentMessageId"];
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("memory_review_source_invalid");
  const supplied: unknown[] = Array.isArray(raw) ? raw as unknown[] : [];
  const ids: unknown[] = [...supplied, ...(current === undefined ? [] : [current])];
  if (ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) throw new Error("memory_review_source_invalid");
  return [...new Set(ids as number[])].sort((a, b) => a - b);
}

export async function memoryReviewAdmission(envelope: MemoryAccessEnvelope | null | undefined, checkpointThreadId: string, source: {
  threadId: string; transcriptOwnerId: string; turnId: string; input: Record<string, unknown>;
}): Promise<{ memoryReview?: MemoryReviewAdmission }> {
  if (!envelope?.ownerId || !envelope.agentId || !envelope.roomId || !source.turnId) return {};
  const ids = memoryReviewSourceIds(source.input);
  const existing = source.input["humanAlreadyPersisted"] === true;
  const memoryReview: MemoryReviewAdmission = {
    ownerId: envelope.ownerId, actorId: envelope.actorId, checkpointThreadId,
    accessScope: envelope.memoryMode === "scope" ? envelope.scopeId : "namespace",
  };
  if (existing || ids.length) await reserveMemoryReviewSources(source.threadId, source.transcriptOwnerId, {
    memoryReview: { ...memoryReview, ...(ids.length ? { existingSourceMessageIds: ids } : { existingHumanTurnId: source.turnId }) }, agentId: envelope.agentId, roomId: envelope.roomId, humanTurnId: source.turnId,
  });
  return { memoryReview };
}

/** Source reservations remain recoverable if this small completion write fails. */
export async function finishMemoryReviewTurn(input: Parameters<typeof markMemoryReviewTurnInTx>[1]): Promise<void> {
  if (!input.turnId || !input.agentId) return;
  try {
    await getSharedDirectDb().transaction((tx) => markMemoryReviewTurnInTx(tx, input));
  } catch {
    warn("[memory-review] completion recording failed; source admission remains pending");
  }
}

/** Unknown or suspended checkpoints must never be reported as a reviewed turn. */
export function memoryReviewCompletionState(checkpoint: unknown): "completed" | "awaiting" | "pending" {
  if (!checkpoint || typeof checkpoint !== "object") return "pending";
  const tasks = "tasks" in checkpoint ? checkpoint.tasks : undefined;
  if (!Array.isArray(tasks)) return "pending";
  if (Array.isArray(tasks)) {
    for (const task of tasks as readonly unknown[]) {
      if (!task || typeof task !== "object") return "pending";
      if ("interrupts" in task && Array.isArray(task.interrupts) && task.interrupts.length > 0) return "awaiting";
    }
  }
  return "completed";
}

/** Resume only a reservation made by the original Memory-capable foreground turn. */
export async function findResumedMemoryReviewAdmission(input: {
  checkpointThreadId: string; turnId: string; threadId: string; transcriptOwnerId: string; agentId: string;
}) {
  const rows = await getSharedDirectDb().select({ turn: memoryReviewTurns }).from(memoryReviewTurns)
    .innerJoin(sessions, eq(sessions.id, memoryReviewTurns.sessionId)).where(and(
      isNull(memoryReviewTurns.receiptId),
      eq(memoryReviewTurns.checkpointThreadId, input.checkpointThreadId),
      eq(memoryReviewTurns.turnId, input.turnId), eq(memoryReviewTurns.threadId, input.threadId),
      eq(memoryReviewTurns.agentId, input.agentId), eq(sessions.ownerId, input.transcriptOwnerId),
    ));
  if (rows.length !== 1) return undefined;
  return rows[0]!.turn;
}
