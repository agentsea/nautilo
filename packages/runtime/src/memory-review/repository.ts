import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  acquireEncryptionConsumptionFence, and, asc, desc, lt, eq, inArray, isNull, sql,
  getSharedDirectDb, memoryReviewTurns, acquireRoomWriteLock,
  llmUsageEvents, memoryReviewModelRecoveries, memoryReviewReceipts, sessionMessages, users,
  hasOnlyRefusedServiceAttempts, hasSettledServiceMemoryReview,
  KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES, resolveModelAttemptReplaySafety,
  type DirectDatabase,
} from "@nautilo/db";
import { enforceStrictShadowDecision } from "@nautilo/lattice-bridge";
import {
  getPolicyResolver, resolveSpeakerUserId, type MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  getProfileByAgentId, getAgentDisplayNameById, publishPreparedMemoryReview, MemoryReviewError, revalidateMemoryReviewAuthority,
  bindModelInputExposureFromAuthorizedPersistedPayload,
  deliverMemoryReviewEffect, type MemoryReviewEffect, withSerializableAgentTrustContext,
} from "@nautilo/agent";
import { MODEL_INPUT_EXPOSURE_METADATA_KEY } from "@nautilo/agent";
import { reflectionMessageSourceFingerprint } from "../reflection/canonical-room-sources";
import type { ProfileSoulFingerprintInput } from "../executors/foreground-authored-context";
import type { MemoryReviewClaim, MemoryReviewRepository } from "./worker";
import type { MemoryReviewInput } from "./worker";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";

type Turn = typeof memoryReviewTurns.$inferSelect;
type Source = typeof sessionMessages.$inferSelect;
type Tx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

/** Shared admission for the ordinary Memory-review consumer and its spend seam. */
export function memoryReviewOrdinaryPolicyAvailable(policy: Readonly<{
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  shadowBehavior: "fallback" | "strict";
  revision: number;
}>): boolean {
  return enforceStrictShadowDecision(policy, {
    boundaryId: "background.memory.review",
    family: "memory",
    operation: "process",
    actorClass: "background",
    state: "unsupported",
    reason: "unsupported_operation",
    retryable: false,
    policyRevision: policy.revision,
  }).disposition === "ordinary";
}

/** Completed prefix only: a paused lower fork prevents later coverage. */
export function selectMemoryReviewPrefix(turns: readonly Turn[], threshold: number): Turn[] {
  const selected: Turn[] = [];
  let completedHumans = 0;
  for (const turn of turns) {
    if (turn.state === "pending" || turn.state === "awaiting") break;
    if (turn.state === "covered") continue;
    if (selected.length > 0 && turn.failureCode === "provider_outcome_unknown") break;
    selected.push(turn);
    if (turn.state === "completed") completedHumans += turn.hasHuman;
    if (completedHumans >= threshold) return selected;
  }
  return [];
}

type MemoryReviewModelRecoveryRequest = Readonly<{
  workId: string;
  headTurnId: string;
  authorizedBy: string;
  now: Date;
}>;

type MemoryReviewModelRecoveryResult = "queued" | "already_requested" | "blocked";

const AUTOMATIC_MODEL_CHANGE_FAILURES = [
  ...KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES,
  "provider_failed",
  "model_unavailable",
] as const;

function serviceModelId(binding: Turn["acceptedModelBinding"]): string | null {
  const current = acceptedOperation(binding);
  if (current !== null) return current.kind === "service" ? current.modelId : null;
  return legacyServiceBinding(binding)?.modelId ?? null;
}

function recoveryPrefix(turns: readonly Turn[], blockedAttemptId: string, now: Date): Turn[] {
  const head = turns[0];
  if (!head?.failureCode || head.failureCode === "publication_uncertain"
    || !hasExactRecoveryCoordinates(turns, head)
    || turns.some((turn) => turn.leaseUntil && turn.leaseUntil > now)) return [];
  const members = turns.filter((turn) => turn.attemptId === blockedAttemptId);
  const modelId = serviceModelId(head.acceptedModelBinding);
  return modelId !== null && members.length > 0 && members.every((turn, index) =>
    turn.id === turns[index]?.id
    && (turn.state === "completed" || turn.state === "interrupted")
    && turn.failurePhase === head.failurePhase && turn.failureCode === head.failureCode
    && JSON.stringify(turn.acceptedModelBinding) === JSON.stringify(head.acceptedModelBinding)
    && serviceModelId(turn.acceptedModelBinding) === modelId)
    ? members : [];
}

