import {
  and, asc, eq, inArray, isNotNull, isNull, lte, memoryReviewModelRecoveries,
  memoryReviewReceipts, memoryReviewTurns, users, type DirectDatabase,
} from "@nautilo/db";
import { notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";

type Turn = typeof memoryReviewTurns.$inferSelect;
type Recovery = typeof memoryReviewModelRecoveries.$inferSelect;
type Tx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function scopeKey(turn: Turn): string {
  return JSON.stringify([turn.sessionId, turn.agentId, turn.ownerId, turn.accessScope]);
}

function legacyServiceBinding(value: unknown): { kind: "service"; modelId: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row["kind"] === "service" && typeof row["modelId"] === "string"
    && row["modelId"].trim().length > 0 && Object.keys(row).length === 2
    ? { kind: "service", modelId: row["modelId"] }
    : null;
}

/**
 * An explicit recovery may move service-funded work to the current service
 * model. It must never silently convert a Human-funded operation.
 */
export function manualReviewRecoveryBinding(
  value: Turn["acceptedModelBinding"],
  modelId: string,
): Turn["acceptedModelBinding"] | null {
  if (value === null) return { kind: "service", modelId };
  const legacy = legacyServiceBinding(value);
  if (legacy !== null) return { kind: "service", modelId };
  let parsed: MemoryOperationBinding;
  try { parsed = parseMemoryOperationBinding(value); } catch { return null; }
  return parsed.kind === "service" && parsed.role === "memoryReview"
    ? { ...parsed, modelId }
    : null;
}

function alreadyBoundToServiceModel(value: Turn["acceptedModelBinding"], modelId: string): boolean {
  const legacy = legacyServiceBinding(value);
  if (legacy !== null) return legacy.modelId === modelId;
  try {
    const parsed = parseMemoryOperationBinding(value);
    return parsed.kind === "service" && parsed.role === "memoryReview" && parsed.modelId === modelId;
  } catch {
    return false;
  }
}

function exactBlockedPrefix(turns: readonly Turn[], now: Date): Turn[] {
  const head = turns[0];
  if (!head?.attemptId || !head.failureCode || head.receiptId !== null
    || head.failureCode === "publication_uncertain") return [];
  const prefix = turns.filter(turn => turn.attemptId === head.attemptId);
  if (prefix.length === 0 || prefix.some((turn, index) => turn.id !== turns[index]?.id
    || turn.receiptId !== null
    || (turn.state !== "completed" && turn.state !== "interrupted")
    || turn.failureCode !== head.failureCode
    || turn.failurePhase !== head.failurePhase
    || turn.roomId !== head.roomId || turn.actorId !== head.actorId
    || turn.threadId !== head.threadId
    || (turn.leaseUntil !== null && turn.leaseUntil > now)
    || JSON.stringify(turn.acceptedModelBinding) !== JSON.stringify(head.acceptedModelBinding))) return [];
  return prefix;
}

function canReplaceRecovery(recovery: Recovery, blockedAttemptId: string): boolean {
  if (recovery.blockedAttemptId === blockedAttemptId) {
    return recovery.spentAt === null && recovery.recoveryAttemptId === null;
  }
  // A dispatched recovery may receive one new intent only after that exact
  // attempt has become the newly observed terminal hold. An unspent crashed
  // reservation can likewise be re-authorized without claiming it was billed.
  return recovery.recoveryAttemptId === blockedAttemptId;
}

/**
 * Queue one explicitly authorized, possibly billable service-model attempt for
 * every currently observed Memory-review hold. The worker retains the same
 * work and turn identities and spends authorization immediately before wire
 * dispatch. Publication uncertainty is reconciliation-only and is never
 * converted into replay authority here.
 */
export async function requestManualReviewRecovery(input: Readonly<{
  db: Pick<DirectDatabase, "transaction">;
  now: Date;
  observedThrough: Date;
  authorizedBy: string;
  modelId: string;
}>): Promise<{ queued: number; held: number }> {
  const now = validDate(input.now, "manual Memory recovery time");
  const observedThrough = validDate(input.observedThrough, "manual Memory recovery observation cutoff");
  const modelId = input.modelId.trim();
  if (!modelId) throw new TypeError("manual Memory recovery model id is invalid");
  if (!input.authorizedBy.trim()) throw new TypeError("manual Memory recovery authorizer is invalid");

  return input.db.transaction(async (tx: Tx) => {
    const [authorizer] = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.id, input.authorizedBy),
      isNull(users.disabledAt),
    )).limit(1);
    if (!authorizer) throw new Error("Memory review recovery authorizer is unavailable");
    // Discover only mature failed heads. Lock them in the same total scope and
    // turn order used by the worker, then take each exact scope lock below.
    // Healthy accumulating scopes are never locked by this operator command.
    const predecessor = alias(memoryReviewTurns, "manual_memory_recovery_predecessor");
    const prior = tx.select({ one: sql`1` }).from(predecessor).where(and(
      eq(predecessor.sessionId, memoryReviewTurns.sessionId),
      eq(predecessor.agentId, memoryReviewTurns.agentId),
      eq(predecessor.ownerId, memoryReviewTurns.ownerId),
      eq(predecessor.accessScope, memoryReviewTurns.accessScope),
      isNull(predecessor.receiptId),
      sql`(${predecessor.firstMessageId}, ${predecessor.id}) <
        (${memoryReviewTurns.firstMessageId}, ${memoryReviewTurns.id})`,
    ));
    const candidates = await tx.select({
      id: memoryReviewTurns.id,
      sessionId: memoryReviewTurns.sessionId,
      agentId: memoryReviewTurns.agentId,
      ownerId: memoryReviewTurns.ownerId,
      accessScope: memoryReviewTurns.accessScope,
    }).from(memoryReviewTurns).where(and(
      isNull(memoryReviewTurns.receiptId),
      isNotNull(memoryReviewTurns.failureCode),
      isNotNull(memoryReviewTurns.attemptId),
      inArray(memoryReviewTurns.state, ["completed", "interrupted"]),
      or(isNull(memoryReviewTurns.leaseUntil), lte(memoryReviewTurns.leaseUntil, now)),
      notExists(prior),
    )).orderBy(
      asc(memoryReviewTurns.sessionId), asc(memoryReviewTurns.agentId),
      asc(memoryReviewTurns.ownerId), asc(memoryReviewTurns.accessScope),
      asc(memoryReviewTurns.firstMessageId), asc(memoryReviewTurns.id),
    ).for("update", { of: memoryReviewTurns });

    let queued = 0;
    let held = 0;
    for (const candidate of candidates) {
      const turns = await tx.select().from(memoryReviewTurns).where(and(
        eq(memoryReviewTurns.sessionId, candidate.sessionId),
        eq(memoryReviewTurns.agentId, candidate.agentId),
        eq(memoryReviewTurns.ownerId, candidate.ownerId),
        eq(memoryReviewTurns.accessScope, candidate.accessScope),
        isNull(memoryReviewTurns.receiptId),
      )).orderBy(asc(memoryReviewTurns.firstMessageId), asc(memoryReviewTurns.id)).for("update");
      const head = turns[0];
      if (!head?.failureCode || head.id !== candidate.id || scopeKey(head) !== JSON.stringify([
        candidate.sessionId, candidate.agentId, candidate.ownerId, candidate.accessScope,
      ])) continue;
      const prefix = exactBlockedPrefix(turns, now);
      const blockedAttemptId = head.attemptId;
      if (prefix.length === 0 || blockedAttemptId === null) {
        held += 1;
        continue;
      }
      const binding = manualReviewRecoveryBinding(head.acceptedModelBinding, modelId);
      if (binding === null) {
        // Personal/Human funding and malformed historical bindings need their
        // own current authorization; a server-wide button cannot replace it.
        held += 1;
        continue;
      }
      const [latestAttemptReceipt] = await tx.select({
        outcome: memoryReviewReceipts.outcome,
        code: memoryReviewReceipts.code,
        createdAt: memoryReviewReceipts.createdAt,
      }).from(memoryReviewReceipts).where(and(
        eq(memoryReviewReceipts.id, blockedAttemptId),
        eq(memoryReviewReceipts.workId, head.generationId),
      )).limit(1);
      const failedAt = new Date(Math.max(
        ...prefix.map(turn => turn.updatedAt.getTime()),
        latestAttemptReceipt?.createdAt.getTime() ?? 0,
      ));
      if (failedAt > observedThrough || latestAttemptReceipt?.outcome === "published") {
        // The request may authorize only failures in the observation shown to
        // its Human. A failure produced by this recovery request needs a later
        // click and a later cutoff.
        held += 1;
        continue;
      }

      const [previous] = await tx.select().from(memoryReviewModelRecoveries)
        .where(eq(memoryReviewModelRecoveries.workId, head.generationId)).for("update");
      if (previous && !canReplaceRecovery(previous, blockedAttemptId)) {
        held += 1;
        continue;
      }

      const turnIds = prefix.map(turn => turn.id);
      const samePendingIntent = previous?.blockedAttemptId === blockedAttemptId;
      const bindingAlreadyCurrent = alreadyBoundToServiceModel(head.acceptedModelBinding, modelId);
      const authorizationCoversCurrentInput = previous !== undefined
        && prefix.every(turn => turn.updatedAt <= previous.authorizedAt);
      if (samePendingIntent && bindingAlreadyCurrent && authorizationCoversCurrentInput) continue;
      if (!samePendingIntent || !bindingAlreadyCurrent || !authorizationCoversCurrentInput) {
        if (previous) {
          await tx.update(memoryReviewModelRecoveries).set({
            headTurnId: head.id,
            authorizedBy: input.authorizedBy,
            authorizedAt: now,
            blockedAttemptId,
            turnIds,
            spentAt: null,
            recoveryAttemptId: null,
          }).where(samePendingIntent
            ? eq(memoryReviewModelRecoveries.workId, head.generationId)
            : and(
                eq(memoryReviewModelRecoveries.workId, head.generationId),
                eq(memoryReviewModelRecoveries.recoveryAttemptId, blockedAttemptId),
              ));
        } else {
          await tx.insert(memoryReviewModelRecoveries).values({
            workId: head.generationId,
            headTurnId: head.id,
            authorizedBy: input.authorizedBy,
            authorizedAt: now,
            blockedAttemptId,
            turnIds,
          });
        }
        await tx.update(memoryReviewTurns).set({
          acceptedModelBinding: binding,
          retryAt: null,
        }).where(and(
          inArray(memoryReviewTurns.id, turnIds),
          eq(memoryReviewTurns.attemptId, blockedAttemptId),
          isNull(memoryReviewTurns.receiptId),
        ));
        queued += 1;
      }
    }
    return { queued, held };
  });
}
