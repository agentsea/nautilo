import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  and, asc, desc, lt, eq, inArray, isNull, sql, getSharedDirectDb, memoryReviewTurns, acquireRoomWriteLock,
  memoryReviewReceipts, sessionMessages, users,
  type DirectDatabase,
} from "@nautilo/db";
import {
  getPolicyResolver, resolveSpeakerUserId, type MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  getProfileByAgentId, getAgentDisplayNameById, publishPreparedMemoryReview, MemoryReviewError, revalidateMemoryReviewAuthority,
  deliverMemoryReviewEffect, type MemoryReviewEffect, withSerializableAgentTrustContext,
} from "@nautilo/agent";
import type { MemoryReviewClaim, MemoryReviewRepository } from "./worker";

type Turn = typeof memoryReviewTurns.$inferSelect;
type Source = typeof sessionMessages.$inferSelect;
type Tx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

/** Completed prefix only: a paused lower fork prevents later coverage. */
export function selectMemoryReviewPrefix(turns: readonly Turn[], threshold: number): Turn[] {
  const selected: Turn[] = [];
  let completedHumans = 0;
  for (const turn of turns) {
    if (turn.state === "pending" || turn.state === "awaiting") break;
    if (turn.state === "covered") continue;
    selected.push(turn);
    if (turn.state === "completed") completedHumans += turn.hasHuman;
    if (completedHumans >= threshold) return selected;
  }
  return [];
}

function sourceFingerprint(rows: readonly Source[]): string {
  // Kept inside the access lifetime only. Source revisions fence publication.
  return JSON.stringify(rows.map((row) => [row.id, row.sessionId, row.editRevision, row.cryptoObjectId]));
}
function messageFromRow(row: Source): BaseMessage {
  if (row.content === null) {
    throw new MemoryReviewError("memory_unavailable");
  }
  if (row.role === "user") return new HumanMessage(row.content);
  if (row.role === "assistant") return new AIMessage(row.content);
  if (row.role === "tool") return new ToolMessage({ content: row.content, tool_call_id: String(row.id), name: row.toolName ?? "tool" });
  return new SystemMessage(row.content);
}

export class PostgresMemoryReviewRepository implements MemoryReviewRepository {
  private readonly sources = new Map<string, { ids: number[]; fingerprint: string }>();
  constructor(private readonly policy: {
    threshold(): number;
    leaseMs: number;
    retryMs: number;
    retentionMs: number;
    retentionBatchSize: number;
    assertAvailable(): Promise<void>;
  }, private readonly db: DirectDatabase = getSharedDirectDb()) {}

