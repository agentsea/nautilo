import {
  and,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import {
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalState,
} from "../schema/room-journal";
import { roomMembers, rooms } from "../schema/rooms";
import { actors } from "../schema/trust";
import { acquireRoomWriteLock } from "./room-lock";
import { ROOM_JOURNAL_EXTRACTOR_VERSION } from "./room-journal-state";
import { hasOnlyRefusedServiceAttempts } from "./model-attempt-replay-safety";

export type RoomJournalRecoveryBlockedReason =
  | "room_not_found"
  | "stale_generation"
  | "stale_cursor"
  | "ineligible_room"
  | "suspended"
  | "archived"
  | "rebuild_running"
  | "extraction_leased"
  | "compaction_leased"
  | "conversion_leased"
  | "provider_outcome_unknown"
  | "extraction_attempt_running"
  | "protected_publication_exists";

export interface RoomJournalRecoveryFailedBatch {
  readonly id: string;
  readonly lane: "live" | "historical";
  readonly modelId: string | null;
  readonly status: "failed";
  readonly errorCode: string | null;
  readonly attemptCount: number;
  readonly lastErrorAt: Date | null;
  readonly lastErrorAttempt: number | null;
  readonly lastErrorModelId: string | null;
}

/** Content-free operational metadata for exact Room Journal recovery. */
export interface RoomJournalRecoveryMetadata {
  readonly roomId: string;
  readonly rebuildGeneration: number;
  readonly lastProcessedMessageId: number;
  readonly rebuildRequestedAt: Date | null;
  readonly rebuildTargetMessageId: number | null;
  readonly lastExtractionCompletedAt: Date | null;
  readonly lastExtractionErrorCode: string | null;
  readonly lastExtractionErrorAt: Date | null;
  readonly lastCompactionCompletedAt: Date | null;
  readonly lastCompactionErrorCode: string | null;
  readonly lastCompactionErrorAt: Date | null;
  readonly lastCompactionErrorAttempt: number | null;
  readonly lastCompactionErrorModelId: string | null;
  readonly latestUnfinishedFailedExtractionBatch:
    | RoomJournalRecoveryFailedBatch
    | null;
}

export type RoomJournalRecoveryPreview =
  | Readonly<{ status: "allowed"; rebuildGeneration: number }>
  | Readonly<{
      status: "blocked";
      reason: RoomJournalRecoveryBlockedReason;
      rebuildGeneration: number | null;
    }>;

export type QueueRoomJournalRecoveryResult =
  | Readonly<{
      status: "queued" | "already_queued" | "stale";
      rebuildGeneration: number | null;
    }>
  | Readonly<{
      status: "blocked";
      reason: Exclude<
        RoomJournalRecoveryBlockedReason,
        "room_not_found" | "stale_generation" | "stale_cursor"
      >;
      rebuildGeneration: number;
    }>;

export interface RoomJournalRecoveryInput {
  readonly roomId: string;
  readonly expectedRebuildGeneration: number;
  readonly expectedCursor?: number;
  readonly now?: Date;
}

export interface RoomJournalServiceModelRebindInput {
  readonly roomId: string;
  readonly batchId: string;
  readonly expectedRebuildGeneration: number;
  readonly expectedAttemptCount: number;
  readonly expectedCurrentModelId: string;
  readonly modelId: string;
  readonly now?: Date;
}

export type RoomJournalServiceModelRebindPreviewInput = Omit<
  RoomJournalServiceModelRebindInput,
  "modelId" | "expectedCurrentModelId"
> & Readonly<{ modelId?: string; expectedCurrentModelId?: string }>;

export type RoomJournalServiceModelRebindBlockedReason =
  | "ineligible_room"
  | "batch_not_failed"
  | "batch_not_current"
  | "binding_not_service"
  | "model_unchanged"
  | "rebuild_pending"
  | "lease_active"
  | "crypto_publication_exists"
  | "attempt_outcome_not_refused";

export type RoomJournalServiceModelRebindPreview =
  | Readonly<{
      status: "allowed";
      rebuildGeneration: number;
      currentModelId: string;
    }>
  | Readonly<{
      status: "blocked";
      reason: RoomJournalServiceModelRebindBlockedReason | "not_found" | "stale";
      rebuildGeneration: number | null;
    }>;

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

type RecoveryDatabase = Pick<
  DirectDatabase,
  "select" | "insert" | "transaction"
>;

interface RecoverySnapshot extends RoomJournalRecoveryMetadata {
  readonly roomKind: string;
  readonly archivedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly historicalBackfillStatus: "pending" | "completed" | "not_needed";
  readonly historicalBackfillCursorMessageId: number | null;
  readonly hasAgent: boolean;
  readonly extractionLeased: boolean;
  readonly compactionLeased: boolean;
  readonly conversionLeased: boolean;
  readonly providerOutcomeUnknown: boolean;
  readonly extractionAttemptRunning: boolean;
  readonly protectedPublicationExists: boolean;
}

function recoverySubqueries(db: Pick<DirectDatabase, "select">) {
  const agentMember = db.select({ one: sql`1` })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(
      eq(roomMembers.roomId, rooms.id),
      eq(actors.kind, "agent"),
    ));
  const unknownBatch = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, roomJournalState.roomId),
      eq(roomJournalBatches.status, "failed"),
      eq(roomJournalBatches.errorCode, "provider_outcome_unknown"),
    ));
  const runningBatch = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, roomJournalState.roomId),
      eq(roomJournalBatches.status, "running"),
    ));
  const protectedPublication = db.select({ one: sql`1` })
    .from(roomJournalCryptoPublications)
    .where(eq(roomJournalCryptoPublications.roomId, roomJournalState.roomId));
  return {
    agentMember,
    unknownBatch,
    runningBatch,
    protectedPublication,
  };
}