function hasExactRecoveryCoordinates(turns: readonly Turn[], head: Turn): boolean {
  return turns.every((turn) => turn.roomId === head.roomId
    && turn.actorId === head.actorId && turn.threadId === head.threadId);
}

function reviewScope(head: Turn) {
  return and(
    eq(memoryReviewTurns.sessionId, head.sessionId), eq(memoryReviewTurns.agentId, head.agentId),
    eq(memoryReviewTurns.ownerId, head.ownerId), eq(memoryReviewTurns.accessScope, head.accessScope),
    isNull(memoryReviewTurns.receiptId),
  );
}

function matchesRecoveryTurns(turns: readonly Turn[], turnIds: readonly string[]): boolean {
  return turns.length === turnIds.length && turns.every((turn, index) => turn.id === turnIds[index]);
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

function acceptedOperation(value: unknown): MemoryOperationBinding | null {
  try { return parseMemoryOperationBinding(value); } catch { return null; }
}

function sameBinding(left: MemoryOperationBinding, right: MemoryOperationBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacyServiceBinding(value: unknown): { kind: "service"; modelId: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row["kind"] === "service" && typeof row["modelId"] === "string" && row["modelId"].trim()
    && Object.keys(row).length === 2 ? { kind: "service", modelId: row["modelId"] } : null;
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
    fingerprintProfileSoul?: (input: ProfileSoulFingerprintInput) => string;
  }, private readonly db: DirectDatabase = getSharedDirectDb()) {}

  private async lockScope(tx: Tx, head: Turn): Promise<Turn[]> {
    return tx.select().from(memoryReviewTurns).where(reviewScope(head))
      .orderBy(asc(memoryReviewTurns.firstMessageId), asc(memoryReviewTurns.id)).for("update");
  }

  private async automaticModelRecoveryBinding(
    tx: Tx,
    head: Turn,
    turns: readonly Turn[],
    targetModelId: string,
    now: Date,
  ): Promise<Turn["acceptedModelBinding"] | null> {
    const acceptedBinding = acceptedOperation(head.acceptedModelBinding);
    if (acceptedBinding !== null && acceptedBinding.role !== "memoryReview") return null;
    const sourceBinding = acceptedBinding ?? legacyServiceBinding(head.acceptedModelBinding);
    if (!head.attemptId || !head.failureCode
      || !(AUTOMATIC_MODEL_CHANGE_FAILURES as readonly string[]).includes(head.failureCode)
      || sourceBinding?.kind !== "service" || sourceBinding.modelId === targetModelId
      || turns[0]?.id !== head.id || !hasExactRecoveryCoordinates(turns, head)
      || turns.some((turn) => turn.attemptId !== head.attemptId
        || turn.failurePhase !== "model" || turn.failureCode !== head.failureCode
        || (turn.leaseUntil !== null && turn.leaseUntil > now)
        || JSON.stringify(turn.acceptedModelBinding) !== JSON.stringify(head.acceptedModelBinding))) return null;

    const [rejection] = await tx.select({ id: memoryReviewReceipts.id }).from(memoryReviewReceipts).where(and(
      eq(memoryReviewReceipts.id, head.attemptId),
      eq(memoryReviewReceipts.workId, head.generationId),
      eq(memoryReviewReceipts.outcome, "failed"),
      eq(memoryReviewReceipts.phase, "model"),
      eq(memoryReviewReceipts.code, head.failureCode),
    )).limit(1);
    if (!rejection) return null;

    const attempts = await tx.select({
      modelId: llmUsageEvents.model,
      fundingKind: llmUsageEvents.fundingKind,
      payerHumanId: llmUsageEvents.payerHumanId,
      attemptId: sql<string | null>`${llmUsageEvents.metadata}->>'attemptId'`,
    }).from(llmUsageEvents).where(and(
      eq(llmUsageEvents.roomId, head.roomId),
      eq(llmUsageEvents.callType, "memory_review"),
      eq(sql<string>`${llmUsageEvents.metadata}->>'workId'`, head.generationId),
    ));
    if (attempts.length === 0
      || attempts.some((attempt) => !(["service", "server"] as const).includes(attempt.fundingKind as "service" | "server")
        || attempt.payerHumanId !== null)
      || !attempts.some((attempt) => attempt.attemptId === head.attemptId && attempt.modelId === sourceBinding.modelId)
      || attempts.some((attempt) => attempt.modelId === targetModelId)) return null;
    const identity = { kind: "memory_review" as const, roomId: head.roomId, workId: head.generationId };
    const knownRejectedOutput = (KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES as readonly string[])
      .includes(head.failureCode);
    if (knownRejectedOutput) {
      const replay = await resolveModelAttemptReplaySafety(identity, { db: tx });
      if (replay.decision !== "allow") return null;
    } else if (!await hasOnlyRefusedServiceAttempts([identity], tx, {
      modelId: sourceBinding.modelId,
      attemptId: head.attemptId,
    })) return null;
    return acceptedBinding === null
      ? { kind: "service", modelId: targetModelId }
      : { ...sourceBinding, modelId: targetModelId };
  }

  async requestModelRecovery(input: MemoryReviewModelRecoveryRequest): Promise<MemoryReviewModelRecoveryResult> {
    await this.policy.assertAvailable();
    return this.db.transaction(async (tx) => {
      // The injected preflight avoids needless exact-work contention, but the
      // durable policy may transition before this transaction begins. Recheck
      // under the shared fence before taking recovery or turn locks.
      const encryption = await acquireEncryptionConsumptionFence(tx);
      if (!memoryReviewOrdinaryPolicyAvailable(encryption)) return "blocked";
      const [head] = await tx.select().from(memoryReviewTurns).where(and(
        eq(memoryReviewTurns.id, input.headTurnId), eq(memoryReviewTurns.generationId, input.workId),
      )).for("update");
      if (!head || head.receiptId || head.state === "covered") return "blocked";
      const [previousRequest] = await tx.select().from(memoryReviewModelRecoveries)
        .where(eq(memoryReviewModelRecoveries.workId, input.workId)).for("update");
      if (previousRequest && (previousRequest.spentAt !== null
        || previousRequest.recoveryAttemptId === null
        || previousRequest.recoveryAttemptId !== head.attemptId
        || (head.leaseUntil && head.leaseUntil > input.now))) return "already_requested";
      if (!head.attemptId || head.failureCode !== "provider_outcome_unknown") return "blocked";
      const turns = await this.lockScope(tx, head);
      const prefix = recoveryPrefix(turns, head.attemptId, input.now);
      if (prefix[0]?.id !== head.id
        || (previousRequest && !matchesRecoveryTurns(prefix, previousRequest.turnIds))) return "blocked";
      const [receipt] = await tx.select({ id: memoryReviewReceipts.id }).from(memoryReviewReceipts).where(and(
        eq(memoryReviewReceipts.workId, input.workId), eq(memoryReviewReceipts.outcome, "published"),
      ));
      const modelId = serviceModelId(head.acceptedModelBinding);
      if (receipt || modelId === null
        || !await hasSettledServiceMemoryReview({ roomId: head.roomId, workId: input.workId, modelId }, tx)) return "blocked";
      if (previousRequest) {
        // The lost reservation never reached dispatch. Fresh consent can bind
        // current inputs again while retaining the exact service model.
        await tx.update(memoryReviewTurns)
          .set({ acceptedModelBinding: { kind: "service", modelId } })
          .where(and(
            inArray(memoryReviewTurns.id, previousRequest.turnIds), eq(memoryReviewTurns.roomId, head.roomId),
            eq(memoryReviewTurns.actorId, head.actorId), eq(memoryReviewTurns.threadId, head.threadId),
          ));
        await tx.update(memoryReviewModelRecoveries).set({
          authorizedBy: input.authorizedBy, authorizedAt: input.now,
          blockedAttemptId: head.attemptId, recoveryAttemptId: null,
        }).where(eq(memoryReviewModelRecoveries.workId, input.workId));
        return "queued";
      }
      await tx.insert(memoryReviewModelRecoveries).values({
        workId: input.workId, headTurnId: head.id,
        authorizedBy: input.authorizedBy, authorizedAt: input.now,
        blockedAttemptId: head.attemptId, turnIds: prefix.map((turn) => turn.id),
      });
      return "queued";
    });
  }

  async claimNext({ now, currentServiceModelId }: {
    now: Date;
    currentServiceModelId?: string;
  }): Promise<MemoryReviewClaim | null> {
    // One scope per scan; SQL groups only durable metadata, never transcript text.
    const recoveryPending = sql`(t.failure_code IS NOT NULL AND t.failure_code<>'publication_uncertain' AND EXISTS (
      SELECT 1 FROM ${memoryReviewModelRecoveries} recovery
      WHERE recovery.work_id=t.generation_id AND recovery.head_turn_id=t.id AND recovery.spent_at IS NULL
        AND recovery.recovery_attempt_id IS NULL AND recovery.blocked_attempt_id=t.attempt_id
        AND NOT EXISTS (SELECT 1 FROM ${memoryReviewTurns} changed
          WHERE changed.session_id=t.session_id AND changed.agent_id=t.agent_id
            AND changed.owner_id=t.owner_id AND changed.access_scope=t.access_scope
            AND changed.receipt_id IS NULL AND changed.attempt_id=recovery.blocked_attempt_id
            AND changed.updated_at>recovery.authorized_at)
    ))`;
    const automaticModelRecovery = currentServiceModelId === undefined ? sql`false` : sql`(
      t.failure_code=ANY(${sql.param([...AUTOMATIC_MODEL_CHANGE_FAILURES])}::text[])
      AND t.accepted_model_binding->>'kind'='service'
      AND t.accepted_model_binding->>'modelId'<>${currentServiceModelId}
    )`;
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM memory_review_turns t
      WHERE t.receipt_id IS NULL
        AND (t.failure_code IS NULL
          OR (t.failure_code='publication_uncertain' AND t.retry_at IS NULL)
          OR ${recoveryPending}
          OR ${automaticModelRecovery}
          OR (t.retry_at IS NOT NULL AND t.retry_at <= ${now.toISOString()}))
        AND (t.lease_until IS NULL OR t.lease_until <= ${now.toISOString()})
        AND NOT EXISTS (SELECT 1 FROM memory_review_turns p
          WHERE p.session_id=t.session_id AND p.agent_id=t.agent_id AND p.owner_id=t.owner_id
            AND p.access_scope=t.access_scope AND p.receipt_id IS NULL
            AND (p.first_message_id,p.id)<(t.first_message_id,t.id))
        AND (${recoveryPending} OR ${automaticModelRecovery}
          OR (SELECT coalesce(sum(c.has_human),0) FROM memory_review_turns c
          WHERE c.session_id=t.session_id AND c.agent_id=t.agent_id AND c.owner_id=t.owner_id
            AND c.access_scope=t.access_scope AND c.receipt_id IS NULL AND c.state='completed'
            AND NOT EXISTS (SELECT 1 FROM memory_review_turns barrier
              WHERE barrier.session_id=t.session_id AND barrier.agent_id=t.agent_id AND barrier.owner_id=t.owner_id
                AND barrier.access_scope=t.access_scope AND barrier.state IN ('pending','awaiting')
                AND barrier.first_message_id<c.first_message_id)) >= ${this.policy.threshold()})
      ORDER BY t.updated_at, t.first_message_id, t.id LIMIT 1`);
    const id = candidates[0]?.id;
    if (!id) return null;
    return this.db.transaction(async (tx) => {
      const [head] = await tx.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.id, id)).for("update", { skipLocked: true });
      if (!head || head.receiptId || (head.leaseUntil && head.leaseUntil > now)) return null;
      const [recovery] = await tx.select().from(memoryReviewModelRecoveries)
        .where(eq(memoryReviewModelRecoveries.workId, head.generationId)).for("update");
      const recovering = recovery?.spentAt === null && recovery.recoveryAttemptId === null
        && recovery.headTurnId === head.id && recovery.blockedAttemptId === head.attemptId
        && head.failureCode !== null && head.failureCode !== "publication_uncertain";
      const automaticRecoveryCandidate = recovery === undefined
        && currentServiceModelId !== undefined
        && (AUTOMATIC_MODEL_CHANGE_FAILURES as readonly string[]).includes(head.failureCode ?? "")
        && serviceModelId(head.acceptedModelBinding) !== null
        && serviceModelId(head.acceptedModelBinding) !== currentServiceModelId;
      const normallyDue = !head.failureCode
        || (head.retryAt ? head.retryAt <= now : head.failureCode === "publication_uncertain");
      if (!recovering && !automaticRecoveryCandidate && !normallyDue) return null;
      const turns = await this.lockScope(tx, head);
      if (turns[0]?.id !== head.id) return null;
      const operatorPrefix = recovering ? recoveryPrefix(turns, recovery.blockedAttemptId, now) : null;
      if (recovering && operatorPrefix !== null
        && (!matchesRecoveryTurns(operatorPrefix, recovery.turnIds)
          || operatorPrefix.some(turn => turn.updatedAt > recovery.authorizedAt))) {
        return null;
      }
      const attemptedPrefix = automaticRecoveryCandidate && head.attemptId !== null
        ? turns.filter(turn => turn.attemptId === head.attemptId) : [];
      const exactAttemptedPrefix = attemptedPrefix.length > 0
        && attemptedPrefix.every((turn, index) => turn.id === turns[index]?.id
          && (turn.state === "completed" || turn.state === "interrupted"));
      const automaticBinding = automaticRecoveryCandidate && exactAttemptedPrefix
        ? await this.automaticModelRecoveryBinding(tx, head, attemptedPrefix, currentServiceModelId, now)
        : null;
      const prefix = operatorPrefix ?? (automaticBinding !== null ? attemptedPrefix
        : normallyDue ? selectMemoryReviewPrefix(turns, this.policy.threshold()) : []);
      // Rotate ineligible scopes fairly without inventing overdue work.
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
      await tx.update(memoryReviewTurns).set({
        attemptId, leaseUntil, lastAttemptAt: now,
        // An expired reservation stays fenced until the operator confirms again.
        failureCode: recovery ? head.failureCode : null,
        failurePhase: recovery ? head.failurePhase : null, retryAt: null,
        ...(automaticBinding === null ? {} : { acceptedModelBinding: automaticBinding }),
      }).where(inArray(memoryReviewTurns.id, turnIds));
      if (recovering) {
        await tx.update(memoryReviewModelRecoveries).set({ recoveryAttemptId: attemptId })
          .where(eq(memoryReviewModelRecoveries.workId, head.generationId));
      }
      return { workId: head.generationId, attemptId,
        ...(recovery ? { modelRecovery: recovering ? "authorized" : "spent" } : {}),
        ...(automaticBinding === null ? {} : { automaticModelRecovery: true as const }),
        ownerId: head.ownerId, actorId: head.actorId,
        agentId: head.agentId, roomId: head.roomId, threadId: head.threadId,
        scopeId: head.accessScope === "namespace" ? null : head.accessScope,
        turnIds, sourceIds: prefix.flatMap((turn) => turn.sourceIds).sort((a,b) => a-b), leaseUntil };
    });
  }

  /** Spend consent only after the reserved claim and its exact inputs still hold. */
  async beginModelRecoveryDispatch(claim: MemoryReviewClaim): Promise<void> {
    await this.db.transaction(async (tx) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (!memoryReviewOrdinaryPolicyAvailable(policy)) {
        throw new MemoryReviewError("memory_unavailable");
      }
      const [head] = await tx.select().from(memoryReviewTurns).where(and(
        eq(memoryReviewTurns.id, claim.turnIds[0]!),
        eq(memoryReviewTurns.generationId, claim.workId),
      )).for("update");
      const [recovery] = await tx.select().from(memoryReviewModelRecoveries).where(and(
        eq(memoryReviewModelRecoveries.workId, claim.workId),
        eq(memoryReviewModelRecoveries.headTurnId, claim.turnIds[0]!),
        eq(memoryReviewModelRecoveries.recoveryAttemptId, claim.attemptId),
        isNull(memoryReviewModelRecoveries.spentAt),
      )).for("update");
      const modelId = serviceModelId(head?.acceptedModelBinding ?? null);
      if (!head || !recovery || modelId === null
        || recovery.turnIds.length !== claim.turnIds.length
        || recovery.turnIds.some((turnId, index) => turnId !== claim.turnIds[index])) {
        throw new Error("Memory recovery dispatch authorization changed");
      }
      await this.lockClaim(tx, claim);
      await tx.update(memoryReviewModelRecoveries).set({ spentAt: new Date() })
        .where(eq(memoryReviewModelRecoveries.workId, claim.workId));
    });
  }

  async modelReplaySafety(claim: MemoryReviewClaim): Promise<"allow" | "block_unknown"> {
    if (claim.modelRecovery === "spent") return "block_unknown";
    if (claim.modelRecovery === "authorized") {
      const [head] = await this.db.select({
        recoveryAttemptId: memoryReviewModelRecoveries.recoveryAttemptId,
        binding: memoryReviewTurns.acceptedModelBinding,
      }).from(memoryReviewModelRecoveries)
        .innerJoin(memoryReviewTurns, eq(memoryReviewTurns.id, memoryReviewModelRecoveries.headTurnId))
        .where(and(
          eq(memoryReviewModelRecoveries.workId, claim.workId),
          isNull(memoryReviewModelRecoveries.spentAt),
          eq(memoryReviewTurns.id, claim.turnIds[0]!), eq(memoryReviewTurns.generationId, claim.workId),
          eq(memoryReviewTurns.attemptId, claim.attemptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
        ));
      const modelId = serviceModelId(head?.binding ?? null);
      return head?.recoveryAttemptId === claim.attemptId && modelId !== null
        ? "allow" : "block_unknown";
    }
    // The work identity owns wire history, even after a turn's attempt changes.
    const replay = await resolveModelAttemptReplaySafety({
      kind: "memory_review", roomId: claim.roomId, workId: claim.workId,
    }, { db: this.db });
    return replay.decision;
  }

  private async envelope(claim: MemoryReviewClaim): Promise<MemoryAccessEnvelope> {
    await this.policy.assertAvailable();
    const resolver = getPolicyResolver();
    if (!resolver) throw new Error("authority_changed");
    const envelope = await resolver.buildEnvelope(claim.actorId, `room:${claim.roomId}`, claim.agentId, claim.roomId);
    if (envelope.externalContext === true) throw new Error("external_room_memory_review_unavailable");
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
    const loaded = this.sources.get(claim.attemptId);
    if (loaded) {
      const sourceRows = await withSerializableAgentTrustContext({ userId: speakerUserId!, agentId: claim.agentId }, async (tx) => {
        await revalidateMemoryReviewAuthority(tx, { envelope, speakerUserId: speakerUserId!, operations: [] });
        return tx.select().from(sessionMessages).where(inArray(sessionMessages.id, loaded.ids)).orderBy(sessionMessages.id);
      });
      if (sourceRows.length !== loaded.ids.length || sourceFingerprint(sourceRows) !== loaded.fingerprint) {
        throw new MemoryReviewError("source_changed");
      }
    }
  }

  async bindServiceModel(claim: MemoryReviewClaim, resolveModelId: () => string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const turns = await this.lockClaim(tx, claim);
      const raw = turns.flatMap((turn) => turn.acceptedModelBinding === null ? [] : [turn.acceptedModelBinding]);
      const models = raw.map((binding) => acceptedOperation(binding)?.modelId ?? legacyServiceBinding(binding)?.modelId ?? null);
      if (models.some((model) => model === null) || new Set(models).size > 1
        || raw.some((binding) => acceptedOperation(binding)?.kind === "human")) {
        throw new MemoryReviewError("source_changed");
      }
      const modelId = models[0] ?? resolveModelId().trim();
      if (!modelId) throw new MemoryReviewError("model_unavailable");
      const serviceBinding = raw.length ? (acceptedOperation(raw[0]) ?? { kind: "service" as const, modelId })
        : { kind: "service" as const, modelId };
      const unboundIds = turns.filter((turn) => turn.acceptedModelBinding === null).map((turn) => turn.id);
      if (unboundIds.length) {
        const updated = await tx.update(memoryReviewTurns).set({ acceptedModelBinding: serviceBinding }).where(and(
          inArray(memoryReviewTurns.id, unboundIds), eq(memoryReviewTurns.attemptId, claim.attemptId),
          isNull(memoryReviewTurns.receiptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
        )).returning({ id: memoryReviewTurns.id });
        if (updated.length !== unboundIds.length) throw new Error("lease_lost");
      }
      return modelId;
    });
  }

  async getAcceptedModelOperation(claim: MemoryReviewClaim): Promise<MemoryOperationBinding | null> {
    const turns = await this.db.select({ binding: memoryReviewTurns.acceptedModelBinding }).from(memoryReviewTurns).where(and(
      inArray(memoryReviewTurns.id, claim.turnIds), eq(memoryReviewTurns.attemptId, claim.attemptId),
      isNull(memoryReviewTurns.receiptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
    ));
    if (turns.length !== claim.turnIds.length) throw new Error("lease_lost");
    const raw = turns.flatMap((turn) => turn.binding === null ? [] : [turn.binding]);
    const legacy = raw.map(legacyServiceBinding).filter((binding) => binding !== null);
    const parsed = raw.map(acceptedOperation).filter((binding) => binding !== null);
    if (legacy.length + parsed.length !== raw.length || (legacy.length && parsed.length)
      || new Set(legacy.map((binding) => binding.modelId)).size > 1) {
      throw new MemoryReviewError("source_changed");
    }
    if (legacy.length) return null;
    const bindings = parsed;
    const first = bindings[0];
    if (first && bindings.some((binding) => !sameBinding(first, binding))) throw new MemoryReviewError("source_changed");
    return first ?? null;
  }

  async bindModelOperation(claim: MemoryReviewClaim, resolve: (legacyServiceModelId?: string) => Promise<MemoryOperationBinding>): Promise<MemoryOperationBinding> {
    return this.db.transaction(async (tx) => {
      const turns = await this.lockClaim(tx, claim);
      const raw = turns.flatMap((turn) => turn.acceptedModelBinding === null ? [] : [turn.acceptedModelBinding]);
      const legacy = raw.map(legacyServiceBinding).filter((binding) => binding !== null);
      const parsed = raw.map(acceptedOperation).filter((binding) => binding !== null);
      if (legacy.length + parsed.length !== raw.length || new Set(legacy.map((binding) => binding.modelId)).size > 1
        || (legacy.length && parsed.length)) throw new MemoryReviewError("source_changed");
      const bindings = parsed;
      const first = bindings[0];
      if (first && bindings.some((binding) => !sameBinding(first, binding))) throw new MemoryReviewError("source_changed");
      if (first) return first;
      const proposed = acceptedOperation(await resolve(legacy[0]?.modelId));
      if (!proposed || proposed.role !== "memoryReview") throw new MemoryReviewError("source_changed");
      const accepted: MemoryOperationBinding = legacy.length
        ? { version: 1, kind: "service", role: "memoryReview", modelId: legacy[0]!.modelId,
            inputCommitment: proposed.inputCommitment }
        : proposed;
      const updateIds = turns.filter((turn) => turn.acceptedModelBinding === null || legacyServiceBinding(turn.acceptedModelBinding) !== null).map((turn) => turn.id);
      if (updateIds.length) {
        const updated = await tx.update(memoryReviewTurns).set({ acceptedModelBinding: accepted }).where(and(
          inArray(memoryReviewTurns.id, updateIds), eq(memoryReviewTurns.attemptId, claim.attemptId),
          isNull(memoryReviewTurns.receiptId), sql`${memoryReviewTurns.leaseUntil} > now()`,
        )).returning({ id: memoryReviewTurns.id });
        if (updated.length !== updateIds.length) throw new Error("lease_lost");
      }
      return accepted;
    });
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
    const namespaceId = claim.scopeId ?? (memoryAccessEnvelope.memoryMode !== "scope"
      && memoryAccessEnvelope.writableNamespaces.length === 1
      ? memoryAccessEnvelope.writableNamespaces[0]
      : undefined);
    let completeExposure = namespaceId !== undefined;
    const dependencies = [] as NonNullable<MemoryReviewInput["modelExposureDependencies"]>[number][];
    const messages = rows.flatMap((row) => {
      const message = messageFromRow(row);
      if (row.role !== "user") {
        const metadata = row.metadata?.[MODEL_INPUT_EXPOSURE_METADATA_KEY];
        bindModelInputExposureFromAuthorizedPersistedPayload(message, metadata);
        // Exact review exposure is distinct from the source's derivation.
        // The live evidence reader classifies missing legacy ancestry as service.
      }
      if (namespaceId !== undefined) dependencies.push({
        kind: "source", sourceKind: "message", logicalSourceRef: `message:${row.id}`,
        observedRevision: String(row.editRevision),
        observedContentFingerprint: reflectionMessageSourceFingerprint({ id: row.id, editRevision: row.editRevision, content: row.content ?? "" }),
        terminalAuthorityLeafHandle: namespaceId,
      });
      return [
        ...(interruptedStarts.has(row.id) ? [new SystemMessage("This turn was interrupted. Only its persisted evidence follows; no completed response is implied.")] : []),
        message,
      ];
    });
    if (profile?.soulFile) {
      if (namespaceId === undefined || !this.policy.fingerprintProfileSoul) completeExposure = false;
      else dependencies.push({
        kind: "source", sourceKind: "profile_soul", logicalSourceRef: `agent-soul:${profile.agentId}`,
        observedRevision: String(profile.soulRevision),
        observedContentFingerprint: this.policy.fingerprintProfileSoul({ agentId: profile.agentId,
          profileId: profile.id, userId: profile.userId, soulRevision: profile.soulRevision, soulFile: profile.soulFile }),
        terminalAuthorityLeafHandle: namespaceId,
      });
    }
    return { messages, memoryAccessEnvelope, assistantName: name ?? profile?.name ?? "Nautilo", soulFile: profile?.soulFile ?? "",
      ...(completeExposure ? { modelExposureDependencies: dependencies } : {}) };
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

  private async lockClaim(tx: Tx, claim: MemoryReviewClaim): Promise<Turn[]> {
    const turns = await tx.select().from(memoryReviewTurns).where(inArray(memoryReviewTurns.id, claim.turnIds)).orderBy(memoryReviewTurns.id).for("update");
    if (turns.length !== claim.turnIds.length || turns.some((turn) => turn.attemptId !== claim.attemptId || turn.receiptId || !turn.leaseUntil || turn.leaseUntil <= new Date())) throw new Error("lease_lost");
    if (JSON.stringify(turns.flatMap((turn) => turn.sourceIds).sort((a,b) => a-b)) !== JSON.stringify(claim.sourceIds)) throw new MemoryReviewError("source_changed");
    return turns;
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
      const recovery = input.claim.modelRecovery !== undefined;
      await tx.update(memoryReviewTurns).set({
        failurePhase: recovery ? "model" : input.phase,
        failureCode: recovery ? "provider_outcome_unknown" : input.reason,
        leaseUntil: null,
        // Ordinary uncertain publication can reconcile the receipt. An explicit
        // recovery stays spent and cannot be automatically re-dispatched.
        retryAt: !recovery && (input.retryable || input.reason === "publication_uncertain")
          ? new Date(input.now.getTime() + this.policy.retryMs) : null,
        updatedAt: input.now,
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
            OR (t.generation_id=r.work_id AND (
              t.failure_code='publication_uncertain'
              OR (t.receipt_id IS NULL AND r.outcome='failed' AND r.phase='model'
                AND (r.code=ANY(${sql.param([...KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES])}::text[])
                  OR (r.id=t.attempt_id AND r.code=t.failure_code
                    AND r.code=ANY(${sql.param([...AUTOMATIC_MODEL_CHANGE_FAILURES])}::text[]))))
            )))
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