  async claimNext({ now }: { now: Date }): Promise<MemoryReviewClaim | null> {
    // One scope per scan; SQL groups only durable metadata, never transcript text.
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM memory_review_turns t
      WHERE t.receipt_id IS NULL
        AND (t.failure_code IS NULL
          OR (t.failure_code='publication_uncertain' AND t.retry_at IS NULL)
          OR (t.retry_at IS NOT NULL AND t.retry_at <= ${now.toISOString()}))
        AND (t.lease_until IS NULL OR t.lease_until <= ${now.toISOString()})
        AND NOT EXISTS (SELECT 1 FROM memory_review_turns p
          WHERE p.session_id=t.session_id AND p.agent_id=t.agent_id AND p.owner_id=t.owner_id
            AND p.access_scope=t.access_scope AND p.receipt_id IS NULL AND p.first_message_id<t.first_message_id)
        AND (SELECT coalesce(sum(c.has_human),0) FROM memory_review_turns c
          WHERE c.session_id=t.session_id AND c.agent_id=t.agent_id AND c.owner_id=t.owner_id
            AND c.access_scope=t.access_scope AND c.receipt_id IS NULL AND c.state='completed'
            AND NOT EXISTS (SELECT 1 FROM memory_review_turns barrier
              WHERE barrier.session_id=t.session_id AND barrier.agent_id=t.agent_id AND barrier.owner_id=t.owner_id
                AND barrier.access_scope=t.access_scope AND barrier.state IN ('pending','awaiting')
                AND barrier.first_message_id<c.first_message_id)) >= ${this.policy.threshold()}
      ORDER BY t.updated_at, t.first_message_id LIMIT 1`);
    const id = candidates[0]?.id;
    if (!id) return null;
    return this.db.transaction(async (tx) => {
      const [head] = await tx.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.id, id)).for("update", { skipLocked: true });
      if (!head || head.receiptId || (head.leaseUntil && head.leaseUntil > now)
        || (head.failureCode && (head.retryAt ? head.retryAt > now : head.failureCode !== "publication_uncertain"))) return null;
      const turns = await tx.select().from(memoryReviewTurns).where(and(
        eq(memoryReviewTurns.sessionId, head.sessionId), eq(memoryReviewTurns.agentId, head.agentId),
        eq(memoryReviewTurns.ownerId, head.ownerId), eq(memoryReviewTurns.accessScope, head.accessScope),
        isNull(memoryReviewTurns.receiptId),
      )).orderBy(asc(memoryReviewTurns.firstMessageId)).for("update");
      const prefix = selectMemoryReviewPrefix(turns, this.policy.threshold());
      // Rotate below-cadence/awaiting scopes fairly without inventing overdue work.
      if (!prefix.length) {
        await tx.update(memoryReviewTurns).set({ updatedAt: now }).where(eq(memoryReviewTurns.id, id));
        return null;
      }
      // These row locks wait for any prior publisher to finish; rotating the
      // attempt then fences it from committing later. The worker reconciles the
      // receipt before reading content or invoking a model, including uncertain
      // attempts left by older servers without a reconciliation retry time.
      const attemptId = randomUUID();
      const leaseUntil = new Date(now.getTime() + this.policy.leaseMs);
      const turnIds = prefix.map((turn) => turn.id);
      await tx.update(memoryReviewTurns).set({ attemptId, leaseUntil, lastAttemptAt: now, failureCode: null, failurePhase: null, retryAt: null }).where(inArray(memoryReviewTurns.id, turnIds));
      return { workId: head.generationId, attemptId, ownerId: head.ownerId, actorId: head.actorId,
        agentId: head.agentId, roomId: head.roomId, threadId: head.threadId,
        scopeId: head.accessScope === "namespace" ? null : head.accessScope,
        turnIds, sourceIds: prefix.flatMap((turn) => turn.sourceIds).sort((a,b) => a-b), leaseUntil };
    });
  }

  private async envelope(claim: MemoryReviewClaim): Promise<MemoryAccessEnvelope> {
    await this.policy.assertAvailable();
    const resolver = getPolicyResolver();
    if (!resolver) throw new Error("authority_changed");
    const envelope = await resolver.buildEnvelope(claim.actorId, `room:${claim.roomId}`, claim.agentId, claim.roomId);
    if (envelope.ownerId !== claim.ownerId || envelope.agentId !== claim.agentId || (!claim.scopeId && !envelope.writableNamespaces.length)) throw new Error("authority_changed");
    if (claim.scopeId) return { memoryMode: "scope", ownerId: envelope.ownerId, actorId: envelope.actorId, agentId: envelope.agentId, roomId: envelope.roomId, scopeId: claim.scopeId, toolPolicy: envelope.toolPolicy };
    return envelope;
  }

  async assertCurrent(claim: MemoryReviewClaim): Promise<void> {
    const envelope = await this.envelope(claim);
    const speakerUserId = await resolveSpeakerUserId(envelope);
    const [user] = speakerUserId ? await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, speakerUserId), isNull(users.disabledAt))) : [];
    if (!user) throw new MemoryReviewError("memory_unavailable");
    const rows = await this.db.select({ id: memoryReviewTurns.id }).from(memoryReviewTurns).where(and(
      inArray(memoryReviewTurns.id, claim.turnIds), eq(memoryReviewTurns.attemptId, claim.attemptId),
      isNull(memoryReviewTurns.receiptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
    ));
    if (rows.length !== claim.turnIds.length) throw new Error("lease_lost");
  }

  async renew(claim: MemoryReviewClaim): Promise<void> {
    const leaseUntil = new Date(Date.now() + this.policy.leaseMs);
    const rows = await this.db.update(memoryReviewTurns).set({ leaseUntil }).where(and(
      inArray(memoryReviewTurns.id, claim.turnIds), eq(memoryReviewTurns.attemptId, claim.attemptId),
      isNull(memoryReviewTurns.receiptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
    )).returning({ id: memoryReviewTurns.id });
    if (rows.length !== claim.turnIds.length) throw new Error("lease_lost");
    claim.leaseUntil = leaseUntil;
  }

  async load(claim: MemoryReviewClaim) {
    const memoryAccessEnvelope = await this.envelope(claim);
    await this.assertCurrent(claim);
    const speakerUserId = await resolveSpeakerUserId(memoryAccessEnvelope);
    if (!speakerUserId) throw new MemoryReviewError("memory_unavailable");
    // Exact adjacent covered turn provides boundary context without advancing
    // coverage or admitting later, still-running source turns.
    const [prior] = await this.db.select({ sourceIds: memoryReviewTurns.sourceIds }).from(memoryReviewTurns).where(and(
      eq(memoryReviewTurns.threadId, claim.threadId), eq(memoryReviewTurns.agentId, claim.agentId),
      eq(memoryReviewTurns.ownerId, claim.ownerId), eq(memoryReviewTurns.accessScope, claim.scopeId ?? "namespace"),
      eq(memoryReviewTurns.state, "covered"), lt(memoryReviewTurns.firstMessageId, claim.sourceIds[0]!),
    )).orderBy(desc(memoryReviewTurns.firstMessageId)).limit(1);
    const inputIds = [...new Set([...(prior?.sourceIds ?? []), ...claim.sourceIds])].sort((a,b) => a-b);
    const rows = await withSerializableAgentTrustContext({ userId: speakerUserId, agentId: claim.agentId }, async (tx) => {
      await revalidateMemoryReviewAuthority(tx, { envelope: memoryAccessEnvelope, speakerUserId, operations: [] });
      return tx.select().from(sessionMessages).where(inArray(sessionMessages.id, inputIds)).orderBy(sessionMessages.id);
    });
    if (rows.length !== inputIds.length) throw new MemoryReviewError("source_changed");
    this.sources.set(claim.attemptId, { ids: inputIds, fingerprint: sourceFingerprint(rows) });
    const profile = await getProfileByAgentId(claim.agentId);
    const name = await getAgentDisplayNameById(claim.agentId);
    const turns = await this.db.select({ firstMessageId: memoryReviewTurns.firstMessageId, state: memoryReviewTurns.state }).from(memoryReviewTurns).where(inArray(memoryReviewTurns.id, claim.turnIds));
    const interruptedStarts = new Set(turns.filter((turn) => turn.state === "interrupted").map((turn) => turn.firstMessageId));
    const messages = rows.flatMap((row) => [
      ...(interruptedStarts.has(row.id) ? [new SystemMessage("This turn was interrupted. Only its persisted evidence follows; no completed response is implied.")] : []),
      messageFromRow(row),
    ]);
    return { messages, memoryAccessEnvelope, assistantName: name ?? profile?.name ?? "Nautilo", soulFile: profile?.soulFile ?? "" };
  }

  async reconcile(claim: MemoryReviewClaim) {
    const [receipt] = await this.db.select({ id: memoryReviewReceipts.id }).from(memoryReviewReceipts).where(and(eq(memoryReviewReceipts.workId, claim.workId), eq(memoryReviewReceipts.outcome, "published")));
    return receipt ? "published" as const : "not_published" as const;
  }

  async publish(input: Parameters<MemoryReviewRepository["publish"]>[0]) {
    const { claim, proposal, modelId, now, durationMs } = input;
    await this.assertCurrent(claim);
    try {
      await withSerializableAgentTrustContext({ userId: proposal.speakerUserId, agentId: claim.agentId }, async (tx) => {
        await acquireRoomWriteLock(tx, claim.roomId);
        // A boolean-only database guard pins this transaction's current Human;
        // the Agent role never gains SELECT on credential-bearing users rows.
        const active = await tx.execute<{ active: boolean }>(sql`SELECT app_memory_review_actor_is_active() AS active`);
        if (!active[0]?.active) throw new MemoryReviewError("memory_unavailable");
        await this.lockClaim(tx, claim);
        const loaded = this.sources.get(claim.attemptId);
        if (!loaded) throw new MemoryReviewError("source_changed");
        const rows = await tx.select().from(sessionMessages).where(inArray(sessionMessages.id, loaded.ids)).orderBy(sessionMessages.id).for("share");
        if (sourceFingerprint(rows) !== loaded.fingerprint) throw new MemoryReviewError("source_changed");
        const publication = await publishPreparedMemoryReview(tx, proposal);
        await tx.insert(memoryReviewReceipts).values({ id: claim.attemptId, workId: claim.workId, actorId: claim.actorId, ownerId: claim.ownerId, agentId: claim.agentId, modelId, counts: publication.counts, effects: publication.effects, durationMs: Math.round(durationMs), createdAt: now });
        await tx.update(memoryReviewTurns).set({ state: "covered", receiptId: claim.attemptId, leaseUntil: null, failureCode: null, failurePhase: null, updatedAt: now }).where(inArray(memoryReviewTurns.id, claim.turnIds));
      });
      return "published" as const;
    } catch (error) {
      // PostgreSQL explicitly reports these transactions rolled back. Unknown
      // transport/commit outcomes remain reconciliation-only in the worker.
      if (error && typeof error === "object" && "code" in error && (error.code === "40001" || error.code === "40P01")) throw new MemoryReviewError("source_changed");
      throw error;
    } finally { this.sources.delete(claim.attemptId); }
  }

  private async lockClaim(tx: Tx, claim: MemoryReviewClaim) {
    const turns = await tx.select().from(memoryReviewTurns).where(inArray(memoryReviewTurns.id, claim.turnIds)).orderBy(memoryReviewTurns.id).for("update");
    if (turns.length !== claim.turnIds.length || turns.some((turn) => turn.attemptId !== claim.attemptId || turn.receiptId || !turn.leaseUntil || turn.leaseUntil <= new Date())) throw new Error("lease_lost");
    if (JSON.stringify(turns.flatMap((turn) => turn.sourceIds).sort((a,b) => a-b)) !== JSON.stringify(claim.sourceIds)) throw new MemoryReviewError("source_changed");
  }

  async fail(input: Parameters<MemoryReviewRepository["fail"]>[0]) {
    this.sources.delete(input.claim.attemptId);
    await this.db.transaction(async (tx) => {
      const current = await tx.select({ id: memoryReviewTurns.id }).from(memoryReviewTurns).where(and(
        inArray(memoryReviewTurns.id, input.claim.turnIds), eq(memoryReviewTurns.attemptId, input.claim.attemptId), isNull(memoryReviewTurns.receiptId),
      )).for("update");
      if (current.length !== input.claim.turnIds.length) return;
      await tx.insert(memoryReviewReceipts).values({
        id: input.claim.attemptId, workId: input.claim.workId, actorId: input.claim.actorId, ownerId: input.claim.ownerId, agentId: input.claim.agentId,
        outcome: "failed", phase: input.phase, code: input.reason, modelId: "",
        counts: { created: 0, replaced: 0, promoted: 0, demoted: 0 }, effects: [], durationMs: 0, createdAt: input.now,
      }).onConflictDoNothing();
      await tx.update(memoryReviewTurns).set({ failurePhase: input.phase, failureCode: input.reason, leaseUntil: null,
        // Unknown outcomes get another receipt check, never a blind model retry.
        retryAt: input.retryable || input.reason === "publication_uncertain" ? new Date(input.now.getTime() + this.policy.retryMs) : null, updatedAt: input.now,
      }).where(and(inArray(memoryReviewTurns.id, input.claim.turnIds), eq(memoryReviewTurns.attemptId, input.claim.attemptId), isNull(memoryReviewTurns.receiptId)));
    });
  }

  private async prune(now: Date) {
    const before = new Date(now.getTime() - this.policy.retentionMs).toISOString();
    // Keep per-scope first/latest coverage anchors; never discard unacknowledged
    // effects or pending work. Each tick removes only a caller-bounded page.
    await this.db.execute(sql`
      WITH covered AS (
        SELECT id, updated_at, receipt_id,
          row_number() OVER (PARTITION BY session_id,agent_id,owner_id,access_scope ORDER BY created_at,id) AS first_rank,
          row_number() OVER (PARTITION BY session_id,agent_id,owner_id,access_scope ORDER BY first_message_id DESC) AS last_rank
        FROM memory_review_turns WHERE state='covered'
      ), retired AS (
        SELECT c.id FROM covered c JOIN memory_review_receipts r ON r.id=c.receipt_id
        WHERE c.first_rank>1 AND c.last_rank>1 AND c.updated_at<${before}::timestamptz
          AND r.delivered=jsonb_array_length(r.effects)
        ORDER BY c.updated_at LIMIT ${this.policy.retentionBatchSize}
      ) DELETE FROM memory_review_turns WHERE id IN (SELECT id FROM retired)`);
    await this.db.execute(sql`
      WITH retired AS (
        SELECT r.id FROM memory_review_receipts r WHERE r.created_at<${before}::timestamptz
          AND r.delivered=jsonb_array_length(r.effects)
          AND NOT EXISTS (SELECT 1 FROM memory_review_turns t WHERE t.receipt_id=r.id
            OR (t.generation_id=r.work_id AND t.failure_code='publication_uncertain'))
        ORDER BY r.created_at LIMIT ${this.policy.retentionBatchSize}
      ) DELETE FROM memory_review_receipts WHERE id IN (SELECT id FROM retired)`);
  }

  async drainEffects({ now }: { now: Date }) {
    await this.prune(now);
    const [receipt] = await this.db.select().from(memoryReviewReceipts).where(sql`${memoryReviewReceipts.delivered} < jsonb_array_length(${memoryReviewReceipts.effects})`).orderBy(memoryReviewReceipts.createdAt).limit(1);
    if (!receipt) return;
    for (let index = receipt.delivered; index < receipt.effects.length; index++) {
      try {
        await deliverMemoryReviewEffect(receipt.effects[index] as MemoryReviewEffect);
      } catch (error) {
        await this.db.update(memoryReviewReceipts).set({ phase: "effects", code: "effect_delivery_failed" }).where(eq(memoryReviewReceipts.id, receipt.id));
        throw error;
      }
      await this.db.update(memoryReviewReceipts).set({ delivered: index + 1 }).where(and(eq(memoryReviewReceipts.id, receipt.id), eq(memoryReviewReceipts.delivered, index)));
    }
  }
}
