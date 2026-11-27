import {
  acquireRoomWriteLock,
  acquireEncryptionConsumptionFence,
  actors,
  and,
  asc,
  eq,
  exists,
  isNotNull,
  isNull,
  llmUsageEvents,
  lte,
  or,
  roomEvents,
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalModelRecoveries,
  roomJournalState,
  roomMembers,
  rooms,
  sql,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { parseMemoryOperationBinding } from "@nautilo/types";

export interface ManualJournalRecoveryInput {
  readonly db: ManualJournalRecoveryDatabase;
  readonly now: Date;
  readonly observedThrough: Date;
  readonly authorizedBy: string;
  readonly modelId: string;
}

export type ManualJournalRecoveryDatabase = Pick<
  DirectDatabase,
  "transaction"
>;

type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export interface ManualJournalRecoveryResult {
  readonly queued: number;
  readonly held: number;
}

export function classifyManualJournalRecoveryRequest(input: Readonly<{
  failureAt: Date;
  observedThrough: Date;
  now: Date;
  prior: "none" | "pending" | "spent";
}>): "queue" | "duplicate" | "hold" {
  if (input.failureAt > input.observedThrough || input.failureAt > input.now) {
    return "hold";
  }
  if (input.prior === "pending") return "duplicate";
  if (input.prior === "spent") return "hold";
  return "queue";
}

type Candidate = Readonly<{
  roomId: string;
  workKind: "extraction" | "compaction";
  workId: string;
  sourceBatchId: string | null;
  rebuildGeneration: number;
  observedAttempt: number;
  observedFailureAt: Date;
}>;

function serviceBinding(value: unknown) {
  try {
    const binding = parseMemoryOperationBinding(value);
    return binding.kind === "service" && binding.role === "memorySummarization"
      ? binding
      : null;
  } catch {
    return null;
  }
}

async function hasOnlyServiceAttempts(
  tx: Pick<DirectDatabase, "select">,
  candidate: Candidate,
): Promise<boolean> {
  const rows = await tx.select({
    fundingKind: llmUsageEvents.fundingKind,
    payerHumanId: llmUsageEvents.payerHumanId,
  }).from(llmUsageEvents).where(and(
    eq(llmUsageEvents.roomId, candidate.roomId),
    eq(
      llmUsageEvents.callType,
      candidate.workKind === "extraction"
        ? "room_stenographer"
        : "room_event_compaction",
    ),
    eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, candidate.workId),
  ));
  return rows.length > 0 && rows.every((row) =>
    (row.fundingKind === "service" || row.fundingKind === "server")
    && row.payerHumanId === null);
}