async function readSnapshot(
  db: Pick<DirectDatabase, "select">,
  roomId: string,
  now: Date,
  lockState: boolean,
): Promise<RecoverySnapshot | null> {
  const subqueries = recoverySubqueries(db);
  const query = db.select({
    roomId: roomJournalState.roomId,
    roomKind: rooms.kind,
    archivedAt: rooms.archivedAt,
    suspendedAt: roomJournalState.suspendedAt,
    historicalBackfillStatus: roomJournalState.historicalBackfillStatus,
    historicalBackfillCursorMessageId:
      roomJournalState.historicalBackfillCursorMessageId,
    hasAgent: exists(subqueries.agentMember).mapWith(Boolean),
    rebuildGeneration: roomJournalState.rebuildGeneration,
    lastProcessedMessageId: roomJournalState.lastProcessedMessageId,
    rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
    rebuildTargetMessageId: roomJournalState.rebuildTargetMessageId,
    lastExtractionCompletedAt: roomJournalState.lastExtractionCompletedAt,
    lastExtractionErrorCode: roomJournalState.lastExtractionErrorCode,
    lastExtractionErrorAt: roomJournalState.lastExtractionErrorAt,
    lastCompactionCompletedAt: roomJournalState.lastCompactionCompletedAt,
    lastCompactionErrorCode: roomJournalState.lastCompactionErrorCode,
    lastCompactionErrorAt: roomJournalState.lastCompactionErrorAt,
    lastCompactionErrorAttempt: roomJournalState.lastCompactionErrorAttempt,
    lastCompactionErrorModelId: roomJournalState.lastCompactionErrorModelId,
    extractionLeased: and(
      isNotNull(roomJournalState.leaseToken),
      gt(roomJournalState.leaseExpiresAt, now),
    )!.mapWith(Boolean),
    compactionLeased: and(
      isNotNull(roomJournalState.compactionLeaseToken),
      gt(roomJournalState.compactionLeaseExpiresAt, now),
    )!.mapWith(Boolean),
    conversionLeased: and(
      isNotNull(roomJournalState.recordConversionLeaseToken),
      gt(roomJournalState.recordConversionLeaseExpiresAt, now),
    )!.mapWith(Boolean),
    providerOutcomeUnknown: or(
      eq(roomJournalState.lastExtractionErrorCode, "provider_outcome_unknown"),
      eq(roomJournalState.lastCompactionErrorCode, "provider_outcome_unknown"),
      exists(subqueries.unknownBatch),
    )!.mapWith(Boolean),
    extractionAttemptRunning: exists(subqueries.runningBatch).mapWith(Boolean),
    protectedPublicationExists:
      exists(subqueries.protectedPublication).mapWith(Boolean),
  }).from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(eq(roomJournalState.roomId, roomId))
    .limit(1);
  const rows = lockState
    ? await query.for("update", { of: roomJournalState })
    : await query;
  const state = rows[0];
  if (!state) return null;

  const failedBatch = await db.select({
    id: roomJournalBatches.id,
    lane: roomJournalBatches.lane,
    modelId: roomJournalBatches.modelId,
    status: roomJournalBatches.status,
    errorCode: roomJournalBatches.errorCode,
    attemptCount: roomJournalBatches.attemptCount,
    lastErrorAt: roomJournalBatches.lastErrorAt,
    lastErrorAttempt: roomJournalBatches.lastErrorAttempt,
    lastErrorModelId: roomJournalBatches.lastErrorModelId,
  }).from(roomJournalBatches).where(and(
    eq(roomJournalBatches.roomId, roomId),
    eq(roomJournalBatches.status, "failed"),
    or(
      and(
        eq(roomJournalBatches.lane, "live"),
        eq(
          roomJournalBatches.fromMessageIdExclusive,
          state.lastProcessedMessageId,
        ),
      ),
      and(
        eq(roomJournalBatches.lane, "historical"),
        state.historicalBackfillCursorMessageId === null
          ? sql`false`
          : eq(
              roomJournalBatches.fromMessageIdExclusive,
              state.historicalBackfillCursorMessageId,
            ),
        state.historicalBackfillStatus === "pending" ? sql`true` : sql`false`,
      ),
    ),
  )).orderBy(
    desc(roomJournalBatches.createdAt),
    desc(roomJournalBatches.id),
  ).limit(1);

  const latest = failedBatch[0];
  return {
    ...state,
    latestUnfinishedFailedExtractionBatch: latest
      ? {
          ...latest,
          status: "failed",
        }
      : null,
  };
}

