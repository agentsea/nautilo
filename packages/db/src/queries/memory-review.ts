import { and, eq, inArray, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { memoryReviewTurns } from "../schema/memory-review";
import { sessionMessages, sessions } from "../schema/sessions";
import { agentScopes } from "../schema/agent-scopes";
import { acquireRoomWriteLock } from "./room-lock";

export type MemoryReviewAdmission = {
  ownerId: string;
  actorId: string;
  accessScope: string;
  checkpointThreadId: string;
  /** Server-derived already committed Humans; never content or a transcript scan. */
  existingSourceMessageIds?: number[];
  /** Exact lookup fallback for older already-persisted callers without message coordinates. */
  existingHumanTurnId?: string;
};
type Tx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
type SourceInput = MemoryReviewAdmission & {
  sessionId: string; threadId: string; agentId: string; roomId: string;
  turnId: string; messageId?: number; role?: string;
};

/** Called in source append and before execution for already-committed Human inputs. */
export async function admitMemoryReviewSourceInTx(tx: Tx, input: SourceInput): Promise<void> {
  const ids = [...new Set(input.existingSourceMessageIds ?? [])];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("memory_review_source_invalid");
  const hasAllocated = input.messageId !== undefined;
  if (hasAllocated && (!Number.isSafeInteger(input.messageId) || input.messageId! <= 0)) throw new Error("memory_review_source_invalid");
  if (!hasAllocated && ids.length === 0 && !input.existingHumanTurnId) return;
  await acquireRoomWriteLock(tx, input.roomId);
  await assertAdmissionIdentity(tx, input);
  const referenced = ids.length || input.existingHumanTurnId ? await tx.select({
    id: sessionMessages.id, role: sessionMessages.role, humanTurnId: sessionMessages.humanTurnId,
    fingerprint: sessionMessages.fingerprint, roomId: sessions.roomId,
  }).from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId)).where(and(
    eq(sessions.roomId, input.roomId), eq(sessionMessages.role, "user"),
    ids.length ? inArray(sessionMessages.id, ids) : eq(sessionMessages.humanTurnId, input.existingHumanTurnId!),
  )).for("share", { of: sessionMessages }) : [];
  if ((ids.length && referenced.length !== ids.length) || ((input.existingHumanTurnId || !hasAllocated) && referenced.length === 0)) throw new Error("memory_review_source_unavailable");
  const sourceIds = [...new Set([...referenced.map((row) => row.id), ...(hasAllocated ? [input.messageId!] : [])])].sort((a, b) => a - b);
  const humans = referenced.map((row) => ({ id: row.id, key: row.humanTurnId ?? row.fingerprint ?? `message:${row.id}` }));
  if (input.role === "user") humans.push({ id: input.messageId!, key: input.turnId });
  const incoming = sql`${JSON.stringify(sourceIds)}::jsonb`;
  const mergedIds = sql`(SELECT jsonb_agg(DISTINCT value ORDER BY value)
    FROM jsonb_array_elements(${memoryReviewTurns.sourceIds} || ${incoming}))`;
  // Room serialization makes the first reservation own each Human's cadence.
  // The covered watermark also survives pruning of older covered source rows.
  const scope = sql`prior.room_id = ${input.roomId}::uuid AND prior.agent_id = ${input.agentId}::uuid
    AND prior.owner_id = ${input.ownerId}::uuid AND prior.access_scope = ${input.accessScope}`;
  const newHumanCount = sql`(
    SELECT count(DISTINCT candidate.key)::integer
    FROM jsonb_to_recordset(${JSON.stringify(humans)}::jsonb) AS candidate(id integer, key text)
    WHERE candidate.id > coalesce((
      SELECT max(source.value::integer) FROM memory_review_turns prior
      CROSS JOIN LATERAL jsonb_array_elements_text(prior.source_ids) source(value)
      WHERE ${scope} AND prior.receipt_id IS NOT NULL
    ), 0)
    AND NOT EXISTS (
      SELECT 1 FROM memory_review_turns prior
      CROSS JOIN LATERAL jsonb_array_elements_text(prior.source_ids) source(value)
      JOIN session_messages existing_human ON existing_human.id = source.value::integer
      WHERE ${scope} AND existing_human.role = 'user'
        AND coalesce(existing_human.human_turn_id, existing_human.fingerprint, 'message:' || existing_human.id::text) = candidate.key
    )
  )`;
  await tx.insert(memoryReviewTurns).values({
    sessionId: input.sessionId, threadId: input.threadId, agentId: input.agentId, roomId: input.roomId,
    ownerId: input.ownerId, actorId: input.actorId, accessScope: input.accessScope,
    checkpointThreadId: input.checkpointThreadId, turnId: input.turnId,
    sourceIds, firstMessageId: sourceIds[0]!, hasHuman: newHumanCount,
  }).onConflictDoUpdate({
    target: [memoryReviewTurns.sessionId, memoryReviewTurns.agentId, memoryReviewTurns.ownerId, memoryReviewTurns.accessScope, memoryReviewTurns.turnId],
    set: {
      generationId: sql`CASE WHEN ${memoryReviewTurns.receiptId} IS NOT NULL THEN gen_random_uuid() ELSE ${memoryReviewTurns.generationId} END`,
      sourceIds: sql`CASE WHEN ${memoryReviewTurns.receiptId} IS NOT NULL THEN ${incoming} ELSE ${mergedIds} END`,
      firstMessageId: sql`CASE WHEN ${memoryReviewTurns.receiptId} IS NOT NULL THEN ${sourceIds[0]} ELSE least(${memoryReviewTurns.firstMessageId}, ${sourceIds[0]}) END`,
      hasHuman: sql`CASE WHEN ${memoryReviewTurns.receiptId} IS NOT NULL THEN excluded.has_human ELSE ${memoryReviewTurns.hasHuman} + excluded.has_human END`,
      receiptId: null, attemptId: null, leaseUntil: null, failureCode: null, failurePhase: null, retryAt: null,
      state: "pending", completedAt: null, updatedAt: new Date(),
    },
    // Pure replay must not reopen reviewed work, clear an active lease, or
    // change the completion state of the original execution.
    setWhere: sql`NOT (${memoryReviewTurns.sourceIds} @> ${incoming})`,
  });
}