async function queueCandidate(
  tx: Transaction,
  candidate: Candidate,
  input: Omit<ManualJournalRecoveryInput, "db">,
): Promise<"queued" | "held" | "duplicate" | "progressing"> {
  const encryption = await acquireEncryptionConsumptionFence(tx);
  if (encryption.mode !== "plaintext_only") return "held";
  await acquireRoomWriteLock(tx, candidate.roomId);
    const agentMember = tx.select({ one: sql`1` }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(roomMembers.roomId, rooms.id),
        eq(actors.kind, "agent"),
      ));
    const [state] = await tx.select({
      kind: rooms.kind,
      archivedAt: rooms.archivedAt,
      suspendedAt: roomJournalState.suspendedAt,
      rebuildGeneration: roomJournalState.rebuildGeneration,
      rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
      rebuildTargetMessageId: roomJournalState.rebuildTargetMessageId,
      lastProcessedMessageId: roomJournalState.lastProcessedMessageId,
      historicalBackfillStatus: roomJournalState.historicalBackfillStatus,
      historicalBackfillCursorMessageId: roomJournalState.historicalBackfillCursorMessageId,
      leaseToken: roomJournalState.leaseToken,
      leaseExpiresAt: roomJournalState.leaseExpiresAt,
      compactionLeaseToken: roomJournalState.compactionLeaseToken,
      compactionLeaseExpiresAt: roomJournalState.compactionLeaseExpiresAt,
      conversionLeaseToken: roomJournalState.recordConversionLeaseToken,
      conversionLeaseExpiresAt: roomJournalState.recordConversionLeaseExpiresAt,
      hasAgent: exists(agentMember).mapWith(Boolean),
      compactionBinding: roomJournalState.compactionAcceptedModelBinding,
      compactionPlan: roomJournalState.compactionAcceptedPlan,
      compactionFailureCount: roomJournalState.compactionFailureCount,
      compactionErrorCode: roomJournalState.lastCompactionErrorCode,
      compactionErrorAt: roomJournalState.lastCompactionErrorAt,
      compactionErrorAttempt: roomJournalState.lastCompactionErrorAttempt,
      compactionErrorModelId: roomJournalState.lastCompactionErrorModelId,
    }).from(roomJournalState)
      .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
      .where(eq(roomJournalState.roomId, candidate.roomId))
      .limit(1).for("update", { of: roomJournalState });
    if (!state
      || state.rebuildGeneration !== candidate.rebuildGeneration
      || state.kind === "task" || state.kind === "access"
      || state.archivedAt !== null || state.suspendedAt !== null
      || !state.hasAgent) return "held";
    const extractionActive = state.leaseToken !== null
      && state.leaseExpiresAt !== null && state.leaseExpiresAt > input.now;
    const compactionActive = state.compactionLeaseToken !== null
      && state.compactionLeaseExpiresAt !== null
      && state.compactionLeaseExpiresAt > input.now;
    const conversionActive = state.conversionLeaseToken !== null
      && state.conversionLeaseExpiresAt !== null
      && state.conversionLeaseExpiresAt > input.now;
    if (extractionActive || compactionActive || conversionActive) return "progressing";

    let binding: ReturnType<typeof serviceBinding>;
    let failureAt: Date | null;
    let failureModelId: string | null;
    if (candidate.workKind === "extraction") {
      const [batch] = await tx.select({
        status: roomJournalBatches.status,
        attemptCount: roomJournalBatches.attemptCount,
        acceptedModelBinding: roomJournalBatches.acceptedModelBinding,
        errorCode: roomJournalBatches.errorCode,
        lastErrorAt: roomJournalBatches.lastErrorAt,
        lastErrorAttempt: roomJournalBatches.lastErrorAttempt,
        lastErrorModelId: roomJournalBatches.lastErrorModelId,
        startedAt: roomJournalBatches.startedAt,
        fromMessageIdExclusive: roomJournalBatches.fromMessageIdExclusive,
        throughMessageIdInclusive: roomJournalBatches.throughMessageIdInclusive,
        lane: roomJournalBatches.lane,
      }).from(roomJournalBatches).where(and(
        eq(roomJournalBatches.id, candidate.workId),
        eq(roomJournalBatches.roomId, candidate.roomId),
      )).limit(1).for("update", { of: roomJournalBatches });
      if (!batch || batch.status !== "failed"
        || (batch.errorCode !== "provider_outcome_unknown"
          && batch.errorCode !== "invalid_output")
        || batch.attemptCount !== candidate.observedAttempt
        || batch.lastErrorAttempt !== candidate.observedAttempt
        || batch.lastErrorAt?.getTime() !== candidate.observedFailureAt.getTime()
        || batch.lastErrorModelId === null) return "held";
      if (batch.errorCode === "invalid_output") {
        const [spentRecovery] = batch.startedAt === null || batch.lastErrorAt === null
          ? []
          : await tx.select({ id: roomJournalModelRecoveries.id })
              .from(roomJournalModelRecoveries)
              .where(and(
                eq(roomJournalModelRecoveries.roomId, candidate.roomId),
                eq(roomJournalModelRecoveries.workKind, "extraction"),
                eq(roomJournalModelRecoveries.workId, candidate.workId),
                eq(roomJournalModelRecoveries.rebuildGeneration, candidate.rebuildGeneration),
                eq(roomJournalModelRecoveries.targetModelId, batch.lastErrorModelId),
                eq(roomJournalModelRecoveries.claimedAt, batch.startedAt),
                isNotNull(roomJournalModelRecoveries.claimLeaseToken),
                isNotNull(roomJournalModelRecoveries.spentAt),
                lte(roomJournalModelRecoveries.spentAt, batch.lastErrorAt),
              ))
              .limit(1)
              .for("update", { of: roomJournalModelRecoveries });
        if (!spentRecovery) return "held";
      }
      binding = serviceBinding(batch.acceptedModelBinding);
      failureAt = batch.lastErrorAt;
      failureModelId = batch.lastErrorModelId;
      const currentCursor = batch.lane === "live"
        ? state.lastProcessedMessageId
        : state.historicalBackfillStatus === "pending"
          ? state.historicalBackfillCursorMessageId
          : null;
      if (currentCursor === null || batch.fromMessageIdExclusive !== currentCursor
        || (state.rebuildRequestedAt !== null
          && state.rebuildTargetMessageId !== null
          && batch.throughMessageIdInclusive > state.rebuildTargetMessageId)) {
        return "held";
      }
      const [publication] = await tx.select({ id: roomEvents.id })
        .from(roomEvents).where(eq(roomEvents.sourceBatchId, candidate.workId)).limit(1);
      const [cryptoPublication] = await tx.select({
        id: roomJournalCryptoPublications.publicationId,
      }).from(roomJournalCryptoPublications).where(eq(
        roomJournalCryptoPublications.sourceBatchId,
        candidate.workId,
      )).limit(1);
      if (publication || cryptoPublication) return "held";
      if (state.rebuildRequestedAt !== null
        && (state.rebuildTargetMessageId === null || batch.lane !== "live")) {
        return "held";
      }
    } else {
      const plan = state.compactionPlan;
      if (state.rebuildRequestedAt !== null
        || (state.compactionErrorCode !== "provider_outcome_unknown"
          && state.compactionErrorCode !== "invalid_output")
        || state.compactionFailureCount !== candidate.observedAttempt
        || state.compactionErrorAttempt !== candidate.observedAttempt
        || state.compactionErrorAt?.getTime() !== candidate.observedFailureAt.getTime()
        || state.compactionErrorModelId === null
        || plan === null || plan.owner !== "ordinary"
        || plan.operationId !== candidate.workId
        || plan.rebuildGeneration !== state.rebuildGeneration) return "held";
      if (state.compactionErrorCode === "invalid_output") {
        const [spentRecovery] = state.compactionErrorAt === null
          || state.compactionErrorModelId === null
          || state.compactionErrorAttempt === null
          || state.compactionErrorAttempt < 1
          ? []
          : await tx.select({ id: roomJournalModelRecoveries.id })
              .from(roomJournalModelRecoveries)
              .where(and(
                eq(roomJournalModelRecoveries.roomId, candidate.roomId),
                eq(roomJournalModelRecoveries.workKind, "compaction"),
                eq(roomJournalModelRecoveries.workId, candidate.workId),
                eq(roomJournalModelRecoveries.rebuildGeneration, candidate.rebuildGeneration),
                eq(roomJournalModelRecoveries.observedAttempt, state.compactionErrorAttempt - 1),
                eq(roomJournalModelRecoveries.targetModelId, state.compactionErrorModelId),
                isNotNull(roomJournalModelRecoveries.claimLeaseToken),
                isNotNull(roomJournalModelRecoveries.spentAt),
                lte(roomJournalModelRecoveries.spentAt, state.compactionErrorAt),
              ))
              .limit(1)
              .for("update", { of: roomJournalModelRecoveries });
        if (!spentRecovery) return "held";
      }
      binding = serviceBinding(state.compactionBinding);
      failureAt = state.compactionErrorAt;
      failureModelId = state.compactionErrorModelId;
      const [cryptoPublication] = await tx.select({
        id: roomJournalCryptoPublications.publicationId,
      }).from(roomJournalCryptoPublications).where(eq(
        roomJournalCryptoPublications.workId,
        candidate.workId,
      )).limit(1);
      if (cryptoPublication) return "held";
    }
    if (failureAt === null || binding === null
      || binding.modelId !== failureModelId
      || !await hasOnlyServiceAttempts(tx, candidate)) return "held";

    const [prior] = await tx.select({
      spentAt: roomJournalModelRecoveries.spentAt,
    }).from(roomJournalModelRecoveries).where(and(
      eq(roomJournalModelRecoveries.roomId, candidate.roomId),
      eq(roomJournalModelRecoveries.workKind, candidate.workKind),
      eq(roomJournalModelRecoveries.workId, candidate.workId),
      eq(roomJournalModelRecoveries.rebuildGeneration, candidate.rebuildGeneration),
      eq(roomJournalModelRecoveries.observedAttempt, candidate.observedAttempt),
    )).limit(1).for("update", { of: roomJournalModelRecoveries });
    const classification = classifyManualJournalRecoveryRequest({
      failureAt,
      observedThrough: input.observedThrough,
      now: input.now,
      prior: prior === undefined ? "none"
        : prior.spentAt === null ? "pending" : "spent",
    });
    if (classification !== "queue") {
      return classification === "duplicate" ? "duplicate" : "held";
    }
    await tx.insert(roomJournalModelRecoveries).values({
      roomId: candidate.roomId,
      workKind: candidate.workKind,
      workId: candidate.workId,
      sourceBatchId: candidate.sourceBatchId,
      rebuildGeneration: candidate.rebuildGeneration,
      observedAttempt: candidate.observedAttempt,
      observedFailureAt: candidate.observedFailureAt,
      observedThrough: input.observedThrough,
      targetModelId: input.modelId,
      authorizedBy: input.authorizedBy,
      authorizedAt: input.now,
    });
  return "queued";
}