function metadata(snapshot: RecoverySnapshot): RoomJournalRecoveryMetadata {
  return {
    roomId: snapshot.roomId,
    rebuildGeneration: snapshot.rebuildGeneration,
    lastProcessedMessageId: snapshot.lastProcessedMessageId,
    rebuildRequestedAt: snapshot.rebuildRequestedAt,
    rebuildTargetMessageId: snapshot.rebuildTargetMessageId,
    lastExtractionCompletedAt: snapshot.lastExtractionCompletedAt,
    lastExtractionErrorCode: snapshot.lastExtractionErrorCode,
    lastExtractionErrorAt: snapshot.lastExtractionErrorAt,
    lastCompactionCompletedAt: snapshot.lastCompactionCompletedAt,
    lastCompactionErrorCode: snapshot.lastCompactionErrorCode,
    lastCompactionErrorAt: snapshot.lastCompactionErrorAt,
    lastCompactionErrorAttempt: snapshot.lastCompactionErrorAttempt,
    lastCompactionErrorModelId: snapshot.lastCompactionErrorModelId,
    latestUnfinishedFailedExtractionBatch:
      snapshot.latestUnfinishedFailedExtractionBatch,
  };
}

function blockedReason(
  snapshot: RecoverySnapshot,
): Exclude<
  RoomJournalRecoveryBlockedReason,
  "room_not_found" | "stale_generation" | "stale_cursor"
> | null {
  if (snapshot.roomKind === "task" || snapshot.roomKind === "access" || !snapshot.hasAgent) {
    return "ineligible_room";
  }
  if (snapshot.suspendedAt !== null) return "suspended";
  if (snapshot.archivedAt !== null) return "archived";
  if (snapshot.rebuildTargetMessageId !== null) return "rebuild_running";
  if (snapshot.extractionLeased) return "extraction_leased";
  if (snapshot.compactionLeased) return "compaction_leased";
  if (snapshot.conversionLeased) return "conversion_leased";
  if (snapshot.providerOutcomeUnknown) return "provider_outcome_unknown";
  if (snapshot.extractionAttemptRunning) return "extraction_attempt_running";
  if (snapshot.protectedPublicationExists) return "protected_publication_exists";
  return null;
}

export async function readRoomJournalRecoveryMetadata(
  db: Pick<DirectDatabase, "select">,
  roomId: string,
): Promise<RoomJournalRecoveryMetadata | null> {
  const snapshot = await readSnapshot(db, roomId, new Date(), false);
  return snapshot === null ? null : metadata(snapshot);
}

