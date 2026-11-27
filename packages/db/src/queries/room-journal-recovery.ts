import {
  and,
  asc,
  eq,
  exists,
  gt,
  isNull,
  ne,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import {
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalModelRecoveries,
  roomJournalState,
  type StenographerCompactionAcceptedPlan,
} from "../schema/room-journal";
import { roomMembers, rooms } from "../schema/rooms";
import { actors } from "../schema/trust";
import { acquireRoomWriteLock } from "./room-lock";
import { ROOM_JOURNAL_EXTRACTOR_VERSION } from "./room-journal-state";
import { hasOnlyRefusedServiceAttempts } from "./model-attempt-replay-safety";

export interface RoomJournalServiceModelRebindInput {
  readonly roomId: string;
  readonly batchId: string;
  readonly expectedRebuildGeneration: number;
  readonly expectedAttemptCount: number;
  readonly expectedCurrentModelId: string;
  readonly modelId: string;
  readonly now?: Date;
}

export type RoomJournalServiceModelRebindBlockedReason =
  | "ineligible_room"
  | "batch_not_failed"
  | "batch_not_current"
  | "binding_not_service"
  | "model_unchanged"
  | "rebuild_pending"
  | "lease_active"
  | "crypto_publication_exists"
  | "attempt_outcome_not_refused"
  | "manual_recovery_exists"
  | "plan_not_current";

export interface RoomJournalCompactionServiceModelRebindInput {
  readonly roomId: string;
  readonly expectedRebuildGeneration: number;
  readonly expectedFailureAttempt: number;
  readonly expectedCurrentModelId: string;
  readonly expectedOperationId: string;
  readonly modelId: string;
  readonly now?: Date;
}

type OrdinaryCompactionPlan = Extract<
  StenographerCompactionAcceptedPlan,
  { owner: "ordinary" }
>;

export type CurrentOrdinaryCompactionPlanGuard = (
  tx: RecoveryTransaction,
  input: Readonly<{ roomId: string; plan: OrdinaryCompactionPlan }>,
) => Promise<boolean>;

export type RebindRoomJournalServiceModelResult =
  | Readonly<{ status: "queued"; rebuildGeneration: number }>
  | Readonly<{ status: "stale"; rebuildGeneration: number | null }>
  | Readonly<{
      status: "blocked";
      reason: RoomJournalServiceModelRebindBlockedReason;
      rebuildGeneration: number;
    }>;

type RecoveryTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

/**
 * Canonical journal invalidation transition shared with transcript mutations.
 * It intentionally changes no cursor or derived content row.
 */
export async function requestRoomJournalRebuildInTx(
  tx: Pick<RecoveryTransaction, "insert">,
  roomId: string,
  requestedAt: Date,
): Promise<void> {
  await tx.insert(roomJournalState).values({
    roomId,
    lastProcessedMessageId: 0,
    extractorVersion: ROOM_JOURNAL_EXTRACTOR_VERSION,
    rebuildGeneration: 1,
    rebuildRequestedAt: requestedAt,
    rebuildTargetMessageId: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  }).onConflictDoUpdate({
    target: roomJournalState.roomId,
    set: {
      rebuildGeneration: sql`${roomJournalState.rebuildGeneration} + 1`,
      rebuildRequestedAt: requestedAt,
      rebuildTargetMessageId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      compactionLeaseToken: null,
      compactionLeaseExpiresAt: null,
      updatedAt: requestedAt,
    },
  });
}

interface ServiceModelRebindCandidate {
  readonly rebuildGeneration: number;
  readonly binding: MemoryOperationBinding;
}

type ServiceModelCandidateResult =
  | Readonly<{ status: "candidate"; value: ServiceModelRebindCandidate }>
  | Readonly<{
      status: "blocked";
      reason: RoomJournalServiceModelRebindBlockedReason | "not_found" | "stale";
      rebuildGeneration: number | null;
    }>;

async function serviceModelRebindCandidate(
  db: RecoveryTransaction,
  input: RoomJournalServiceModelRebindInput,
  now: Date,
): Promise<ServiceModelCandidateResult> {
  const [state] = await db.select({
    roomKind: rooms.kind,
    archivedAt: rooms.archivedAt,
    suspendedAt: roomJournalState.suspendedAt,
    hasAgent: exists(
      db.select({ one: sql`1` }).from(roomMembers)
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(and(
          eq(roomMembers.roomId, rooms.id),
          eq(actors.kind, "agent"),
        )),
    ).mapWith(Boolean),
    rebuildGeneration: roomJournalState.rebuildGeneration,
    rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
    rebuildTargetMessageId: roomJournalState.rebuildTargetMessageId,
    lastProcessedMessageId: roomJournalState.lastProcessedMessageId,
    historicalBackfillStatus: roomJournalState.historicalBackfillStatus,
    historicalBackfillCursorMessageId:
      roomJournalState.historicalBackfillCursorMessageId,
    extractionLeaseActive: and(
      isNotNull(roomJournalState.leaseToken),
      gt(roomJournalState.leaseExpiresAt, now),
    )!.mapWith(Boolean),
    compactionLeaseActive: and(
      isNotNull(roomJournalState.compactionLeaseToken),
      gt(roomJournalState.compactionLeaseExpiresAt, now),
    )!.mapWith(Boolean),
    conversionLeaseActive: and(
      isNotNull(roomJournalState.recordConversionLeaseToken),
      gt(roomJournalState.recordConversionLeaseExpiresAt, now),
    )!.mapWith(Boolean),
    extractionAttemptRunning: exists(
      db.select({ one: sql`1` }).from(roomJournalBatches).where(and(
        eq(roomJournalBatches.roomId, roomJournalState.roomId),
        eq(roomJournalBatches.status, "running"),
      )),
    ).mapWith(Boolean),
  }).from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(eq(roomJournalState.roomId, input.roomId))
    .limit(1).for("update", { of: roomJournalState });
  if (!state) {
    return {
      status: "blocked",
      reason: "not_found",
      rebuildGeneration: null,
    };
  }
  if (state.rebuildGeneration !== input.expectedRebuildGeneration) {
    return {
      status: "blocked",
      reason: "stale",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (
    state.roomKind === "task"
    || state.roomKind === "access"
    || state.archivedAt !== null
    || state.suspendedAt !== null
    || !state.hasAgent
  ) {
    return {
      status: "blocked",
      reason: "ineligible_room",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (state.rebuildRequestedAt !== null && state.rebuildTargetMessageId === null) {
    return {
      status: "blocked",
      reason: "rebuild_pending",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (
    state.extractionLeaseActive
    || state.compactionLeaseActive
    || state.conversionLeaseActive
    || state.extractionAttemptRunning
  ) {
    return {
      status: "blocked",
      reason: "lease_active",
      rebuildGeneration: state.rebuildGeneration,
    };
  }

  const [batch] = await db.select({
    roomId: roomJournalBatches.roomId,
    lane: roomJournalBatches.lane,
    status: roomJournalBatches.status,
    attemptCount: roomJournalBatches.attemptCount,
    acceptedModelBinding: roomJournalBatches.acceptedModelBinding,
    modelId: roomJournalBatches.modelId,
    errorCode: roomJournalBatches.errorCode,
    lastErrorAttempt: roomJournalBatches.lastErrorAttempt,
    lastErrorModelId: roomJournalBatches.lastErrorModelId,
    startedAt: roomJournalBatches.startedAt,
    fromMessageIdExclusive: roomJournalBatches.fromMessageIdExclusive,
    throughMessageIdInclusive: roomJournalBatches.throughMessageIdInclusive,
  }).from(roomJournalBatches).where(and(
    eq(roomJournalBatches.id, input.batchId),
    eq(roomJournalBatches.roomId, input.roomId),
  )).limit(1).for("update", { of: roomJournalBatches });
  if (!batch) {
    return {
      status: "blocked",
      reason: "not_found",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (batch.attemptCount !== input.expectedAttemptCount) {
    return {
      status: "blocked",
      reason: "stale",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (
    batch.status !== "failed"
    || batch.errorCode !== "provider"
    || batch.lastErrorAttempt !== batch.attemptCount
    || batch.startedAt === null
  ) {
    return {
      status: "blocked",
      reason: "batch_not_failed",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  const currentLaneCursor = batch.lane === "live"
    ? state.lastProcessedMessageId
    : state.historicalBackfillStatus === "pending"
      ? state.historicalBackfillCursorMessageId
      : null;
  if (
    currentLaneCursor === null
    || batch.fromMessageIdExclusive !== currentLaneCursor
    || (state.rebuildRequestedAt !== null && (batch.lane !== "live"
      || batch.throughMessageIdInclusive > state.rebuildTargetMessageId!))
  ) {
    return {
      status: "blocked",
      reason: "batch_not_current",
      rebuildGeneration: state.rebuildGeneration,
    };
  }

  let binding: MemoryOperationBinding;
  try {
    binding = parseMemoryOperationBinding(batch.acceptedModelBinding);
  } catch {
    return {
      status: "blocked",
      reason: "binding_not_service",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (
    binding.kind !== "service"
    || binding.role !== "memorySummarization"
  ) {
    return {
      status: "blocked",
      reason: "binding_not_service",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (binding.modelId !== input.expectedCurrentModelId) {
    return {
      status: "blocked",
      reason: "stale",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (
    binding.modelId !== batch.modelId
    || binding.modelId !== batch.lastErrorModelId
  ) {
    return {
      status: "blocked",
      reason: "binding_not_service",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (binding.modelId === input.modelId) {
    return {
      status: "blocked",
      reason: "model_unchanged",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  const [publication] = await db.select({
    id: roomJournalCryptoPublications.publicationId,
  }).from(roomJournalCryptoPublications).where(and(
    eq(roomJournalCryptoPublications.roomId, input.roomId),
    eq(roomJournalCryptoPublications.sourceBatchId, input.batchId),
  )).limit(1);
  if (publication) {
    return {
      status: "blocked",
      reason: "crypto_publication_exists",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  if (!await hasOnlyRefusedServiceAttempts([{
    kind: "operation",
    roomId: input.roomId,
    callType: "room_stenographer",
    operationId: input.batchId,
  }], db, {
    modelId: binding.modelId,
    occurredAtOrAfter: batch.startedAt,
  })) {
    return {
      status: "blocked",
      reason: "attempt_outcome_not_refused",
      rebuildGeneration: state.rebuildGeneration,
    };
  }
  return {
    status: "candidate",
    value: { rebuildGeneration: state.rebuildGeneration, binding },
  };
}

/**
 * Rebind only the service model for an exact failed extraction batch. The
 * commitment, batch identity, attempt history, and scheduler ownership remain
 * unchanged.
 */
export async function rebindRoomJournalFailedBatchServiceModel(
  db: Pick<DirectDatabase, "select" | "update" | "transaction">,
  input: RoomJournalServiceModelRebindInput,
): Promise<RebindRoomJournalServiceModelResult> {
  if (input.modelId.trim() !== input.modelId || input.modelId.length === 0) {
    return { status: "stale", rebuildGeneration: null };
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await acquireRoomWriteLock(tx, input.roomId);
    const result = await serviceModelRebindCandidate(tx, input, now);
    if (result.status !== "candidate") {
      if (result.reason === "not_found" || result.reason === "stale") {
        return {
          status: "stale",
          rebuildGeneration: result.rebuildGeneration,
        };
      }
      return {
        status: "blocked",
        reason: result.reason,
        rebuildGeneration: result.rebuildGeneration!,
      };
    }
    const binding: MemoryOperationBinding = {
      ...result.value.binding,
      modelId: input.modelId,
    };
    const updated = await tx.update(roomJournalBatches).set({
      acceptedModelBinding: binding,
    }).where(and(
      eq(roomJournalBatches.id, input.batchId),
      eq(roomJournalBatches.roomId, input.roomId),
      eq(roomJournalBatches.status, "failed"),
      eq(roomJournalBatches.attemptCount, input.expectedAttemptCount),
    )).returning({ id: roomJournalBatches.id });
    if (updated.length !== 1) {
      return {
        status: "stale",
        rebuildGeneration: result.value.rebuildGeneration,
      };
    }
    await tx.update(roomJournalState).set({
      extractionRetryAfter: null,
      updatedAt: now,
    }).where(and(
      eq(roomJournalState.roomId, input.roomId),
      eq(roomJournalState.rebuildGeneration, result.value.rebuildGeneration),
    ));
    return {
      status: "queued",
      rebuildGeneration: result.value.rebuildGeneration,
    };
  });
}

function ordinaryCompactionPlan(value: unknown): OrdinaryCompactionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const selected = row["selectedEventIds"];
  const protectedTail = row["protectedTailEventIds"];
  if (row["version"] !== 1 || row["owner"] !== "ordinary"
    || typeof row["operationId"] !== "string" || row["operationId"].length === 0
    || !Number.isSafeInteger(row["rebuildGeneration"])
    || !(row["previousRollupId"] === null || typeof row["previousRollupId"] === "string")
    || !Array.isArray(selected)
    || !Array.isArray(protectedTail)
    || [...selected as readonly unknown[], ...protectedTail as readonly unknown[]]
      .some(id => typeof id !== "string" || id.length === 0)) return null;
  return value as OrdinaryCompactionPlan;
}

/**
 * Rebind one exact refused service-funded compaction without replacing its
 * accepted source plan, failure coordinates, or any operator recovery grant.
 */
export async function rebindRoomJournalFailedCompactionServiceModel(
  db: Pick<DirectDatabase, "select" | "update" | "transaction">,
  input: RoomJournalCompactionServiceModelRebindInput,
  currentPlan: CurrentOrdinaryCompactionPlanGuard,
): Promise<RebindRoomJournalServiceModelResult> {
  if (!input.modelId || input.modelId.trim() !== input.modelId) {
    return { status: "stale", rebuildGeneration: null };
  }
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    await acquireRoomWriteLock(tx, input.roomId);
    const agentMember = tx.select({ one: sql`1` }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(roomMembers.roomId, rooms.id),
        eq(actors.kind, "agent"),
      ));
    const [state] = await tx.select({
      roomKind: rooms.kind,
      archivedAt: rooms.archivedAt,
      suspendedAt: roomJournalState.suspendedAt,
      hasAgent: exists(agentMember).mapWith(Boolean),
      rebuildGeneration: roomJournalState.rebuildGeneration,
      rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
      compactionDueAt: roomJournalState.compactionDueAt,
      binding: roomJournalState.compactionAcceptedModelBinding,
      plan: roomJournalState.compactionAcceptedPlan,
      failureCount: roomJournalState.compactionFailureCount,
      errorCode: roomJournalState.lastCompactionErrorCode,
      errorAt: roomJournalState.lastCompactionErrorAt,
      errorAttempt: roomJournalState.lastCompactionErrorAttempt,
      errorModelId: roomJournalState.lastCompactionErrorModelId,
      extractionLeaseActive: and(
        isNotNull(roomJournalState.leaseToken),
        gt(roomJournalState.leaseExpiresAt, now),
      )!.mapWith(Boolean),
      compactionLeaseActive: and(
        isNotNull(roomJournalState.compactionLeaseToken),
        gt(roomJournalState.compactionLeaseExpiresAt, now),
      )!.mapWith(Boolean),
      conversionLeaseActive: and(
        isNotNull(roomJournalState.recordConversionLeaseToken),
        gt(roomJournalState.recordConversionLeaseExpiresAt, now),
      )!.mapWith(Boolean),
      extractionAttemptRunning: exists(
        tx.select({ one: sql`1` }).from(roomJournalBatches).where(and(
          eq(roomJournalBatches.roomId, roomJournalState.roomId),
          eq(roomJournalBatches.status, "running"),
        )),
      ).mapWith(Boolean),
    }).from(roomJournalState)
      .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
      .where(eq(roomJournalState.roomId, input.roomId))
      .limit(1).for("update", { of: roomJournalState });
    if (!state) return { status: "stale", rebuildGeneration: null };
    if (state.rebuildGeneration !== input.expectedRebuildGeneration
      || state.failureCount !== input.expectedFailureAttempt
      || state.errorAttempt !== input.expectedFailureAttempt) {
      return { status: "stale", rebuildGeneration: state.rebuildGeneration };
    }
    if (state.roomKind === "task" || state.roomKind === "access"
      || state.archivedAt !== null || state.suspendedAt !== null || !state.hasAgent) {
      return { status: "blocked", reason: "ineligible_room", rebuildGeneration: state.rebuildGeneration };
    }
    if (state.rebuildRequestedAt !== null || state.compactionDueAt === null) {
      return { status: "blocked", reason: "rebuild_pending", rebuildGeneration: state.rebuildGeneration };
    }
    if (state.extractionLeaseActive || state.compactionLeaseActive
      || state.conversionLeaseActive || state.extractionAttemptRunning) {
      return { status: "blocked", reason: "lease_active", rebuildGeneration: state.rebuildGeneration };
    }
    if (state.errorCode !== "provider" || state.errorAt === null
      || state.errorModelId !== input.expectedCurrentModelId) {
      return { status: "blocked", reason: "batch_not_failed", rebuildGeneration: state.rebuildGeneration };
    }
    let binding: MemoryOperationBinding;
    try {
      binding = parseMemoryOperationBinding(state.binding);
    } catch {
      return { status: "blocked", reason: "binding_not_service", rebuildGeneration: state.rebuildGeneration };
    }
    const plan = ordinaryCompactionPlan(state.plan);
    if (binding.kind !== "service" || binding.role !== "memorySummarization"
      || binding.modelId !== input.expectedCurrentModelId || plan === null
      || plan.operationId !== input.expectedOperationId
      || plan.rebuildGeneration !== state.rebuildGeneration) {
      return { status: "blocked", reason: "binding_not_service", rebuildGeneration: state.rebuildGeneration };
    }
    if (binding.modelId === input.modelId) {
      return { status: "blocked", reason: "model_unchanged", rebuildGeneration: state.rebuildGeneration };
    }
    const [manualRecovery] = await tx.select({ id: roomJournalModelRecoveries.id })
      .from(roomJournalModelRecoveries).where(and(
        eq(roomJournalModelRecoveries.roomId, input.roomId),
        eq(roomJournalModelRecoveries.workKind, "compaction"),
        eq(roomJournalModelRecoveries.workId, plan.operationId),
        eq(roomJournalModelRecoveries.rebuildGeneration, state.rebuildGeneration),
        isNull(roomJournalModelRecoveries.spentAt),
      )).limit(1).for("update", { of: roomJournalModelRecoveries });
    if (manualRecovery) {
      return { status: "blocked", reason: "manual_recovery_exists", rebuildGeneration: state.rebuildGeneration };
    }
    if (!await hasOnlyRefusedServiceAttempts([{
      kind: "operation",
      roomId: input.roomId,
      callType: "room_event_compaction",
      operationId: plan.operationId,
    }], tx, { modelId: binding.modelId, occurredAtOrBefore: state.errorAt })) {
      return { status: "blocked", reason: "attempt_outcome_not_refused", rebuildGeneration: state.rebuildGeneration };
    }
    if (!await currentPlan(tx, { roomId: input.roomId, plan })) {
      return { status: "blocked", reason: "plan_not_current", rebuildGeneration: state.rebuildGeneration };
    }
    const [updated] = await tx.update(roomJournalState).set({
      compactionAcceptedModelBinding: { ...binding, modelId: input.modelId },
      compactionRetryAfter: null,
      updatedAt: now,
    }).where(and(
      eq(roomJournalState.roomId, input.roomId),
      eq(roomJournalState.rebuildGeneration, state.rebuildGeneration),
      eq(roomJournalState.compactionFailureCount, input.expectedFailureAttempt),
      eq(roomJournalState.lastCompactionErrorAttempt, input.expectedFailureAttempt),
      eq(roomJournalState.lastCompactionErrorModelId, input.expectedCurrentModelId),
    )).returning({ roomId: roomJournalState.roomId });
    return updated
      ? { status: "queued", rebuildGeneration: state.rebuildGeneration }
      : { status: "stale", rebuildGeneration: state.rebuildGeneration };
  });
}

/** Scan refused service compactions; the mutator rechecks every coordinate under lock. */
export async function readRoomJournalCompactionServiceRecoveryPage(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ modelId: string; after?: string; limit: number }>,
): Promise<Omit<RoomJournalCompactionServiceModelRebindInput, "modelId" | "now">[]> {
  const oldModel = sql<string>`${roomJournalState.compactionAcceptedModelBinding}->>'modelId'`;
  const operationId = sql<string>`${roomJournalState.compactionAcceptedPlan}->>'operationId'`;
  return db.select({
    roomId: roomJournalState.roomId,
    expectedRebuildGeneration: roomJournalState.rebuildGeneration,
    expectedFailureAttempt: sql<number>`${roomJournalState.lastCompactionErrorAttempt}`,
    expectedCurrentModelId: oldModel,
    expectedOperationId: operationId,
  }).from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(and(
      isNotNull(roomJournalState.compactionDueAt),
      isNull(roomJournalState.rebuildRequestedAt),
      eq(roomJournalState.lastCompactionErrorCode, "provider"),
      eq(roomJournalState.lastCompactionErrorAttempt, roomJournalState.compactionFailureCount),
      eq(roomJournalState.lastCompactionErrorModelId, oldModel),
      eq(sql<string>`${roomJournalState.compactionAcceptedModelBinding}->>'kind'`, "service"),
      eq(sql<string>`${roomJournalState.compactionAcceptedModelBinding}->>'role'`, "memorySummarization"),
      eq(sql<string>`${roomJournalState.compactionAcceptedPlan}->>'owner'`, "ordinary"),
      ne(oldModel, input.modelId),
      isNull(rooms.archivedAt),
      isNull(roomJournalState.suspendedAt),
      input.after === undefined ? undefined : gt(roomJournalState.roomId, input.after),
    )).orderBy(asc(roomJournalState.roomId)).limit(input.limit);
}

/** Scan current failed batches only. The rebind rechecks the exact coordinates under lock. */
export async function readRoomJournalServiceRecoveryPage(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ modelId: string; after?: string; limit: number }>,
): Promise<Omit<RoomJournalServiceModelRebindInput, "modelId" | "now">[]> {
  const oldModel = sql<string>`${roomJournalBatches.acceptedModelBinding}->>'modelId'`;
  return db.select({
    roomId: roomJournalBatches.roomId,
    batchId: roomJournalBatches.id,
    expectedRebuildGeneration: roomJournalState.rebuildGeneration,
    expectedAttemptCount: roomJournalBatches.attemptCount,
    expectedCurrentModelId: oldModel,
  }).from(roomJournalBatches)
    .innerJoin(roomJournalState, eq(roomJournalState.roomId, roomJournalBatches.roomId))
    .innerJoin(rooms, eq(rooms.id, roomJournalBatches.roomId))
    .where(and(
      eq(roomJournalBatches.status, "failed"),
      eq(roomJournalBatches.errorCode, "provider"),
      eq(roomJournalBatches.lastErrorAttempt, roomJournalBatches.attemptCount),
      eq(roomJournalBatches.lastErrorModelId, oldModel),
      eq(sql<string>`${roomJournalBatches.acceptedModelBinding}->>'kind'`, "service"),
      ne(oldModel, input.modelId),
      isNull(rooms.archivedAt),
      isNull(roomJournalState.suspendedAt),
      or(
        and(
          eq(roomJournalBatches.lane, "live"),
          eq(roomJournalBatches.fromMessageIdExclusive, roomJournalState.lastProcessedMessageId),
          or(isNull(roomJournalState.rebuildRequestedAt), isNotNull(roomJournalState.rebuildTargetMessageId)),
        ),
        and(
          eq(roomJournalBatches.lane, "historical"),
          eq(roomJournalState.historicalBackfillStatus, "pending"),
          eq(roomJournalBatches.fromMessageIdExclusive, roomJournalState.historicalBackfillCursorMessageId),
          isNull(roomJournalState.rebuildRequestedAt),
        ),
      ),
      input.after === undefined ? undefined : gt(roomJournalBatches.id, input.after),
    )).orderBy(asc(roomJournalBatches.id)).limit(input.limit);
}