async function assertAdmissionIdentity(tx: Tx, input: SourceInput): Promise<void> {
  const result = await tx.execute(sql`
    SELECT s.id FROM sessions s JOIN rooms r ON r.id=s.room_id
    JOIN room_members human_member ON human_member.room_id=r.id
    JOIN actors human ON human.id=human_member.actor_id
    WHERE s.id=${input.sessionId}::uuid AND s.thread_id=${input.threadId}
      AND s.room_id=${input.roomId}::uuid AND s.agent_id=${input.agentId}::uuid
      AND human.id::text=${input.actorId} AND human.kind='user' AND human.owner_id=${input.ownerId}::uuid
      AND r.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM room_members member JOIN actors a ON a.id=member.actor_id
        WHERE member.room_id=r.id AND a.kind='agent' AND a.agent_id=${input.agentId}::uuid)
    FOR SHARE OF s,r,human_member,human
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  if (rows.length !== 1) throw new Error("memory_review_authority_unavailable");
  if (input.accessScope !== "namespace") {
    const [scope] = await tx.select().from(agentScopes).where(and(
      eq(agentScopes.id, input.accessScope), eq(agentScopes.parentAgentId, input.agentId),
      eq(agentScopes.speakerUserId, input.ownerId), eq(agentScopes.lifecycleState, "open"),
    )).for("share");
    if (!scope) throw new Error("memory_review_scope_unavailable");
  }
}

export async function markMemoryReviewTurnInTx(tx: Tx, input: {
  threadId: string; agentId: string; turnId: string;
  reviewTurnId?: string;
  state: "completed" | "awaiting" | "interrupted" | "pending";
}): Promise<void> {
  await tx.update(memoryReviewTurns).set({
    state: input.state,
    completedAt: (input.state === "awaiting" || input.state === "pending") ? null : sql`coalesce(${memoryReviewTurns.completedAt}, now())`,
    updatedAt: new Date(),
  }).where(and(
    ...(input.reviewTurnId ? [eq(memoryReviewTurns.id, input.reviewTurnId)] : []),
    eq(memoryReviewTurns.threadId, input.threadId), eq(memoryReviewTurns.agentId, input.agentId),
    eq(memoryReviewTurns.turnId, input.turnId), sql`${memoryReviewTurns.receiptId} IS NULL`,
  ));
}