export async function previewRoomJournalRecovery(
  db: Pick<DirectDatabase, "select">,
  input: RoomJournalRecoveryInput,
): Promise<RoomJournalRecoveryPreview> {
  const snapshot = await readSnapshot(db, input.roomId, input.now ?? new Date(), false);
  if (snapshot === null) {
    return { status: "blocked", reason: "room_not_found", rebuildGeneration: null };
  }
  if (snapshot.rebuildGeneration !== input.expectedRebuildGeneration) {
    return {
      status: "blocked",
      reason: "stale_generation",
      rebuildGeneration: snapshot.rebuildGeneration,
    };
  }
  if (
    input.expectedCursor !== undefined
    && snapshot.lastProcessedMessageId !== input.expectedCursor
  ) {
    return {
      status: "blocked",
      reason: "stale_cursor",
      rebuildGeneration: snapshot.rebuildGeneration,
    };
  }
  const reason = blockedReason(snapshot);
  return reason === null
    ? { status: "allowed", rebuildGeneration: snapshot.rebuildGeneration }
    : { status: "blocked", reason, rebuildGeneration: snapshot.rebuildGeneration };
}

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

/** Queue a whole-Room rebuild without taking scheduler dispatch ownership. */
export async function queueRoomJournalRecovery(
  db: RecoveryDatabase,
  input: RoomJournalRecoveryInput,
): Promise<QueueRoomJournalRecoveryResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await acquireRoomWriteLock(tx, input.roomId);
    const snapshot = await readSnapshot(tx, input.roomId, now, true);
    if (snapshot === null) return { status: "stale", rebuildGeneration: null };
    if (snapshot.rebuildGeneration !== input.expectedRebuildGeneration) {
      return { status: "stale", rebuildGeneration: snapshot.rebuildGeneration };
    }
    if (
      input.expectedCursor !== undefined
      && snapshot.lastProcessedMessageId !== input.expectedCursor
    ) {
      return { status: "stale", rebuildGeneration: snapshot.rebuildGeneration };
    }
    const reason = blockedReason(snapshot);
    if (reason !== null) {
      return {
        status: "blocked",
        reason,
        rebuildGeneration: snapshot.rebuildGeneration,
      };
    }
    if (snapshot.rebuildRequestedAt !== null) {
      return {
        status: "already_queued",
        rebuildGeneration: snapshot.rebuildGeneration,
      };
    }
    await requestRoomJournalRebuildInTx(
      tx,
      input.roomId,
      now,
    );
    return { status: "queued", rebuildGeneration: snapshot.rebuildGeneration + 1 };
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
  db: Pick<DirectDatabase, "select">,
  input: RoomJournalServiceModelRebindPreviewInput,
  now: Date,
  lock: boolean,
): Promise<ServiceModelCandidateResult> {
  const stateQuery = db.select({
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
    .limit(1);
  const stateRows = lock
    ? await stateQuery.for("update", { of: roomJournalState })
    : await stateQuery;
  const state = stateRows[0];
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
  if (state.rebuildRequestedAt !== null) {
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

  const batchQuery = db.select({
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
  }).from(roomJournalBatches).where(and(
    eq(roomJournalBatches.id, input.batchId),
    eq(roomJournalBatches.roomId, input.roomId),
  )).limit(1);
  const batchRows = lock
    ? await batchQuery.for("update", { of: roomJournalBatches })
    : await batchQuery;
  const batch = batchRows[0];
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
  if (
    input.expectedCurrentModelId !== undefined
    && binding.modelId !== input.expectedCurrentModelId
  ) {
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
  if (input.modelId !== undefined && binding.modelId === input.modelId) {
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

/** Read-only exact eligibility check for a service-funded model rebind. */
export async function previewRoomJournalServiceModelRebind(
  db: Pick<DirectDatabase, "select">,
  input: RoomJournalServiceModelRebindPreviewInput,
): Promise<RoomJournalServiceModelRebindPreview> {
  if (
    input.modelId !== undefined
    && (input.modelId.trim() !== input.modelId || input.modelId.length === 0)
  ) {
    return { status: "blocked", reason: "binding_not_service", rebuildGeneration: null };
  }
  const result = await serviceModelRebindCandidate(
    db,
    input,
    input.now ?? new Date(),
    false,
  );
  return result.status === "candidate"
    ? {
        status: "allowed",
        rebuildGeneration: result.value.rebuildGeneration,
        currentModelId: result.value.binding.modelId,
      }
    : result;
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
    const result = await serviceModelRebindCandidate(tx, input, now, true);
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