/**
 * Queue one fresh, possibly billable service attempt for each exact Journal
 * hold observed by the operator. Healthy and actively progressing work is not
 * counted; every candidate is rechecked under its Room lock.
 */
export async function requestManualJournalRecovery(
  input: ManualJournalRecoveryInput,
): Promise<ManualJournalRecoveryResult> {
  if (!input.modelId.trim() || input.modelId.trim() !== input.modelId
    || input.observedThrough > input.now) return { queued: 0, held: 0 };
  return input.db.transaction(async (tx) => {
    const [authorizer] = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.id, input.authorizedBy),
      isNull(users.disabledAt),
    )).limit(1);
    if (!authorizer) throw new Error("Journal recovery authorizer is unavailable");
    const spentExtractionRecovery = tx.select({ one: sql`1` })
      .from(roomJournalModelRecoveries)
      .where(and(
        eq(roomJournalModelRecoveries.roomId, roomJournalBatches.roomId),
        eq(roomJournalModelRecoveries.workKind, "extraction"),
        eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalBatches.id}::text`),
        eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
        eq(roomJournalModelRecoveries.targetModelId, roomJournalBatches.lastErrorModelId),
        eq(roomJournalModelRecoveries.claimedAt, roomJournalBatches.startedAt),
        isNotNull(roomJournalModelRecoveries.claimLeaseToken),
        isNotNull(roomJournalModelRecoveries.spentAt),
        lte(roomJournalModelRecoveries.spentAt, roomJournalBatches.lastErrorAt),
      ));
    const extraction = await tx.select({
    roomId: roomJournalBatches.roomId,
    workId: roomJournalBatches.id,
    rebuildGeneration: roomJournalState.rebuildGeneration,
    observedAttempt: roomJournalBatches.attemptCount,
    observedFailureAt: roomJournalBatches.lastErrorAt,
  }).from(roomJournalBatches)
    .innerJoin(roomJournalState, eq(roomJournalState.roomId, roomJournalBatches.roomId))
    .where(and(
      eq(roomJournalBatches.status, "failed"),
      or(
        eq(roomJournalBatches.errorCode, "provider_outcome_unknown"),
        and(
          eq(roomJournalBatches.errorCode, "invalid_output"),
          exists(spentExtractionRecovery),
        ),
      ),
      eq(roomJournalBatches.lastErrorAttempt, roomJournalBatches.attemptCount),
      lte(roomJournalBatches.lastErrorAt, input.observedThrough),
    )).orderBy(asc(roomJournalBatches.roomId), asc(roomJournalBatches.id));
    const spentCompactionRecovery = tx.select({ one: sql`1` })
      .from(roomJournalModelRecoveries)
      .where(and(
        eq(roomJournalModelRecoveries.roomId, roomJournalState.roomId),
        eq(roomJournalModelRecoveries.workKind, "compaction"),
        eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
        eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalState.compactionAcceptedPlan}->>'operationId'`),
        eq(roomJournalModelRecoveries.observedAttempt, sql<number>`${roomJournalState.lastCompactionErrorAttempt} - 1`),
        eq(roomJournalModelRecoveries.targetModelId, roomJournalState.lastCompactionErrorModelId),
        isNotNull(roomJournalModelRecoveries.claimLeaseToken),
        isNotNull(roomJournalModelRecoveries.spentAt),
        lte(roomJournalModelRecoveries.spentAt, roomJournalState.lastCompactionErrorAt),
      ));
    const compaction = await tx.select({
    roomId: roomJournalState.roomId,
    rebuildGeneration: roomJournalState.rebuildGeneration,
    observedAttempt: roomJournalState.compactionFailureCount,
    observedFailureAt: roomJournalState.lastCompactionErrorAt,
    plan: roomJournalState.compactionAcceptedPlan,
  }).from(roomJournalState).where(and(
    or(
      eq(roomJournalState.lastCompactionErrorCode, "provider_outcome_unknown"),
      and(
        eq(roomJournalState.lastCompactionErrorCode, "invalid_output"),
        exists(spentCompactionRecovery),
      ),
    ),
    eq(roomJournalState.lastCompactionErrorAttempt, roomJournalState.compactionFailureCount),
    lte(roomJournalState.lastCompactionErrorAt, input.observedThrough),
  )).orderBy(asc(roomJournalState.roomId));
    const candidates: Candidate[] = [
    ...extraction.flatMap((row) => row.observedFailureAt === null ? [] : [{
      roomId: row.roomId, workKind: "extraction" as const, workId: row.workId,
      sourceBatchId: row.workId, rebuildGeneration: row.rebuildGeneration,
      observedAttempt: row.observedAttempt, observedFailureAt: row.observedFailureAt,
    }]),
    ...compaction.flatMap((row) => row.observedFailureAt === null || row.plan === null ? [] : [{
      roomId: row.roomId, workKind: "compaction" as const, workId: row.plan.operationId,
      sourceBatchId: null, rebuildGeneration: row.rebuildGeneration,
      observedAttempt: row.observedAttempt, observedFailureAt: row.observedFailureAt,
    }]),
  ];
    let queued = 0;
    let held = 0;
    for (const candidate of candidates) {
      const outcome = await queueCandidate(tx, candidate, input);
      if (outcome === "queued") queued += 1;
      else if (outcome === "held") held += 1;
    }
    return { queued, held };
  });
}
