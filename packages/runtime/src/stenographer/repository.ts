import { createHash, randomUUID } from "node:crypto";
import {
  actors,
  and,
  asc,
  desc,
  eq,
  exists,
  getSharedDirectDb,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  resolveFreshCompactionAttemptReplaySafety,
  resolveModelAttemptReplaySafety,
  roomMembers,
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalModelRecoveries,
  roomJournalState,
  rooms,
  sessionMessages,
  sessions,
  sql,
  type DirectDatabase,
  type StenographerCompactionAcceptedPlan,
} from "@nautilo/db";
import { parseMemoryOperationBinding } from "@nautilo/types";
import {
  planStenographerBatch,
  type StenographerBatchPlan,
  type StenographerSourceRow,
} from "./batch-planner";
import type {
  EffectiveRoomEvent,
  RoomEventKind,
  RoomEventRollupView,
} from "./types";
import {
  EVENT_COMPACTION_INPUT_MAX_CHARS,
  EVENT_COMPACTION_PROTECTED_TAIL,
  planJournalCompaction,
  type JournalCompactionPlan,
} from "@nautilo/reflection";
import { compactionModelExposureDependencies } from "./semantic-adapter";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import {
  stenographerJournalEventObservationFingerprint,
  stenographerJournalRollupObservationFingerprint,
} from "@nautilo/reflection-bridge/server";
import {
  encodeRoomEventRollupPayloadV1,
  stenographerOrdinaryOutputFingerprint,
} from "@nautilo/lattice-bridge";

export type StenographerErrorCode =
  | "provider"
  | "provider_outcome_unknown"
  | "input_authority_unavailable"
  | "timeout"
  | "invalid_output"
  | "input_too_large"
  | "lease_lost"
  | "persistence"
  | "unknown";

export interface ClaimedSourceRow extends StenographerSourceRow {
  displayLabel: string;
  /** Absent only from legacy/test claims that cannot prove exact exposure. */
  editRevision?: number;
}

export interface ExtractionClaim {
  batchId: string;
  roomId: string;
  ownerId: string;
  leaseToken: string;
  attemptCount: number;
  /** Durable job state proves the previous provider result was rejected before publication. */
  previousModelResultKnownNonusable?: true;
  lane: "live" | "historical";
  plan: StenographerBatchPlan;
  /** Previously processed same-lane rows; context-only and never citable. */
  priorContextRows: ClaimedSourceRow[];
  sourceRows: ClaimedSourceRow[];
  latestRollup: RoomEventRollupView | null;
  visibleEvents: EffectiveRoomEvent[];
  namespaceId?: string;
  /** M230 — CAS token for an edit-triggered full Room rebuild. */
  rebuildGeneration?: number | null;
  /** One operator-approved fresh service call, spent by the funding boundary. */
  manualModelRecoveryId?: string;
  manualRecoveryModelId?: string;
}

export interface CompactionClaim {
  roomId: string;
  ownerId: string;
  leaseToken: string;
  attemptCount: number;
  modelOperationId: string;
  acceptedPlan: Extract<
    StenographerCompactionAcceptedPlan,
    { owner: "ordinary" }
  >;
  plan: JournalCompactionPlan<EffectiveRoomEvent>;
  namespaceId?: string;
  /** Exact rollup view used by the prompt; absent on legacy/test claims. */
  previousRollup?: RoomEventRollupView | null;
  /** One operator-approved fresh service call, spent by the funding boundary. */
  manualModelRecoveryId?: string;
  manualRecoveryModelId?: string;
  requiresCurrentServicePayer?: true;
}

function acceptedOrdinaryCompactionPlan(
  value: unknown,
): Extract<
  StenographerCompactionAcceptedPlan,
  { owner: "ordinary" }
> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Accepted Stenographer compaction plan is malformed");
  }
  const row = value as Record<string, unknown>;
  const keys = [
    "version",
    "owner",
    "operationId",
    "rebuildGeneration",
    "previousRollupId",
    "selectedEventIds",
    "protectedTailEventIds",
  ];
  const ids = [row["selectedEventIds"], row["protectedTailEventIds"]];
  if (
    Object.keys(row).length !== keys.length
    || keys.some((key) => !(key in row))
    || row["version"] !== 1
    || row["owner"] !== "ordinary"
    || typeof row["operationId"] !== "string"
    || row["operationId"].length === 0
    || !Number.isSafeInteger(row["rebuildGeneration"])
    || Number(row["rebuildGeneration"]) < 0
    || !(row["previousRollupId"] === null
      || typeof row["previousRollupId"] === "string")
    || ids.some((value) =>
      !Array.isArray(value)
      || value.length > EVENT_COMPACTION_INPUT_MAX_CHARS
      || value.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(value).size !== value.length
    )
    || (row["protectedTailEventIds"] as readonly unknown[]).length
      > EVENT_COMPACTION_PROTECTED_TAIL
  ) {
    throw new TypeError("Accepted Stenographer compaction plan is malformed");
  }
  return Object.freeze({
    version: 1,
    owner: "ordinary",
    operationId: row["operationId"],
    rebuildGeneration: Number(row["rebuildGeneration"]),
    previousRollupId: row["previousRollupId"],
    selectedEventIds: Object.freeze([
      ...(row["selectedEventIds"] as readonly string[]),
    ]),
    protectedTailEventIds: Object.freeze([
      ...(row["protectedTailEventIds"] as readonly string[]),
    ]),
  });
}

function currentAcceptedOrdinaryCompactionPlan(input: Readonly<{
  acceptedPlan: Extract<StenographerCompactionAcceptedPlan, { owner: "ordinary" }>;
  rebuildGeneration: number;
  latestRollup: RoomEventRollupView | null;
  allEvents: readonly EffectiveRoomEvent[];
}>): ReturnType<typeof planJournalCompaction<EffectiveRoomEvent>> | null {
  const eventById = new Map(input.allEvents.map(event => [event.id, event]));
  const frozenEvents = [
    ...input.acceptedPlan.selectedEventIds,
    ...input.acceptedPlan.protectedTailEventIds,
  ].map(id => eventById.get(id));
  if (input.acceptedPlan.rebuildGeneration !== input.rebuildGeneration
    || input.acceptedPlan.previousRollupId !== (input.latestRollup?.id ?? null)
    || frozenEvents.some(event => event === undefined)) return null;
  const planned = planJournalCompaction({
    events: frozenEvents as EffectiveRoomEvent[],
    rollups: input.latestRollup ? [input.latestRollup] : [],
    forceDue: true,
  });
  if (!planned.ok || !planned.plan) return planned;
  if (JSON.stringify(planned.plan.selectedEvents.map(event => event.id))
      !== JSON.stringify(input.acceptedPlan.selectedEventIds)
    || JSON.stringify(planned.plan.protectedTail.map(event => event.id))
      !== JSON.stringify(input.acceptedPlan.protectedTailEventIds)) return null;
  return planned;
}

interface StateRow {
  room_id: string;
  owner_id: string;
  kind: string;
  last_processed_message_id: number | string;
  suspended_at: string | Date | null;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  extraction_retry_after: string | Date | null;
  has_agent: boolean;
  upper_bound_message_id: number | string | null;
  replay_batch_id: string | null;
  replay_batch_status: "completed" | "failed" | "running" | null;
  replay_batch_error_code: string | null;
  replay_batch_attempt_count: number | string | null;
  replay_batch_started_at: string | Date | null;
  replay_batch_last_error_at: string | Date | null;
  replay_batch_last_error_model_id: string | null;
  replay_through_message_id: number | string | null;
  historical_backfill_status: "pending" | "completed" | "not_needed";
  historical_backfill_cursor_message_id: number | string | null;
  historical_backfill_target_message_id: number | string | null;
  stenographer_prior_conversation_limit: number | string;
  prior_context_floor_message_id: number | string;
  rebuild_generation: number | string;
  rebuild_requested_at: string | Date | null;
  rebuild_target_message_id: number | string | null;
  namespace_id: string;
}

interface SourceDbRow {
  id: number | string;
  created_at: string | Date;
  role: string;
  content: string | null;
  fingerprint: string | null;
  transcript_origin: string;
  originated_by: string | null;
  display_name: string | null;
  handle: string | null;
  excluded_from_evidence: boolean;
  edit_revision?: number | string;
}

class StenographerSourceRepresentationUnavailableError extends Error {}

interface EventRow {
  id: string;
  room_id: string;
  sequence: number | string;
  kind: RoomEventKind;
  statement: string | null;
  status: "active" | "superseded" | "resolved";
  supersedes_event_id: string | null;
  resolves_event_id: string | null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

type JournalExecutor = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

function asNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`unsafe integer returned by journal query: ${String(value)}`);
  }
  return parsed;
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function canonicalModelExposureDependencies(
  dependencies: readonly DurableModelExposureDependency[] | null | undefined,
): string | null {
  if (dependencies === null || dependencies === undefined) return null;
  return JSON.stringify([...dependencies]
    .sort((left, right) => {
      const leftKey = left.kind === "record"
        ? `record\u0000${left.recordRef}`
        : `source\u0000${left.sourceKind}\u0000${left.logicalSourceRef}`;
      const rightKey = right.kind === "record"
        ? `record\u0000${right.recordRef}`
        : `source\u0000${right.sourceKind}\u0000${right.logicalSourceRef}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((dependency) => dependency.kind === "record"
      ? [
          "record",
          dependency.recordRef,
          dependency.observedProcessingGeneration,
          [...dependency.terminalAuthorityLeafHandles].sort(),
        ]
      : [
          "source",
          dependency.sourceKind,
          dependency.logicalSourceRef,
          dependency.observedRevision ?? null,
          dependency.observedContentFingerprint ?? null,
          dependency.terminalAuthorityLeafHandle,
        ]));
}

function rollupPayloadExposureDependencies(
  dependencies: readonly DurableModelExposureDependency[],
) {
  return dependencies.map((dependency) => dependency.kind === "record"
    ? {
        kind: "record" as const,
        recordId: dependency.recordRef,
        observedProcessingGeneration:
          dependency.observedProcessingGeneration,
        terminalAuthorityLeafHandles:
          dependency.terminalAuthorityLeafHandles,
      }
    : {
        kind: "source" as const,
        sourceKind: dependency.sourceKind,
        logicalObjectRef: dependency.logicalSourceRef,
        observedRevision: dependency.observedRevision ?? null,
        observedContentFingerprint:
          dependency.observedContentFingerprint ?? null,
        terminalAuthorityLeafHandle:
          dependency.terminalAuthorityLeafHandle,
      });
}

function eventStatement(row: EventRow): string {
  if (typeof row.statement !== "string") {
    throw new Error("selected Journal event representation is unavailable");
  }
  return row.statement;
}

function timestampParam(value: Date): string {
  return value.toISOString();
}

function dbLabel(row: SourceDbRow): string {
  const name = row.display_name?.trim() || "Unknown participant";
  const handle = row.handle?.trim();
  return handle ? `${name} (@${handle})` : name;
}

function sourceRole(role: string): StenographerSourceRow["role"] {
  return role === "user" || role === "assistant" || role === "tool"
    ? role
    : "system";
}

function claimedSourceRow(row: SourceDbRow): ClaimedSourceRow {
  if (row.content === null) {
    throw new StenographerSourceRepresentationUnavailableError(
      "Stenographer source representation is unavailable",
    );
  }
  return {
    id: asNumber(row.id),
    createdAt: asDate(row.created_at),
    role: sourceRole(row.role),
    text: row.content,
    fingerprint: row.fingerprint,
    eligibleSource:
      row.transcript_origin === "main" &&
      row.originated_by !== "task" &&
      (row.role === "user" || row.role === "assistant" || row.role === "tool"),
    excludedFromEvidence: row.excluded_from_evidence,
    displayLabel: dbLabel(row),
    ...(row.edit_revision === undefined
      ? {}
      : { editRevision: asNumber(row.edit_revision) }),
  };
}

export async function candidateRoomIds(
  db: DirectDatabase,
  now: Date,
  limit = 20,
): Promise<string[]> {
  const manualRecovery = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalBatches.roomId),
      eq(roomJournalModelRecoveries.workKind, "extraction"),
      eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalBatches.id}::text`),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.observedAttempt, roomJournalBatches.attemptCount),
      isNull(roomJournalModelRecoveries.spentAt),
    ));
  const spentManualInvalidOutput = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalBatches.roomId),
      eq(roomJournalModelRecoveries.workKind, "extraction"),
      eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalBatches.id}::text`),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.targetModelId, roomJournalBatches.lastErrorModelId),
      eq(roomJournalModelRecoveries.claimedAt, roomJournalBatches.startedAt),
      isNotNull(roomJournalModelRecoveries.spentAt),
      lte(roomJournalModelRecoveries.spentAt, roomJournalBatches.lastErrorAt),
    ));
  const failedRetry = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, roomJournalState.roomId),
      eq(roomJournalBatches.lane, "live"),
      eq(
        roomJournalBatches.fromMessageIdExclusive,
        roomJournalState.lastProcessedMessageId,
      ),
      eq(roomJournalBatches.status, "failed"),
    ));
  const blockedFailedAttempt = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, roomJournalState.roomId),
      eq(roomJournalBatches.lane, "live"),
      eq(
        roomJournalBatches.fromMessageIdExclusive,
        roomJournalState.lastProcessedMessageId,
      ),
      eq(roomJournalBatches.status, "failed"),
      or(
        eq(roomJournalBatches.errorCode, "provider_outcome_unknown"),
        and(
          eq(roomJournalBatches.errorCode, "invalid_output"),
          exists(spentManualInvalidOutput),
        ),
      ),
      notExists(manualRecovery),
    ));
  const agentMember = db.select({ one: sql`1` })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(
      eq(roomMembers.roomId, rooms.id),
      eq(actors.kind, "agent"),
    ));
  const pendingMessage = db.select({ one: sql`1` })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .where(and(
      eq(sessions.roomId, rooms.id),
      gt(sessionMessages.id, roomJournalState.lastProcessedMessageId),
    ));
  const replayBatch = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, rooms.id),
      eq(
        roomJournalBatches.fromMessageIdExclusive,
        roomJournalState.lastProcessedMessageId,
      ),
      inArray(roomJournalBatches.status, ["completed", "failed"]),
    ));
  const result = await db.select({ room_id: roomJournalState.roomId })
    .from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(and(
      notInArray(rooms.kind, ["task", "access"]),
      isNull(roomJournalState.rebuildRequestedAt),
      isNull(roomJournalState.suspendedAt),
      notExists(blockedFailedAttempt),
      or(
        isNull(roomJournalState.extractionRetryAfter),
        lte(roomJournalState.extractionRetryAfter, now),
        notExists(failedRetry),
      ),
      or(
        isNull(roomJournalState.leaseToken),
        isNull(roomJournalState.leaseExpiresAt),
        lte(roomJournalState.leaseExpiresAt, now),
      ),
      exists(agentMember),
      or(exists(pendingMessage), exists(replayBatch)),
    ))
    .orderBy(
      sql`COALESCE(
        ${roomJournalState.extractionRetryAfter},
        ${roomJournalState.updatedAt}
      )`,
      roomJournalState.roomId,
    )
    .limit(limit);
  return result.map((row) => row.room_id);
}

/**
 * Lazily seeds the historical range for rows that existed when the generated
 * migration added `historical_backfill_status DEFAULT 'pending'`.
 *
 * The lower bound is the first currently-present Agent membership: Human-only
 * history remains private. The target is the original live cursor, recovered
 * from the first live batch when live processing has already advanced.
 */
export async function initializeHistoricalBackfills(
  opts: { now?: Date; db?: DirectDatabase } = {},
): Promise<void> {
  const db = opts.db ?? getSharedDirectDb();
  const now = opts.now ?? new Date();
  await db.execute(sql`
    WITH eligible AS (
      SELECT
        rjs.room_id,
        COALESCE((
          SELECT MAX(sm.id)
          FROM sessions s
          INNER JOIN session_messages sm ON sm.session_id = s.id
          WHERE s.room_id = rjs.room_id
            AND sm.created_at <= (
              SELECT MIN(rm.joined_at)
              FROM room_members rm
              INNER JOIN actors a ON a.id = rm.actor_id
              WHERE rm.room_id = rjs.room_id
                AND a.kind = 'agent'
            )
        ), 0)::integer AS start_cursor,
        COALESCE((
          SELECT MIN(rjb.from_message_id_exclusive)
          FROM room_journal_batches rjb
          WHERE rjb.room_id = rjs.room_id
            AND rjb.lane = 'live'
        ), rjs.last_processed_message_id)::integer AS target_cursor
      FROM room_journal_state rjs
      INNER JOIN rooms r ON r.id = rjs.room_id
      WHERE rjs.historical_backfill_status = 'pending'
        AND rjs.historical_backfill_cursor_message_id IS NULL
        AND r.kind NOT IN ('task', 'access')
        AND EXISTS (
          SELECT 1
          FROM room_members rm
          INNER JOIN actors a ON a.id = rm.actor_id
          WHERE rm.room_id = r.id
            AND a.kind = 'agent'
        )
    )
    UPDATE room_journal_state rjs
    SET
      historical_backfill_cursor_message_id = LEAST(e.start_cursor, e.target_cursor),
      historical_backfill_target_message_id = e.target_cursor,
      historical_backfill_status = CASE
        WHEN e.start_cursor >= e.target_cursor THEN 'completed'
        ELSE 'pending'
      END,
      historical_backfill_completed_at = CASE
        WHEN e.start_cursor >= e.target_cursor
          THEN ${timestampParam(now)}::timestamptz
        ELSE NULL
      END,
      updated_at = ${timestampParam(now)}
    FROM eligible e
    WHERE rjs.room_id = e.room_id
  `);
}

export async function historicalCandidateRoomIds(
  db: DirectDatabase,
  now: Date,
  limit = 20,
): Promise<string[]> {
  const manualRecovery = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalBatches.roomId),
      eq(roomJournalModelRecoveries.workKind, "extraction"),
      eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalBatches.id}::text`),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.observedAttempt, roomJournalBatches.attemptCount),
      isNull(roomJournalModelRecoveries.spentAt),
    ));
  const spentManualInvalidOutput = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalBatches.roomId),
      eq(roomJournalModelRecoveries.workKind, "extraction"),
      eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalBatches.id}::text`),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.targetModelId, roomJournalBatches.lastErrorModelId),
      eq(roomJournalModelRecoveries.claimedAt, roomJournalBatches.startedAt),
      isNotNull(roomJournalModelRecoveries.spentAt),
      lte(roomJournalModelRecoveries.spentAt, roomJournalBatches.lastErrorAt),
    ));
  const agentMember = db.select({ one: sql`1` })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(
      eq(roomMembers.roomId, rooms.id),
      eq(actors.kind, "agent"),
    ));
  const blockedFailedAttempt = db.select({ one: sql`1` })
    .from(roomJournalBatches)
    .where(and(
      eq(roomJournalBatches.roomId, roomJournalState.roomId),
      eq(roomJournalBatches.lane, "historical"),
      eq(
        roomJournalBatches.fromMessageIdExclusive,
        roomJournalState.historicalBackfillCursorMessageId,
      ),
      eq(roomJournalBatches.status, "failed"),
      or(
        eq(roomJournalBatches.errorCode, "provider_outcome_unknown"),
        and(
          eq(roomJournalBatches.errorCode, "invalid_output"),
          exists(spentManualInvalidOutput),
        ),
      ),
      notExists(manualRecovery),
    ));
  const result = await db.select({ room_id: roomJournalState.roomId })
    .from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(and(
      notInArray(rooms.kind, ["task", "access"]),
      isNull(roomJournalState.rebuildRequestedAt),
      isNull(roomJournalState.suspendedAt),
      notExists(blockedFailedAttempt),
      eq(roomJournalState.historicalBackfillStatus, "pending"),
      isNotNull(roomJournalState.historicalBackfillCursorMessageId),
      isNotNull(roomJournalState.historicalBackfillTargetMessageId),
      lt(
        roomJournalState.historicalBackfillCursorMessageId,
        roomJournalState.historicalBackfillTargetMessageId,
      ),
      or(
        isNull(roomJournalState.extractionRetryAfter),
        lte(roomJournalState.extractionRetryAfter, now),
      ),
      or(
        isNull(roomJournalState.leaseToken),
        isNull(roomJournalState.leaseExpiresAt),
        lte(roomJournalState.leaseExpiresAt, now),
      ),
      exists(agentMember),
    ))
    .orderBy(asc(roomJournalState.updatedAt), asc(roomJournalState.roomId))
    .limit(limit);
  return result.map((row) => row.room_id);
}

async function loadPromptJournal(
  tx: JournalExecutor,
  roomId: string,
  namespaceId: string,
): Promise<{
  latestRollup: RoomEventRollupView | null;
  visibleEvents: EffectiveRoomEvent[];
}> {
  const rollupRows = await tx
    .select({
      id: roomEventRollups.id,
      throughEventSequence: roomEventRollups.throughEventSequence,
      content: roomEventRollups.content,
      sourceEventCount: roomEventRollups.sourceEventCount,
      compactorVersion: roomEventRollups.compactorVersion,
      modelExposureDependencies: roomEventRollups.modelExposureDependencies,
    })
    .from(roomEventRollups)
    .where(eq(roomEventRollups.roomId, roomId))
    .orderBy(
      desc(roomEventRollups.throughEventSequence),
      desc(roomEventRollups.createdAt),
    )
    .limit(1);
  const rollup = rollupRows[0];
  if (rollup?.content === null) {
    throw new Error("Room Journal ordinary rollup is unavailable");
  }
  const through = rollup ? rollup.throughEventSequence : 0;
  const eventRows = await tx.select({
    id: roomEvents.id,
    room_id: roomEvents.roomId,
    sequence: roomEvents.sequence,
    kind: roomEvents.kind,
    projection_kind: roomEvents.projectionKind,
    record_id: roomEvents.recordId,
    processing_generation: reflectionRecords.processingGeneration,
    statement: sql<string | null>`CASE
      WHEN ${roomEvents.projectionKind} = 'legacy' THEN ${roomEvents.statement}
      ELSE convert_from(
        ${reflectionRecordPayloadRepresentations.plaintextPayloadBytes},
        'UTF8'
      )::jsonb->>'statement'
    END`.as("statement"),
    status: roomEvents.status,
    supersedes_event_id: roomEvents.supersedesEventId,
    resolves_event_id: roomEvents.resolvesEventId,
  })
    .from(roomEvents)
    .leftJoin(
      reflectionRecords,
      and(
        eq(roomEvents.projectionKind, "native"),
        eq(reflectionRecords.recordId, roomEvents.recordId),
      ),
    )
    .leftJoin(
      reflectionRecordPayloadRepresentationHeads,
      and(
        eq(roomEvents.projectionKind, "native"),
        eq(
          reflectionRecordPayloadRepresentationHeads.recordId,
          roomEvents.recordId,
        ),
        eq(
          reflectionRecordPayloadRepresentationHeads.representation,
          "ordinary",
        ),
      ),
    )
    .leftJoin(
      reflectionRecordPayloadRepresentations,
      and(
        eq(
          reflectionRecordPayloadRepresentations.recordId,
          reflectionRecordPayloadRepresentationHeads.recordId,
        ),
        eq(
          reflectionRecordPayloadRepresentations.representation,
          reflectionRecordPayloadRepresentationHeads.representation,
        ),
        eq(
          reflectionRecordPayloadRepresentations.representationGeneration,
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        ),
      ),
    )
    .where(and(
      eq(roomEvents.roomId, roomId),
      eq(roomEvents.status, "active"),
      gt(roomEvents.sequence, through),
    ))
    .orderBy(asc(roomEvents.sequence));
  return {
    latestRollup: rollup
      ? {
          id: rollup.id,
          throughEventSequence: through,
          content: rollup.content,
          sourceEventCount: rollup.sourceEventCount,
          compactorVersion: rollup.compactorVersion,
          ...(rollup.modelExposureDependencies === null
            ? {}
            : {
                modelExposureDependencies:
                  rollup.modelExposureDependencies,
              }),
          modelExposureDependency: {
            kind: "source",
            sourceKind: "journal_rollup",
            logicalSourceRef: `journal-rollup:${rollup.id}`,
            observedRevision:
              `through:${through}:version:${rollup.compactorVersion}`,
            observedContentFingerprint:
              stenographerJournalRollupObservationFingerprint({
                rollupId: rollup.id,
                throughEventSequence: through,
                content: rollup.content,
                compactorVersion: rollup.compactorVersion,
                ...(rollup.modelExposureDependencies === null
                  ? {}
                  : {
                      modelExposureDependencies:
                        rollup.modelExposureDependencies,
                    }),
              }),
            terminalAuthorityLeafHandle: namespaceId,
          },
        }
      : null,
    visibleEvents: eventRows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      sequence: asNumber(row.sequence),
      kind: row.kind,
      statement: eventStatement(row),
      status: row.status,
      supersedesEventId: row.supersedes_event_id,
      resolvesEventId: row.resolves_event_id,
      ...(row.projection_kind === "native"
        && row.record_id !== null
        && row.processing_generation !== null
        ? {
            modelExposureDependency: {
              kind: "record" as const,
              recordRef: row.record_id,
              observedProcessingGeneration:
                row.processing_generation,
              terminalAuthorityLeafHandles: [namespaceId],
            },
          }
        : row.projection_kind === "legacy"
          ? {
              modelExposureDependency: {
                kind: "source" as const,
                sourceKind: "journal_event",
                logicalSourceRef: `journal-event:${row.id}`,
                observedRevision:
                  `sequence:${asNumber(row.sequence)}:status:${row.status}`,
                observedContentFingerprint:
                  stenographerJournalEventObservationFingerprint({
                    eventId: row.id,
                    sequence: asNumber(row.sequence),
                    kind: row.kind,
                    statement: eventStatement(row),
                    status: row.status,
                  }),
                terminalAuthorityLeafHandle: namespaceId,
              },
            }
          : {}),
    })),
  };
}

async function loadPriorContextRows(
  tx: JournalExecutor,
  input: {
    roomId: string;
    floorMessageIdExclusive: number;
    cursorMessageIdInclusive: number;
    conversationalLimit: number;
  },
): Promise<ClaimedSourceRow[]> {
  if (
    input.conversationalLimit <= 0 ||
    input.floorMessageIdExclusive >= input.cursorMessageIdInclusive
  ) {
    return [];
  }
  const result = await tx.execute(sql`
    WITH eligible AS (
      SELECT
        sm.id,
        sm.created_at,
        sm.role,
        sm.content,
        sm.fingerprint,
        sm.edit_revision,
        sm.transcript_origin,
        sm.metadata->>'originatedBy' AS originated_by,
        COALESCE(aa.display_name, ua.display_name) AS display_name,
        COALESCE(ag.handle, u.handle) AS handle,
        false AS excluded_from_evidence,
        CASE
          WHEN sm.role = 'user' AND sm.fingerprint IS NOT NULL
          THEN row_number() OVER (
            PARTITION BY sm.fingerprint
            ORDER BY sm.created_at ASC, sm.id ASC
          )
          ELSE 1
        END AS fingerprint_ordinal
      FROM sessions s
      INNER JOIN session_messages sm ON sm.session_id = s.id
      LEFT JOIN agents ag ON ag.id = s.agent_id
      LEFT JOIN actors aa ON aa.agent_id = s.agent_id AND aa.kind = 'agent'
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN actors ua ON ua.owner_id = s.owner_id AND ua.kind = 'user'
      WHERE s.room_id = ${input.roomId}
        AND sm.id <= ${input.cursorMessageIdInclusive}
        AND sm.transcript_origin = 'main'
        AND sm.role IN ('user', 'assistant', 'tool')
        AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
        AND NOT EXISTS (
          SELECT 1
          FROM room_silence_state rss
          WHERE rss.room_id = ${input.roomId}
            AND rss.kind = 'deaf'
            AND sm.created_at >= rss.started_at
            AND sm.created_at <= rss.expires_at
        )
    ),
    bounded AS (
      SELECT *
      FROM eligible
      WHERE id > ${input.floorMessageIdExclusive}
    ),
    conversational AS (
      SELECT id, created_at
      FROM bounded
      WHERE
        (role = 'user' AND fingerprint_ordinal = 1)
        OR (role = 'assistant' AND btrim(content) <> '')
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.conversationalLimit}
    ),
    earliest AS (
      SELECT id, created_at
      FROM conversational
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
    SELECT
      b.id,
      b.created_at,
      b.role,
      b.content,
      b.fingerprint,
      b.edit_revision,
      b.transcript_origin,
      b.originated_by,
      b.display_name,
      b.handle,
      b.excluded_from_evidence
    FROM bounded b
    CROSS JOIN earliest first
    WHERE
      (
        b.created_at > first.created_at
        OR (b.created_at = first.created_at AND b.id >= first.id)
      )
      AND NOT (
        b.role = 'user'
        AND b.fingerprint IS NOT NULL
        AND b.fingerprint_ordinal > 1
      )
    ORDER BY b.created_at ASC, b.id ASC
  `);
  return rowsFromExecute<SourceDbRow>(result).map(claimedSourceRow);
}

export async function tryClaimRoom(
  db: DirectDatabase,
  roomId: string,
  now: Date,
  leaseMs = 2 * 60_000,
  lane: ExtractionClaim["lane"] = "live",
): Promise<ExtractionClaim | null> {
  try {
    return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`);
    const cursorExpression =
      lane === "live"
        ? sql`rjs.last_processed_message_id`
        : sql`rjs.historical_backfill_cursor_message_id`;
    const pendingUpperBoundExpression =
      lane === "live"
        ? sql`(
            SELECT MAX(sm.id)
            FROM sessions s
            INNER JOIN session_messages sm ON sm.session_id = s.id
            WHERE s.room_id = r.id
              AND sm.id > rjs.last_processed_message_id
          )`
        : sql`(
            SELECT MAX(bounded.id)
            FROM (
              SELECT sm.id
              FROM sessions s
              INNER JOIN session_messages sm ON sm.session_id = s.id
              WHERE s.room_id = r.id
                AND sm.id > rjs.historical_backfill_cursor_message_id
                AND sm.id <= rjs.historical_backfill_target_message_id
              ORDER BY sm.id ASC
              LIMIT 500
            ) bounded
          )`;
    const stateRows = rowsFromExecute<StateRow>(
      await tx.execute(sql`
        SELECT
          rjs.room_id,
          r.owner_id,
          r.kind,
          r.namespace_id,
          rjs.last_processed_message_id,
          rjs.suspended_at,
          rjs.lease_token,
          rjs.lease_expires_at,
          rjs.extraction_retry_after,
          rjs.historical_backfill_status,
          rjs.historical_backfill_cursor_message_id,
          rjs.historical_backfill_target_message_id,
          rjs.rebuild_generation,
          rjs.rebuild_requested_at,
          rjs.rebuild_target_message_id,
          COALESCE((
            SELECT scc.stenographer_prior_conversation_limit
            FROM server_context_config scc
            WHERE scc.id = 'server'
          ), 10)::integer AS stenographer_prior_conversation_limit,
          COALESCE((
            SELECT MIN(prior_batch.from_message_id_exclusive)
            FROM room_journal_batches prior_batch
            WHERE prior_batch.room_id = r.id
              AND prior_batch.lane = ${lane}
          ), ${cursorExpression})::integer AS prior_context_floor_message_id,
          EXISTS (
            SELECT 1
            FROM room_members rm
            INNER JOIN actors a ON a.id = rm.actor_id
            WHERE rm.room_id = r.id AND a.kind = 'agent'
          ) AS has_agent,
          COALESCE(
            replay_batch.through_message_id_inclusive,
            ${pendingUpperBoundExpression}
          ) AS upper_bound_message_id,
          replay_batch.id AS replay_batch_id,
          replay_batch.status AS replay_batch_status,
          replay_batch.error_code AS replay_batch_error_code,
          replay_batch.attempt_count AS replay_batch_attempt_count,
          replay_batch.started_at AS replay_batch_started_at,
          replay_batch.last_error_at AS replay_batch_last_error_at,
          replay_batch.last_error_model_id AS replay_batch_last_error_model_id,
          replay_batch.through_message_id_inclusive AS replay_through_message_id
        FROM room_journal_state rjs
        INNER JOIN rooms r ON r.id = rjs.room_id
        LEFT JOIN LATERAL (
          SELECT
            rjb.id,
            rjb.status,
            rjb.error_code,
            rjb.attempt_count,
            rjb.started_at,
            rjb.last_error_at,
            rjb.last_error_model_id,
            rjb.through_message_id_inclusive
          FROM room_journal_batches rjb
          WHERE rjb.room_id = r.id
            AND rjb.lane = ${lane}
            AND rjb.from_message_id_exclusive = ${cursorExpression}
            AND (
              rjb.status IN ('completed', 'failed')
              OR (
                rjb.status = 'running'
                AND (
                  rjs.lease_token IS NULL
                  OR rjs.lease_expires_at IS NULL
                  OR rjs.lease_expires_at <= ${timestampParam(now)}::timestamptz
                )
              )
            )
          ORDER BY
            CASE WHEN rjb.status = 'completed' THEN 0 ELSE 1 END,
            CASE WHEN rjb.status = 'completed' THEN rjb.through_message_id_inclusive END DESC,
            CASE WHEN rjb.status <> 'completed' THEN rjb.through_message_id_inclusive END ASC,
            rjb.created_at ASC,
            rjb.id ASC
          LIMIT 1
        ) replay_batch ON TRUE
        WHERE rjs.room_id = ${roomId}
        FOR UPDATE OF rjs
      `),
    );
    const state = stateRows[0];
    if (!state || state.kind === "task" || state.kind === "access") return null;
    if (!state.has_agent || state.suspended_at !== null) return null;
    const replayAttempt = state.replay_batch_attempt_count === null
      || state.replay_batch_attempt_count === undefined
      ? null
      : asNumber(state.replay_batch_attempt_count);
    const [spentManualInvalidOutput] =
      state.replay_batch_status === "failed"
      && state.replay_batch_error_code === "invalid_output"
      && state.replay_batch_id !== null
      && state.replay_batch_started_at != null
      && state.replay_batch_last_error_at != null
      && state.replay_batch_last_error_model_id != null
      && state.rebuild_generation != null
        ? await tx.select({ id: roomJournalModelRecoveries.id })
            .from(roomJournalModelRecoveries)
            .where(and(
              eq(roomJournalModelRecoveries.roomId, roomId),
              eq(roomJournalModelRecoveries.workKind, "extraction"),
              eq(roomJournalModelRecoveries.workId, state.replay_batch_id),
              eq(roomJournalModelRecoveries.rebuildGeneration, asNumber(state.rebuild_generation)),
              eq(roomJournalModelRecoveries.targetModelId, state.replay_batch_last_error_model_id),
              eq(roomJournalModelRecoveries.claimedAt, asDate(state.replay_batch_started_at)),
              isNotNull(roomJournalModelRecoveries.spentAt),
              lte(roomJournalModelRecoveries.spentAt, asDate(state.replay_batch_last_error_at)),
            ))
            .limit(1)
            .for("update", { of: roomJournalModelRecoveries })
        : [];
    // Funding spends a manual grant only immediately before the model wire.
    // Until then, the expired product lease remains the durable proof that a
    // running batch owns this exact unspent grant. Reclaim only that lease;
    // ordinary uncertain attempts still fall through to replay-safety below.
    const reclaimingUnspentRecovery =
      state.replay_batch_status === "running"
      && state.replay_batch_id !== null
      && replayAttempt !== null
      && state.lease_token !== null
      && state.lease_expires_at !== null
      && asDate(state.lease_expires_at).getTime() <= now.getTime();
    const manualRecoveryRequired =
      state.replay_batch_status === "failed"
      && (
        state.replay_batch_error_code === "provider_outcome_unknown"
        || spentManualInvalidOutput !== undefined
      );
    const claimingFreshRecovery =
      manualRecoveryRequired
      && state.replay_batch_id !== null
      && replayAttempt !== null;
    const [manualRecovery] = !claimingFreshRecovery && !reclaimingUnspentRecovery
      ? []
      : await tx.select({
          id: roomJournalModelRecoveries.id,
          targetModelId: roomJournalModelRecoveries.targetModelId,
          claimLeaseToken: roomJournalModelRecoveries.claimLeaseToken,
        }).from(roomJournalModelRecoveries).where(and(
          eq(roomJournalModelRecoveries.roomId, roomId),
          eq(roomJournalModelRecoveries.workKind, "extraction"),
          eq(roomJournalModelRecoveries.workId, state.replay_batch_id!),
          eq(roomJournalModelRecoveries.rebuildGeneration, asNumber(state.rebuild_generation)),
          isNull(roomJournalModelRecoveries.spentAt),
          claimingFreshRecovery
            ? and(
                eq(roomJournalModelRecoveries.observedAttempt, replayAttempt),
                isNull(roomJournalModelRecoveries.claimLeaseToken),
                isNull(roomJournalModelRecoveries.claimedAt),
              )
            : and(
                lt(roomJournalModelRecoveries.observedAttempt, replayAttempt),
                eq(roomJournalModelRecoveries.claimLeaseToken, state.lease_token!),
                isNotNull(roomJournalModelRecoveries.claimedAt),
                lte(roomJournalModelRecoveries.claimedAt, now),
              ),
        )).limit(1)
          .for("update", { of: roomJournalModelRecoveries });
    if (
      manualRecoveryRequired
      && manualRecovery === undefined
    ) {
      return null;
    }
    if (
      lane === "historical" &&
      (state.historical_backfill_status !== "pending" ||
        state.historical_backfill_cursor_message_id === null ||
        state.historical_backfill_target_message_id === null)
    ) {
      return null;
    }
    if (
      state.replay_batch_status === "completed" &&
      state.replay_through_message_id !== null
    ) {
      const replayThrough = asNumber(state.replay_through_message_id);
      await tx
        .update(roomJournalState)
        .set(
          lane === "live"
            ? {
                lastProcessedMessageId: sql`GREATEST(${roomJournalState.lastProcessedMessageId}, ${replayThrough})`,
                lastProcessedAt: now,
                leaseToken: null,
                leaseExpiresAt: null,
                extractionFailureCount: 0,
                extractionRetryAfter: null,
                lastExtractionCompletedAt:
                  sql`COALESCE(${roomJournalState.lastExtractionCompletedAt}, ${sql.param(now, roomJournalState.lastExtractionCompletedAt)})`,
                updatedAt: now,
              }
            : {
                historicalBackfillCursorMessageId:
                  sql`GREATEST(${roomJournalState.historicalBackfillCursorMessageId}, ${replayThrough})`,
                historicalBackfillStatus:
                  sql`CASE WHEN ${replayThrough} >= ${roomJournalState.historicalBackfillTargetMessageId} THEN 'completed' ELSE ${roomJournalState.historicalBackfillStatus} END`,
                historicalBackfillCompletedAt:
                  sql`CASE WHEN ${replayThrough} >= ${roomJournalState.historicalBackfillTargetMessageId} THEN ${now} ELSE ${roomJournalState.historicalBackfillCompletedAt} END`,
                leaseToken: null,
                leaseExpiresAt: null,
                extractionFailureCount: 0,
                extractionRetryAfter: null,
                lastExtractionCompletedAt:
                  sql`COALESCE(${roomJournalState.lastExtractionCompletedAt}, ${sql.param(now, roomJournalState.lastExtractionCompletedAt)})`,
                updatedAt: now,
              },
        )
        .where(eq(roomJournalState.roomId, roomId));
      return null;
    }
    if (
      state.extraction_retry_after !== null &&
      asDate(state.extraction_retry_after).getTime() > now.getTime() &&
      (lane === "historical" || state.replay_batch_status === "failed")
    ) {
      return null;
    }
    if (
      state.lease_token !== null &&
      state.lease_expires_at !== null &&
      asDate(state.lease_expires_at).getTime() > now.getTime()
    ) {
      return null;
    }
    if (state.upper_bound_message_id === null) return null;

    const cursor = asNumber(
      lane === "live"
        ? state.last_processed_message_id
        : state.historical_backfill_cursor_message_id!,
    );
    const pendingUpperBound = asNumber(state.upper_bound_message_id);
    const upperBound =
      lane === "live" &&
      state.rebuild_requested_at != null &&
      state.rebuild_target_message_id != null
        ? Math.min(pendingUpperBound, asNumber(state.rebuild_target_message_id))
        : pendingUpperBound;
    const sourceDbRows = rowsFromExecute<SourceDbRow>(
      await tx.execute(sql`
        SELECT
          sm.id,
          sm.created_at,
          sm.role,
          sm.content,
          sm.fingerprint,
          sm.edit_revision,
          sm.transcript_origin,
          sm.metadata->>'originatedBy' AS originated_by,
          COALESCE(aa.display_name, ua.display_name) AS display_name,
          COALESCE(ag.handle, u.handle) AS handle,
          EXISTS (
            SELECT 1
            FROM room_silence_state rss
            WHERE rss.room_id = ${roomId}
              AND rss.kind = 'deaf'
              AND sm.created_at >= rss.started_at
              AND sm.created_at <= rss.expires_at
          ) AS excluded_from_evidence
        FROM sessions s
        INNER JOIN session_messages sm ON sm.session_id = s.id
        LEFT JOIN agents ag ON ag.id = s.agent_id
        LEFT JOIN actors aa ON aa.agent_id = s.agent_id AND aa.kind = 'agent'
        LEFT JOIN users u ON u.id = s.owner_id
        LEFT JOIN actors ua ON ua.owner_id = s.owner_id AND ua.kind = 'user'
        WHERE s.room_id = ${roomId}
          AND sm.id > ${cursor}
          AND sm.id <= ${upperBound}
        ORDER BY sm.id ASC
      `),
    );
    const priorFingerprintRows = await tx.selectDistinct({
      fingerprint: sessionMessages.fingerprint,
    })
      .from(sessions)
      .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
      .where(and(
        eq(sessions.roomId, roomId),
        lte(sessionMessages.id, cursor),
        eq(sessionMessages.role, "user"),
        isNotNull(sessionMessages.fingerprint),
      ));
    const priorFingerprints = new Set(
      priorFingerprintRows
        .map((row) => row.fingerprint)
        .filter((fingerprint): fingerprint is string => fingerprint !== null),
    );
    const sourceRows = sourceDbRows.map(claimedSourceRow);
    const plan = planStenographerBatch({
      cursorMessageId: cursor,
      fixedUpperBoundMessageId: upperBound,
      rows: sourceRows,
      now,
      fingerprintsAtOrBeforeCursor: priorFingerprints,
      retryFixedRange:
        state.replay_batch_status === "failed"
        || state.replay_batch_status === "running",
    });
    if (!plan) return null;

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const batchRows = await tx.insert(roomJournalBatches)
      .values({
        roomId,
        fromMessageIdExclusive: plan.fromMessageIdExclusive,
        throughMessageIdInclusive: plan.throughMessageIdInclusive,
        extractorVersion: "m219-v1",
        lane,
        status: "running",
        attemptCount: 1,
        startedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          roomJournalBatches.roomId,
          roomJournalBatches.fromMessageIdExclusive,
          roomJournalBatches.throughMessageIdInclusive,
          roomJournalBatches.extractorVersion,
          roomJournalBatches.lane,
        ],
        set: {
          status: "running",
          errorCode: null,
          attemptCount: sql`${roomJournalBatches.attemptCount} + 1`,
          startedAt: now,
          completedAt: null,
        },
      })
      .returning({
        id: roomJournalBatches.id,
        attempt_count: roomJournalBatches.attemptCount,
      });
    const batch = batchRows[0];
    if (!batch) throw new Error("journal batch upsert returned no row");
    if (manualRecovery !== undefined) {
      const [current] = await tx.select({
        binding: roomJournalBatches.acceptedModelBinding,
      }).from(roomJournalBatches).where(and(
        eq(roomJournalBatches.id, batch.id),
        eq(roomJournalBatches.roomId, roomId),
        eq(roomJournalBatches.status, "running"),
        eq(roomJournalBatches.attemptCount, batch.attempt_count),
      )).limit(1).for("update", { of: roomJournalBatches });
      if (!current) {
        throw new Error("Manual Stenographer extraction recovery binding changed");
      }
      let accepted: ReturnType<typeof parseMemoryOperationBinding> | null = null;
      if (current.binding !== null) {
        try {
          accepted = parseMemoryOperationBinding(current.binding);
        } catch {
          throw new Error("Manual Stenographer extraction recovery binding changed");
        }
      }
      if (accepted !== null
        && (accepted.kind !== "service"
          || accepted.role !== "memorySummarization")) {
        throw new Error("Manual Stenographer extraction recovery binding changed");
      }
      if (reclaimingUnspentRecovery && accepted !== null) {
        if (accepted.modelId !== manualRecovery.targetModelId) {
          throw new Error("Manual Stenographer extraction recovery binding changed");
        }
      } else if (!reclaimingUnspentRecovery && accepted !== null) {
        await tx.update(roomJournalBatches).set({
          acceptedModelBinding: { ...accepted, modelId: manualRecovery.targetModelId },
        }).where(eq(roomJournalBatches.id, batch.id));
      }
      await tx.update(roomJournalModelRecoveries).set({
        claimLeaseToken: leaseToken,
        claimedAt: now,
      }).where(and(
        eq(roomJournalModelRecoveries.id, manualRecovery.id),
        isNull(roomJournalModelRecoveries.spentAt),
        reclaimingUnspentRecovery
          ? eq(
              roomJournalModelRecoveries.claimLeaseToken,
              manualRecovery.claimLeaseToken!,
            )
          : and(
              isNull(roomJournalModelRecoveries.claimLeaseToken),
              isNull(roomJournalModelRecoveries.claimedAt),
            ),
      ));
    }
    const previousModelResultKnownNonusable =
      state.replay_batch_id === batch.id
      && state.replay_batch_status === "failed"
      && state.replay_batch_error_code === "invalid_output";
    const replaySafety = await resolveModelAttemptReplaySafety({
      kind: "operation",
      roomId,
      callType: "room_stenographer",
      operationId: batch.id,
    }, {
      db: tx,
      knownNonusableResult: previousModelResultKnownNonusable,
    });
    if (replaySafety.decision === "block_unknown" && manualRecovery === undefined) {
      await tx.update(roomJournalBatches).set({
        status: "failed", errorCode: "provider_outcome_unknown", lastErrorAt: now,
        lastErrorAttempt: roomJournalBatches.attemptCount,
      }).where(eq(roomJournalBatches.id, batch.id));
      await tx.update(roomJournalState).set({
        leaseToken: null, leaseExpiresAt: null, extractionRetryAfter: null,
        lastExtractionErrorCode: "provider_outcome_unknown", lastExtractionErrorAt: now,
        updatedAt: now,
      }).where(eq(roomJournalState.roomId, roomId));
      return null;
    }
    await tx
      .update(roomJournalState)
      .set({
        leaseToken,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(roomJournalState.roomId, roomId));
    const journal = await loadPromptJournal(tx, roomId, state.namespace_id);
    const priorContextRows = await loadPriorContextRows(tx, {
      roomId,
      floorMessageIdExclusive: asNumber(state.prior_context_floor_message_id),
      cursorMessageIdInclusive: cursor,
      conversationalLimit: Math.max(
        0,
        Math.min(
          50,
          asNumber(state.stenographer_prior_conversation_limit),
        ),
      ),
    });
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    return {
      batchId: batch.id,
      roomId,
      ownerId: state.owner_id,
      leaseToken,
      attemptCount: asNumber(batch.attempt_count),
      ...(previousModelResultKnownNonusable
        ? { previousModelResultKnownNonusable: true as const }
        : {}),
      lane,
      plan,
      priorContextRows,
      sourceRows: plan.sourceRows
        .map((row) => sourceById.get(row.id))
        .filter((row): row is ClaimedSourceRow => row !== undefined),
      ...journal,
      namespaceId: state.namespace_id,
      rebuildGeneration:
        state.rebuild_requested_at == null
          ? null
          : asNumber(state.rebuild_generation),
      ...(manualRecovery === undefined
        ? {}
        : { manualModelRecoveryId: manualRecovery.id, manualRecoveryModelId: manualRecovery.targetModelId }),
    };
    });
  } catch (error) {
    if (error instanceof StenographerSourceRepresentationUnavailableError) {
      return null;
    }
    throw error;
  }
}

/** M230 — prepare at most one dirty Room for a full journal replay. */
export async function prepareNextJournalRebuild(
  opts: { now?: Date; db?: DirectDatabase } = {},
): Promise<string | null> {
  const db = opts.db ?? getSharedDirectDb();
  const now = opts.now ?? new Date();
  const protectedPublication = db.select({ one: sql`1` })
    .from(roomJournalCryptoPublications)
    .where(eq(
      roomJournalCryptoPublications.roomId,
      roomJournalState.roomId,
    ));
  const agentMember = db.select({ one: sql`1` })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(
      eq(roomMembers.roomId, rooms.id),
      eq(actors.kind, "agent"),
    ));
  const candidates = await db.select({ room_id: roomJournalState.roomId })
    .from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(and(
      isNotNull(roomJournalState.rebuildRequestedAt),
      notInArray(rooms.kind, ["task", "access"]),
      isNull(roomJournalState.suspendedAt),
      notExists(protectedPublication),
      exists(agentMember),
    ))
    .orderBy(
      asc(roomJournalState.rebuildRequestedAt),
      asc(roomJournalState.roomId),
    )
    .limit(20);
  for (const candidate of candidates) {
    const prepared = await db.transaction(async (tx) => {
      // M267 — rebuild cleanup is a native-writer mutation after the durable
      // cutover fence; old binaries cannot set this transaction-local token.
      await tx.execute(sql`
        SELECT set_config('nautilo.stenographer_writer_version', '2', true)
      `);
      await tx.execute(sql`
        SELECT id FROM rooms WHERE id = ${candidate.room_id} FOR UPDATE
      `);
      const state = rowsFromExecute<{
        rebuild_generation: number | string;
        rebuild_requested_at: string | Date | null;
        rebuild_target_message_id: number | string | null;
      }>(
        await tx.execute(sql`
          SELECT
            rjs.rebuild_generation,
            rjs.rebuild_requested_at,
            rjs.rebuild_target_message_id
          FROM room_journal_state rjs
          WHERE rjs.room_id = ${candidate.room_id}
            AND rjs.rebuild_requested_at IS NOT NULL
          FOR UPDATE
        `),
      )[0];
      if (!state?.rebuild_requested_at) return false;
      const generation = asNumber(state.rebuild_generation);
      let target =
        state.rebuild_target_message_id === null
          ? null
          : asNumber(state.rebuild_target_message_id);
      if (target === null) {
        const [firstAgent] = await tx.select({
          joined_at: sql<Date | null>`MIN(${roomMembers.joinedAt})`
            .as("joined_at"),
        })
          .from(roomMembers)
          .innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(and(
            eq(roomMembers.roomId, candidate.room_id),
            eq(actors.kind, "agent"),
          ));
        const firstAgentJoinedAt = firstAgent?.joined_at ?? null;
        const [bounds] = await tx.select({
          start_cursor: sql<number>`COALESCE(MAX(CASE
            WHEN ${sessionMessages.createdAt} <= ${firstAgentJoinedAt}
              THEN ${sessionMessages.id}
          END), 0)::integer`.as("start_cursor"),
          target_cursor: sql<number>`COALESCE(MAX(${sessionMessages.id}), 0)::integer`
            .as("target_cursor"),
        })
          .from(sessions)
          .innerJoin(
            sessionMessages,
            eq(sessionMessages.sessionId, sessions.id),
          )
          .where(eq(sessions.roomId, candidate.room_id));
        const startCursor = bounds ? asNumber(bounds.start_cursor) : 0;
        target = bounds ? asNumber(bounds.target_cursor) : 0;
        await tx
          .delete(roomEventRollups)
          .where(eq(roomEventRollups.roomId, candidate.room_id));
        await tx
          .delete(roomEvents)
          .where(eq(roomEvents.roomId, candidate.room_id));
        await tx
          .delete(roomJournalBatches)
          .where(eq(roomJournalBatches.roomId, candidate.room_id));
        await tx
          .update(roomJournalState)
          .set({
            lastProcessedMessageId: startCursor,
            lastProcessedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            extractionFailureCount: 0,
            extractionRetryAfter: null,
            lastExtractionErrorCode: null,
            lastExtractionErrorAt: null,
            lastExtractionCompletedAt: null,
            compactionDueAt: null,
            compactionAcceptedModelBinding: null,
            compactionAcceptedPlan: null,
            compactionLeaseToken: null,
            compactionLeaseExpiresAt: null,
            compactionFailureCount: 0,
            compactionLastAttemptKnownNonusable: false,
            compactionRetryAfter: null,
            lastCompactionErrorCode: null,
            lastCompactionErrorAt: null,
            lastCompactionErrorAttempt: null,
            lastCompactionErrorModelId: null,
            lastCompactionCompletedAt: null,
            historicalBackfillStatus: "not_needed",
            historicalBackfillCursorMessageId: null,
            historicalBackfillTargetMessageId: null,
            historicalBackfillCompletedAt: null,
            rebuildTargetMessageId: target,
            updatedAt: now,
          })
          .where(
            and(
              eq(roomJournalState.roomId, candidate.room_id),
              eq(roomJournalState.rebuildGeneration, generation),
            ),
          );
      }
      const [currentCursor] = await tx
        .select({
          lastProcessedMessageId: roomJournalState.lastProcessedMessageId,
        })
        .from(roomJournalState)
        .where(eq(roomJournalState.roomId, candidate.room_id));
      if (
        currentCursor &&
        target <= asNumber(currentCursor.lastProcessedMessageId)
      ) {
        await tx
          .update(roomJournalState)
          .set({
            rebuildRequestedAt: null,
            rebuildTargetMessageId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(roomJournalState.roomId, candidate.room_id),
              eq(roomJournalState.rebuildGeneration, generation),
            ),
          );
        return false;
      }
      return true;
    });
    if (prepared) return candidate.room_id;
  }
  return null;
}

export async function claimJournalRebuildExtraction(
  roomId: string,
  opts: { now?: Date; leaseMs?: number; db?: DirectDatabase } = {},
): Promise<ExtractionClaim | null> {
  const db = opts.db ?? getSharedDirectDb();
  return tryClaimRoom(
    db,
    roomId,
    opts.now ?? new Date(),
    opts.leaseMs ?? 2 * 60_000,
    "live",
  );
}

export async function claimNextExtraction(
  opts: {
    now?: Date;
    leaseMs?: number;
    candidateLimit?: number;
    db?: DirectDatabase;
  } = {},
): Promise<ExtractionClaim | null> {
  const db = opts.db ?? getSharedDirectDb();
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? 2 * 60_000;
  const candidates = await candidateRoomIds(
    db,
    now,
    Math.max(1, opts.candidateLimit ?? 20),
  );
  for (const roomId of candidates) {
    const claim = await tryClaimRoom(db, roomId, now, leaseMs);
    if (claim) return claim;
  }
  return null;
}

export async function claimNextHistoricalExtraction(
  opts: {
    now?: Date;
    leaseMs?: number;
    candidateLimit?: number;
    db?: DirectDatabase;
  } = {},
): Promise<ExtractionClaim | null> {
  const db = opts.db ?? getSharedDirectDb();
  const now = opts.now ?? new Date();
  await initializeHistoricalBackfills({ db, now });
  const leaseMs = opts.leaseMs ?? 2 * 60_000;
  const candidates = await historicalCandidateRoomIds(
    db,
    now,
    Math.max(1, opts.candidateLimit ?? 20),
  );
  for (const roomId of candidates) {
    const claim = await tryClaimRoom(db, roomId, now, leaseMs, "historical");
    if (claim) return claim;
  }
  return null;
}

async function loadAllRoomEvents(
  tx: JournalExecutor,
  roomId: string,
  namespaceId: string,
): Promise<EffectiveRoomEvent[]> {
  const rows = await tx.select({
    id: roomEvents.id,
    room_id: roomEvents.roomId,
    sequence: roomEvents.sequence,
    kind: roomEvents.kind,
    projection_kind: roomEvents.projectionKind,
    record_id: roomEvents.recordId,
    processing_generation: reflectionRecords.processingGeneration,
    statement: sql<string | null>`CASE
      WHEN ${roomEvents.projectionKind} = 'legacy' THEN ${roomEvents.statement}
      ELSE convert_from(
        ${reflectionRecordPayloadRepresentations.plaintextPayloadBytes},
        'UTF8'
      )::jsonb->>'statement'
    END`.as("statement"),
    status: roomEvents.status,
    supersedes_event_id: roomEvents.supersedesEventId,
    resolves_event_id: roomEvents.resolvesEventId,
  })
    .from(roomEvents)
    .leftJoin(
      reflectionRecords,
      and(
        eq(roomEvents.projectionKind, "native"),
        eq(reflectionRecords.recordId, roomEvents.recordId),
      ),
    )
    .leftJoin(
      reflectionRecordPayloadRepresentationHeads,
      and(
        eq(roomEvents.projectionKind, "native"),
        eq(
          reflectionRecordPayloadRepresentationHeads.recordId,
          roomEvents.recordId,
        ),
        eq(
          reflectionRecordPayloadRepresentationHeads.representation,
          "ordinary",
        ),
      ),
    )
    .leftJoin(
      reflectionRecordPayloadRepresentations,
      and(
        eq(
          reflectionRecordPayloadRepresentations.recordId,
          reflectionRecordPayloadRepresentationHeads.recordId,
        ),
        eq(
          reflectionRecordPayloadRepresentations.representation,
          reflectionRecordPayloadRepresentationHeads.representation,
        ),
        eq(
          reflectionRecordPayloadRepresentations.representationGeneration,
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        ),
      ),
    )
    .where(eq(roomEvents.roomId, roomId))
    .orderBy(asc(roomEvents.sequence));
  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    sequence: asNumber(row.sequence),
    kind: row.kind,
    statement: eventStatement(row),
    status: row.status,
    supersedesEventId: row.supersedes_event_id,
    resolvesEventId: row.resolves_event_id,
    ...(row.projection_kind === "native"
      && row.record_id !== null
      && row.processing_generation !== null
      ? {
          modelExposureDependency: {
            kind: "record" as const,
            recordRef: row.record_id,
            observedProcessingGeneration: row.processing_generation,
            terminalAuthorityLeafHandles: [namespaceId],
          },
        }
      : row.projection_kind === "legacy"
        ? {
            modelExposureDependency: {
              kind: "source" as const,
              sourceKind: "journal_event",
              logicalSourceRef: `journal-event:${row.id}`,
              observedRevision:
                `sequence:${asNumber(row.sequence)}:status:${row.status}`,
              observedContentFingerprint:
                stenographerJournalEventObservationFingerprint({
                  eventId: row.id,
                  sequence: asNumber(row.sequence),
                  kind: row.kind,
                  statement: eventStatement(row),
                  status: row.status,
                }),
              terminalAuthorityLeafHandle: namespaceId,
            },
          }
        : {}),
  }));
}

/**
 * Reconstruct the exact current ordinary compaction identity without claiming
 * a lease or mutating durable acceptance. Legacy rows created before funding
 * bindings and accepted plans existed may use this as their recovery witness.
 */
export async function resolveCurrentOrdinaryCompactionCoordinates(
  tx: JournalExecutor,
  roomId: string,
): Promise<Readonly<{
  workId: string;
  rebuildGeneration: number;
  inputDigest: string;
  dependencies: readonly DurableModelExposureDependency[] | undefined;
}> | null> {
  const [state] = await tx.select({
    namespaceId: rooms.namespaceId,
    rebuildGeneration: roomJournalState.rebuildGeneration,
    rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
    acceptedBinding: roomJournalState.compactionAcceptedModelBinding,
    acceptedPlan: roomJournalState.compactionAcceptedPlan,
  }).from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(eq(roomJournalState.roomId, roomId))
    .limit(1);
  if (!state || state.rebuildRequestedAt !== null
    || state.acceptedBinding !== null || state.acceptedPlan !== null) {
    return null;
  }
  try {
    const journal = await loadPromptJournal(tx, roomId, state.namespaceId);
    const events = await loadAllRoomEvents(tx, roomId, state.namespaceId);
    const planned = planJournalCompaction({
      events,
      rollups: journal.latestRollup ? [journal.latestRollup] : [],
    });
    if (!planned.ok || !planned.plan) return null;
    const rebuildGeneration = state.rebuildGeneration;
    const workId = ordinaryCompactionOperationId(roomId, rebuildGeneration, journal.latestRollup?.id ?? null, planned.plan);
    return {
      rebuildGeneration, workId, inputDigest: compactionInputDigest(workId, journal.latestRollup, planned.plan),
      dependencies: compactionModelExposureDependencies({ plan: planned.plan, previousRollup: journal.latestRollup }),
    };
  } catch (error) {
    if (error instanceof StenographerSourceRepresentationUnavailableError) {
      return null;
    }
    throw error;
  }
}

/** Recompute one stored ordinary plan from its exact current source under the caller's lock. */
export async function isCurrentOrdinaryCompactionAcceptedPlan(
  tx: JournalExecutor,
  roomId: string,
): Promise<boolean> {
  const [state] = await tx.select({
    namespaceId: rooms.namespaceId,
    rebuildGeneration: roomJournalState.rebuildGeneration,
    rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
    acceptedPlan: roomJournalState.compactionAcceptedPlan,
  }).from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(eq(roomJournalState.roomId, roomId))
    .limit(1);
  if (!state || state.rebuildRequestedAt !== null) return false;
  let accepted: Extract<StenographerCompactionAcceptedPlan, { owner: "ordinary" }> | null;
  try {
    accepted = acceptedOrdinaryCompactionPlan(state.acceptedPlan);
  } catch {
    return false;
  }
  if (accepted === null) return false;
  try {
    const journal = await loadPromptJournal(tx, roomId, state.namespaceId);
    const events = await loadAllRoomEvents(tx, roomId, state.namespaceId);
    const planned = currentAcceptedOrdinaryCompactionPlan({
      acceptedPlan: accepted,
      rebuildGeneration: state.rebuildGeneration,
      latestRollup: journal.latestRollup,
      allEvents: events,
    });
    return !!(planned?.ok && planned.plan);
  } catch (error) {
    if (error instanceof StenographerSourceRepresentationUnavailableError) return false;
    throw error;
  }
}

// Bind a replacement to the exact ordinary input, including changes inside
// the same event sequence window. Only the digest is stored in the grant.
function compactionInputDigest(
  workId: string,
  previous: RoomEventRollupView | null,
  plan: JournalCompactionPlan<EffectiveRoomEvent>,
): string {
  return createHash("sha256").update(JSON.stringify([
    workId, previous, plan.selectedEvents, plan.protectedTail,
  ])).digest("hex");
}

function ordinaryCompactionOperationId(
  roomId: string,
  rebuildGeneration: number,
  previousRollupId: string | null,
  plan: JournalCompactionPlan<EffectiveRoomEvent>,
): string {
  return `compaction:${roomId}:${rebuildGeneration}:${previousRollupId ?? "initial"}:${plan.throughEventSequence}:${plan.protectedTail.at(-1)?.sequence ?? plan.throughEventSequence}`;
}

function retryDelayMs(failureCount: number): number {
  return Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, failureCount - 1));
}

/** The caller owns the Room and state row locks for this exact reservation. */
async function retireFreshCompactionGrant(tx: JournalExecutor, roomId: string, recoveryId: string, now: Date): Promise<boolean> {
  const grant = roomJournalModelRecoveries;
  const [retired] = await tx.update(roomJournalModelRecoveries).set({
    sourceChangedAt: now, replacementInputDigest: grant.authorizedInputDigest,
  }).where(and(eq(grant.id, recoveryId), eq(grant.roomId, roomId), eq(grant.workKind, "compaction"),
    eq(grant.freshServiceInputs, true), isNotNull(grant.authorizedInputDigest),
    isNull(grant.spentAt), isNull(grant.sourceChangedAt),
  )).returning({ token: grant.claimLeaseToken });
  if (!retired) return false;
  const [released] = await tx.update(roomJournalState).set({
    compactionAcceptedPlan: null, compactionAcceptedModelBinding: null,
    compactionLeaseToken: null, compactionLeaseExpiresAt: null, compactionRetryAfter: null, updatedAt: now,
  }).where(and(eq(roomJournalState.roomId, roomId), retired.token === null
    ? isNull(roomJournalState.compactionLeaseToken)
    : eq(roomJournalState.compactionLeaseToken, retired.token))).returning({ roomId: roomJournalState.roomId });
  if (!released) throw new Error("Compaction recovery lease changed");
  return true;
}

/** Park only the exact unspent claim. A fresh token immediately fences the
 * failed worker. The existing expired-lease path reclaims it after backoff. */
async function parkUnspentJournalGrant(
  tx: Pick<DirectDatabase, "update">,
  claim: { roomId: string; leaseToken: string; manualModelRecoveryId?: string },
  kind: "extraction" | "compaction",
  workId: string,
): Promise<string | null> {
  if (claim.manualModelRecoveryId === undefined) return null;
  const nextToken = randomUUID();
  const [parked] = await tx.update(roomJournalModelRecoveries)
    .set({ claimLeaseToken: nextToken })
    .where(and(
      eq(roomJournalModelRecoveries.id, claim.manualModelRecoveryId),
      eq(roomJournalModelRecoveries.roomId, claim.roomId),
      eq(roomJournalModelRecoveries.workKind, kind),
      eq(roomJournalModelRecoveries.workId, workId),
      eq(roomJournalModelRecoveries.claimLeaseToken, claim.leaseToken),
      isNull(roomJournalModelRecoveries.spentAt),
    )).returning({ id: roomJournalModelRecoveries.id });
  return parked ? nextToken : null;
}

export async function failExtraction(input: {
  claim: Pick<
    ExtractionClaim,
    | "batchId"
    | "roomId"
    | "leaseToken"
    | "previousModelResultKnownNonusable"
    | "manualModelRecoveryId"
  >;
  errorCode: StenographerErrorCode;
  modelId: string | null;
  now?: Date;
  db?: DirectDatabase;
}): Promise<void> {
  const db = input.db ?? getSharedDirectDb();
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM rooms WHERE id = ${input.claim.roomId} FOR UPDATE`,
    );
    const rows = rowsFromExecute<{ extraction_failure_count: number | string }>(
      await tx.execute(sql`
        SELECT extraction_failure_count
        FROM room_journal_state
        WHERE room_id = ${input.claim.roomId}
          AND lease_token = ${input.claim.leaseToken}
        FOR UPDATE
      `),
    );
    const current = rows[0];
    if (!current) return;
    const failureCount = asNumber(current.extraction_failure_count) + 1;
    const parkedToken = await parkUnspentJournalGrant(tx, input.claim, "extraction", input.claim.batchId);
    if (parkedToken !== null) {
      const retryAt = new Date(now.getTime() + retryDelayMs(failureCount));
      await tx.update(roomJournalState).set({
        leaseToken: parkedToken, leaseExpiresAt: retryAt, extractionRetryAfter: retryAt,
        extractionFailureCount: failureCount, lastExtractionErrorCode: input.errorCode,
        lastExtractionErrorAt: now, updatedAt: now,
      }).where(eq(roomJournalState.roomId, input.claim.roomId));
      return;
    }
    const retryAfter = input.errorCode === "provider_outcome_unknown"
      ? null
      : new Date(now.getTime() + retryDelayMs(failureCount));
    const preserveKnownNonusableResult =
      input.errorCode === "input_authority_unavailable"
      && input.claim.previousModelResultKnownNonusable === true;
    await tx
      .update(roomJournalBatches)
      .set({
        status: "failed",
        ...(preserveKnownNonusableResult
          ? { errorCode: "invalid_output" as const }
          : {
              errorCode: input.errorCode,
              modelId: input.modelId,
              lastErrorAt: now,
              lastErrorAttempt: roomJournalBatches.attemptCount,
              lastErrorModelId: input.modelId,
            }),
      })
      .where(
        and(
          eq(roomJournalBatches.id, input.claim.batchId),
          eq(roomJournalBatches.roomId, input.claim.roomId),
        ),
      );
    await tx
      .update(roomJournalState)
      .set({
        leaseToken: null,
        leaseExpiresAt: null,
        extractionFailureCount: failureCount,
        extractionRetryAfter: retryAfter,
        lastExtractionErrorCode: input.errorCode,
        lastExtractionErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(roomJournalState.roomId, input.claim.roomId),
          eq(roomJournalState.leaseToken, input.claim.leaseToken),
        ),
      );
  });
}

export async function tryClaimCompactionRoom(
  db: DirectDatabase,
  roomId: string,
  now: Date,
  leaseMs = 2 * 60_000,
): Promise<CompactionClaim | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`);
    const stateRows = rowsFromExecute<{
      owner_id: string;
      namespace_id: string;
      kind: string;
      suspended_at: string | Date | null;
      has_agent: boolean;
      compaction_due_at: string | Date | null;
      compaction_lease_token: string | null;
      compaction_lease_expires_at: string | Date | null;
      compaction_retry_after: string | Date | null;
      last_compaction_error_code: string | null;
      last_compaction_error_at: string | Date | null;
      last_compaction_error_attempt: number | string | null;
      last_compaction_error_model_id: string | null;
      compaction_failure_count: number | string;
      compaction_last_attempt_known_nonusable: boolean;
      rebuild_generation: number | string;
      compaction_accepted_model_binding: unknown;
      compaction_accepted_plan: unknown;
    }>(
      await tx.execute(sql`
        SELECT
          r.owner_id,
          r.namespace_id,
          r.kind,
          rjs.suspended_at,
          EXISTS (
            SELECT 1
            FROM room_members rm
            INNER JOIN actors a ON a.id = rm.actor_id
            WHERE rm.room_id = r.id AND a.kind = 'agent'
          ) AS has_agent,
          rjs.compaction_due_at,
          rjs.compaction_lease_token,
          rjs.compaction_lease_expires_at,
          rjs.compaction_retry_after,
          rjs.last_compaction_error_code,
          rjs.last_compaction_error_at,
          rjs.last_compaction_error_attempt,
          rjs.last_compaction_error_model_id,
          rjs.compaction_failure_count,
          rjs.compaction_last_attempt_known_nonusable,
          rjs.rebuild_generation,
          rjs.compaction_accepted_model_binding,
          rjs.compaction_accepted_plan
        FROM room_journal_state rjs
        INNER JOIN rooms r ON r.id = rjs.room_id
        WHERE rjs.room_id = ${roomId}
          AND rjs.compaction_due_at IS NOT NULL
          AND rjs.rebuild_requested_at IS NULL
        FOR UPDATE OF rjs
      `),
    );
    const state = stateRows[0];
    if (!state || state.compaction_due_at === null) return null;
    if (state.last_compaction_error_code === "provider_outcome_unknown"
      && (state.last_compaction_error_attempt === null
        || state.last_compaction_error_attempt === undefined)) return null;
    if (state.compaction_accepted_model_binding !== null
      && state.compaction_accepted_plan === null) {
      throw new Error("Stenographer compaction acceptance is incoherent");
    }
    const legacyMissingCompactionBinding =
      state.compaction_accepted_model_binding === null
      && state.compaction_accepted_plan !== null;
    if (
      state.kind === "task" ||
      state.kind === "access" ||
      state.suspended_at !== null ||
      !state.has_agent
    ) {
      return null;
    }
    if (
      state.compaction_retry_after !== null &&
      asDate(state.compaction_retry_after).getTime() > now.getTime()
    ) {
      return null;
    }
    if (
      state.compaction_lease_token !== null &&
      state.compaction_lease_expires_at !== null &&
      asDate(state.compaction_lease_expires_at).getTime() > now.getTime()
    ) {
      return null;
    }
    const journal = await loadPromptJournal(tx, roomId, state.namespace_id);
    const allEvents = await loadAllRoomEvents(
      tx,
      roomId,
      state.namespace_id,
    );
    const rebuildGeneration = asNumber(state.rebuild_generation);
    if (
      state.compaction_accepted_plan !== null
      && (
        typeof state.compaction_accepted_plan !== "object"
        || Array.isArray(state.compaction_accepted_plan)
        || (state.compaction_accepted_plan as Record<string, unknown>)["owner"]
          !== "ordinary"
      )
    ) return null;
    const acceptedPlan = acceptedOrdinaryCompactionPlan(
      state.compaction_accepted_plan,
    );
    const currentAcceptedPlan = acceptedPlan === null ? null
      : currentAcceptedOrdinaryCompactionPlan({
          acceptedPlan,
          rebuildGeneration,
          latestRollup: journal.latestRollup,
          allEvents,
        });
    const planned = currentAcceptedPlan ?? planJournalCompaction({
          events: allEvents,
          rollups: journal.latestRollup ? [journal.latestRollup] : [],
        });
    if (state.last_compaction_error_code === "provider_outcome_unknown"
      && state.last_compaction_error_attempt != null && state.last_compaction_error_at !== null) {
      const current = planned.ok ? planned.plan : null;
      const workId = current && ordinaryCompactionOperationId(roomId, rebuildGeneration, journal.latestRollup?.id ?? null, current);
      const digest = current && workId ? compactionInputDigest(workId, journal.latestRollup, current)
        : createHash("sha256").update(JSON.stringify([roomId, rebuildGeneration, "no_compactable_input"])).digest("hex");
      const grants = roomJournalModelRecoveries;
      const [changed] = await tx.update(roomJournalModelRecoveries).set({ sourceChangedAt: now, replacementInputDigest: digest }).where(and(
        eq(grants.roomId, roomId), eq(grants.workKind, "compaction"),
        eq(grants.rebuildGeneration, rebuildGeneration),
        eq(grants.observedAttempt, asNumber(state.last_compaction_error_attempt)),
        eq(grants.observedFailureAt, asDate(state.last_compaction_error_at)),
        isNull(grants.spentAt), isNull(grants.sourceChangedAt),
        state.compaction_lease_token === null ? isNull(grants.claimLeaseToken)
          : eq(grants.claimLeaseToken, state.compaction_lease_token),
        // Only acceptance established for this legacy grant can be retired here.
        acceptedPlan === null ? undefined : and(isNotNull(grants.authorizedInputDigest), eq(grants.workId, acceptedPlan.operationId)),
        !workId || (acceptedPlan !== null && currentAcceptedPlan === null) ? undefined
          : or(ne(grants.workId, workId), ne(grants.authorizedInputDigest, digest)),
      )).returning({ id: grants.id });
      if (changed) {
        await tx.update(roomJournalState).set({
          compactionAcceptedPlan: null, compactionAcceptedModelBinding: null,
          compactionLeaseToken: null, compactionLeaseExpiresAt: null,
          compactionRetryAfter: null, updatedAt: now,
        }).where(eq(roomJournalState.roomId, roomId));
        return null;
      }
    }
    if (acceptedPlan !== null && currentAcceptedPlan === null) return null;
    if (!planned.ok) {
      const failureCount = asNumber(state.compaction_failure_count) + 1;
      await tx
        .update(roomJournalState)
        .set({
          compactionLeaseToken: null,
          compactionLeaseExpiresAt: null,
          compactionFailureCount: failureCount,
          compactionRetryAfter: new Date(
            now.getTime() + retryDelayMs(failureCount),
          ),
          lastCompactionErrorCode: "input_too_large",
          lastCompactionErrorAt: now,
          lastCompactionErrorAttempt: failureCount,
          lastCompactionErrorModelId: null,
          updatedAt: now,
        })
        .where(eq(roomJournalState.roomId, roomId));
      return null;
    }
    if (!planned.plan) {
      await tx
        .update(roomJournalState)
        .set({ compactionDueAt: null, updatedAt: now })
        .where(eq(roomJournalState.roomId, roomId));
      return null;
    }
    const modelOperationId = acceptedPlan?.operationId
      ?? ordinaryCompactionOperationId(
        roomId,
        rebuildGeneration,
        journal.latestRollup?.id ?? null,
        planned.plan,
      );
    const claimPlan = acceptedPlan ?? Object.freeze({
      version: 1 as const,
      owner: "ordinary" as const,
      operationId: modelOperationId,
      rebuildGeneration,
      previousRollupId: journal.latestRollup?.id ?? null,
      selectedEventIds: Object.freeze(
        planned.plan.selectedEvents.map((event) => event.id),
      ),
      protectedTailEventIds: Object.freeze(
        planned.plan.protectedTail.map((event) => event.id),
      ),
    });
    const lastCompactionErrorAttempt = state.last_compaction_error_attempt === null
      || state.last_compaction_error_attempt === undefined
      ? null
      : asNumber(state.last_compaction_error_attempt);
    const [spentManualInvalidOutput] =
      state.last_compaction_error_code === "invalid_output"
      && state.last_compaction_error_at !== null
      && state.last_compaction_error_model_id !== null
      && lastCompactionErrorAttempt !== null
      && lastCompactionErrorAttempt > 0
        ? await tx.select({ id: roomJournalModelRecoveries.id })
            .from(roomJournalModelRecoveries)
            .where(and(
              eq(roomJournalModelRecoveries.roomId, roomId),
              eq(roomJournalModelRecoveries.workKind, "compaction"),
              eq(roomJournalModelRecoveries.workId, modelOperationId),
              eq(roomJournalModelRecoveries.rebuildGeneration, rebuildGeneration),
              eq(roomJournalModelRecoveries.observedAttempt, lastCompactionErrorAttempt - 1),
              eq(roomJournalModelRecoveries.targetModelId, state.last_compaction_error_model_id),
              isNotNull(roomJournalModelRecoveries.claimLeaseToken),
              isNotNull(roomJournalModelRecoveries.spentAt),
              lte(roomJournalModelRecoveries.spentAt, asDate(state.last_compaction_error_at)),
            ))
            .limit(1)
            .for("update", { of: roomJournalModelRecoveries })
        : [];
    const reclaimingUnspentRecovery =
      lastCompactionErrorAttempt !== null
      && state.compaction_lease_token !== null
      && state.compaction_lease_expires_at !== null
      && asDate(state.compaction_lease_expires_at).getTime() <= now.getTime();
    const claimingFreshRecovery =
      lastCompactionErrorAttempt !== null
      && (
        state.last_compaction_error_code === "provider_outcome_unknown"
        || spentManualInvalidOutput !== undefined
      );
    const [manualRecovery] = !claimingFreshRecovery && !reclaimingUnspentRecovery
      ? []
      : await tx.select({
          id: roomJournalModelRecoveries.id,
          targetModelId: roomJournalModelRecoveries.targetModelId,
          claimLeaseToken: roomJournalModelRecoveries.claimLeaseToken,
          freshServiceInputs: roomJournalModelRecoveries.freshServiceInputs,
          authorizedAt: roomJournalModelRecoveries.authorizedAt,
        }).from(roomJournalModelRecoveries).where(and(
          eq(roomJournalModelRecoveries.roomId, roomId),
          eq(roomJournalModelRecoveries.workKind, "compaction"),
          eq(roomJournalModelRecoveries.workId, modelOperationId),
          eq(roomJournalModelRecoveries.rebuildGeneration, rebuildGeneration),
          eq(roomJournalModelRecoveries.observedAttempt, lastCompactionErrorAttempt),
          isNull(roomJournalModelRecoveries.spentAt),
          isNull(roomJournalModelRecoveries.sourceChangedAt),
          or(
            eq(roomJournalModelRecoveries.freshServiceInputs, false),
            isNotNull(roomJournalModelRecoveries.authorizedInputDigest),
          ),
          reclaimingUnspentRecovery
            ? and(
                eq(roomJournalModelRecoveries.claimLeaseToken, state.compaction_lease_token!),
                isNotNull(roomJournalModelRecoveries.claimedAt),
                lte(roomJournalModelRecoveries.claimedAt, now),
              )
            : and(
                isNull(roomJournalModelRecoveries.claimLeaseToken),
                isNull(roomJournalModelRecoveries.claimedAt),
              ),
        )).limit(1)
          .for("update", { of: roomJournalModelRecoveries });
    if (claimingFreshRecovery
      && manualRecovery === undefined) return null;
    if (legacyMissingCompactionBinding && manualRecovery === undefined) {
      return null;
    }
    const replaySafety = await resolveModelAttemptReplaySafety({
      kind: "operation", roomId, callType: "room_event_compaction", operationId: modelOperationId,
    }, {
      db: tx,
      knownNonusableResult:
        state.compaction_last_attempt_known_nonusable
        && state.compaction_lease_token === null
        && acceptedPlan !== null,
    });
    const freshReplaySafety = manualRecovery?.freshServiceInputs === true
      ? await resolveFreshCompactionAttemptReplaySafety({
          roomId,
          operationId: modelOperationId,
          occurredAtOrAfter: manualRecovery.authorizedAt,
        }, tx)
      : null;
    if (freshReplaySafety?.decision === "block_unknown") {
      if (!await retireFreshCompactionGrant(
        tx,
        roomId,
        manualRecovery!.id,
        now,
      )) {
        throw new Error("Fresh compaction recovery authorization changed");
      }
      return null;
    }
    if (replaySafety.decision === "block_unknown" && manualRecovery === undefined) {
      await tx.update(roomJournalState).set({
        compactionLeaseToken: null, compactionLeaseExpiresAt: null,
        compactionRetryAfter: null, lastCompactionErrorCode: "provider_outcome_unknown",
        lastCompactionErrorAt: now, updatedAt: now,
      }).where(eq(roomJournalState.roomId, roomId));
      return null;
    }
    const leaseToken = randomUUID();
    if (manualRecovery !== undefined) {
      let binding: ReturnType<typeof parseMemoryOperationBinding> | null = null;
      if (state.compaction_accepted_model_binding !== null) {
        try {
          binding = parseMemoryOperationBinding(
            state.compaction_accepted_model_binding,
          );
        } catch {
          throw new Error("Manual Stenographer compaction recovery binding changed");
        }
      }
      if (binding !== null
        && (binding.kind !== "service"
          || binding.role !== "memorySummarization")) {
        throw new Error("Manual Stenographer compaction recovery binding changed");
      }
      if (reclaimingUnspentRecovery
        && binding !== null
        && binding.modelId !== manualRecovery.targetModelId) {
        throw new Error("Manual Stenographer compaction recovery binding changed");
      }
      await tx.update(roomJournalModelRecoveries).set({
        claimLeaseToken: leaseToken,
        claimedAt: now,
      }).where(and(
        eq(roomJournalModelRecoveries.id, manualRecovery.id),
        isNull(roomJournalModelRecoveries.spentAt),
        reclaimingUnspentRecovery
          ? eq(
              roomJournalModelRecoveries.claimLeaseToken,
              manualRecovery.claimLeaseToken!,
            )
          : and(
              isNull(roomJournalModelRecoveries.claimLeaseToken),
              isNull(roomJournalModelRecoveries.claimedAt),
            ),
      ));
      if (!reclaimingUnspentRecovery && binding !== null) {
        await tx.update(roomJournalState).set({
          compactionAcceptedModelBinding: {
            ...binding,
            modelId: manualRecovery.targetModelId,
          },
        }).where(eq(roomJournalState.roomId, roomId));
      }
    }
    await tx
      .update(roomJournalState)
      .set({
        compactionLeaseToken: leaseToken,
        compactionLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        compactionLastAttemptKnownNonusable: false,
        updatedAt: now,
      })
      .where(eq(roomJournalState.roomId, roomId));
    return {
      roomId,
      ownerId: state.owner_id,
      leaseToken,
      attemptCount: asNumber(state.compaction_failure_count) + 1,
      modelOperationId,
      acceptedPlan: claimPlan,
      plan: planned.plan,
      namespaceId: state.namespace_id,
      previousRollup: journal.latestRollup,
      ...(manualRecovery === undefined
        ? {}
        : { manualModelRecoveryId: manualRecovery.id, manualRecoveryModelId: manualRecovery.targetModelId }),
      ...(manualRecovery?.freshServiceInputs ? { requiresCurrentServicePayer: true as const } : {}),
    };
  });
}

export async function compactionCandidateRooms(
  db: DirectDatabase, now: Date, limit = 20,
): Promise<{ roomId: string }[]> {
  const agentMember = db.select({ one: sql`1` }).from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(eq(roomMembers.roomId, rooms.id), eq(actors.kind, "agent")));
  const manualRecovery = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalState.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.observedAttempt, roomJournalState.lastCompactionErrorAttempt),
      isNull(roomJournalModelRecoveries.spentAt),
      isNull(roomJournalModelRecoveries.sourceChangedAt),
      or(
        eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalState.compactionAcceptedPlan}->>'operationId'`),
        and(
          isNull(roomJournalState.compactionAcceptedPlan),
          isNull(roomJournalState.compactionAcceptedModelBinding),
          eq(roomJournalState.lastCompactionErrorCode, "provider_outcome_unknown"),
          eq(roomJournalModelRecoveries.observedFailureAt, roomJournalState.lastCompactionErrorAt),
          or(
            and(
              isNull(roomJournalModelRecoveries.claimLeaseToken),
              isNull(roomJournalModelRecoveries.claimedAt),
            ),
            and(
              isNotNull(roomJournalModelRecoveries.claimLeaseToken),
              isNotNull(roomJournalModelRecoveries.claimedAt),
              eq(roomJournalModelRecoveries.claimLeaseToken, roomJournalState.compactionLeaseToken),
            ),
          ),
        ),
      ),
    ));
  const spentManualInvalidOutput = db.select({ one: sql`1` })
    .from(roomJournalModelRecoveries)
    .where(and(
      eq(roomJournalModelRecoveries.roomId, roomJournalState.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
      eq(roomJournalModelRecoveries.rebuildGeneration, roomJournalState.rebuildGeneration),
      eq(roomJournalModelRecoveries.workId, sql<string>`${roomJournalState.compactionAcceptedPlan}->>'operationId'`),
      eq(roomJournalModelRecoveries.targetModelId, roomJournalState.lastCompactionErrorModelId),
      eq(
        roomJournalModelRecoveries.observedAttempt,
        sql<number>`${roomJournalState.lastCompactionErrorAttempt} - 1`,
      ),
      isNotNull(roomJournalModelRecoveries.claimLeaseToken),
      isNotNull(roomJournalModelRecoveries.spentAt),
      lte(roomJournalModelRecoveries.spentAt, roomJournalState.lastCompactionErrorAt),
    ));
  return db
    .select({ roomId: roomJournalState.roomId })
    .from(roomJournalState)
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(
      and(
        notInArray(rooms.kind, ["task", "access"]),
        isNull(roomJournalState.suspendedAt),
        exists(agentMember),
        isNotNull(roomJournalState.compactionDueAt),
        isNull(roomJournalState.rebuildRequestedAt),
        or(
          isNull(roomJournalState.lastCompactionErrorCode),
          and(
            ne(roomJournalState.lastCompactionErrorCode, "provider_outcome_unknown"),
            or(
              ne(roomJournalState.lastCompactionErrorCode, "invalid_output"),
              notExists(spentManualInvalidOutput),
            ),
          ),
          exists(manualRecovery),
        ),
        or(
          isNull(roomJournalState.compactionRetryAfter),
          lte(roomJournalState.compactionRetryAfter, now),
        ),
        or(
          isNull(roomJournalState.compactionLeaseToken),
          isNull(roomJournalState.compactionLeaseExpiresAt),
          lte(roomJournalState.compactionLeaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(roomJournalState.compactionDueAt),
      asc(roomJournalState.roomId),
    )
    .limit(limit);
}

export async function claimNextCompaction(
  opts: {
    now?: Date;
    leaseMs?: number;
    candidateLimit?: number;
    db?: DirectDatabase;
  } = {},
): Promise<CompactionClaim | null> {
  const db = opts.db ?? getSharedDirectDb();
  const now = opts.now ?? new Date();
  const candidates = await compactionCandidateRooms(db, now, Math.max(1, opts.candidateLimit ?? 20));
  for (const row of candidates) {
    const claim = await tryClaimCompactionRoom(
      db,
      row.roomId,
      now,
      opts.leaseMs ?? 2 * 60_000,
    );
    if (claim) return claim;
  }
  return null;
}

export async function publishCompaction(input: {
  claim: CompactionClaim;
  content: string;
  modelId: string;
  now?: Date;
  db?: DirectDatabase;
  ordinaryFallbackReason?: "device" | "authority";
  modelExposureDependencies?: readonly DurableModelExposureDependency[];
}): Promise<boolean> {
  const db = input.db ?? getSharedDirectDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM rooms WHERE id = ${input.claim.roomId} FOR UPDATE`,
    );
    const agentMember = tx.select({ one: sql`1` })
      .from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(roomMembers.roomId, roomJournalState.roomId),
        eq(actors.kind, "agent"),
      ));
    const [state] = await tx.select({
      compactionLeaseToken: roomJournalState.compactionLeaseToken,
      suspendedAt: roomJournalState.suspendedAt,
      namespaceId: rooms.namespaceId,
      rebuildGeneration: roomJournalState.rebuildGeneration,
      acceptedModelBinding:
        roomJournalState.compactionAcceptedModelBinding,
      acceptedPlan: roomJournalState.compactionAcceptedPlan,
      hasAgent: exists(agentMember),
    })
      .from(roomJournalState)
      .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
      .where(eq(roomJournalState.roomId, input.claim.roomId))
      .for("update", { of: roomJournalState });
    if (
      !state ||
      state.compactionLeaseToken !== input.claim.leaseToken ||
      state.suspendedAt !== null ||
      !state.hasAgent ||
      state.acceptedModelBinding === null
    ) {
      return false;
    }
    const acceptedPlan = acceptedOrdinaryCompactionPlan(state.acceptedPlan);
    if (
      acceptedPlan === null
      || acceptedPlan.operationId !== input.claim.acceptedPlan.operationId
      || acceptedPlan.rebuildGeneration
        !== input.claim.acceptedPlan.rebuildGeneration
      || acceptedPlan.previousRollupId
        !== input.claim.acceptedPlan.previousRollupId
      || JSON.stringify(acceptedPlan.selectedEventIds)
        !== JSON.stringify(input.claim.acceptedPlan.selectedEventIds)
      || JSON.stringify(acceptedPlan.protectedTailEventIds)
        !== JSON.stringify(input.claim.acceptedPlan.protectedTailEventIds)
      || state.rebuildGeneration !== acceptedPlan.rebuildGeneration
    ) return false;
    const selected = input.claim.plan.selectedEvents;
    if (selected.length === 0) return false;
    if (input.modelExposureDependencies !== undefined) {
      const currentJournal = await loadPromptJournal(
        tx,
        input.claim.roomId,
        state.namespaceId,
      );
      const currentEvents = await loadAllRoomEvents(
        tx,
        input.claim.roomId,
        state.namespaceId,
      );
      const currentBySequence = new Map(
        currentEvents.map((event) => [event.sequence, event]),
      );
      const exposure = input.claim.plan.modelExposure;
      const dependencies: Array<DurableModelExposureDependency | undefined> = [
        ...(exposure.previousRollupThroughEventSequence === null
          ? []
          : currentJournal.latestRollup?.throughEventSequence
              === exposure.previousRollupThroughEventSequence
            ? [currentJournal.latestRollup.modelExposureDependency]
            : [undefined]),
        ...exposure.selectedEventSequences.map((sequence) =>
          currentBySequence.get(sequence)?.modelExposureDependency
        ),
        ...exposure.protectedTailEventSequences.map((sequence) =>
          currentBySequence.get(sequence)?.modelExposureDependency
        ),
      ];
      if (
        dependencies.length === 0
        || dependencies.some((dependency) => dependency === undefined)
        || canonicalModelExposureDependencies(
          dependencies as DurableModelExposureDependency[],
        ) !== canonicalModelExposureDependencies(
          input.modelExposureDependencies,
        )
        || selected.some((expected) => {
          const current = currentBySequence.get(expected.sequence);
          return current === undefined
            || current.id !== expected.id
            || current.statement !== expected.statement
            || current.status !== expected.status;
        })
      ) return false;
    }
    const selectedRows = input.modelExposureDependencies !== undefined
      ? []
      : await tx
        .select({
          id: roomEvents.id,
          sequence: roomEvents.sequence,
          statement: roomEvents.statement,
          status: roomEvents.status,
        })
        .from(roomEvents)
        .where(
          and(
            eq(roomEvents.roomId, input.claim.roomId),
            inArray(
              roomEvents.id,
              selected.map((event) => event.id),
            ),
          ),
        )
        .orderBy(asc(roomEvents.sequence));
    if (
      input.modelExposureDependencies === undefined
      && (selectedRows.length !== selected.length ||
      selectedRows.some((row, index) => {
        const expected = selected[index]!;
        return (
          row.id !== expected.id ||
          row.sequence !== expected.sequence ||
          row.statement !== expected.statement ||
          row.status !== expected.status
        );
      }))
    ) {
      return false;
    }
    const insertedRows = await tx
      .insert(roomEventRollups)
      .values({
        roomId: input.claim.roomId,
        throughEventSequence: input.claim.plan.throughEventSequence,
        content: input.content,
        modelExposureDependencies:
          input.modelExposureDependencies ?? null,
        sourceEventCount:
          (input.claim.plan.previousRollup?.sourceEventCount ?? 0) +
          selected.length,
        modelId: input.modelId,
        compactorVersion: "m219-v1",
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [
          roomEventRollups.roomId,
          roomEventRollups.throughEventSequence,
          roomEventRollups.compactorVersion,
        ],
      })
      .returning({ id: roomEventRollups.id });
    if (insertedRows.length > 1) {
      throw new Error("Stenographer compaction insert was ambiguous");
    }
    const winningRows = await tx
      .select({
        id: roomEventRollups.id,
        roomId: roomEventRollups.roomId,
        throughEventSequence: roomEventRollups.throughEventSequence,
        content: roomEventRollups.content,
        sourceEventCount: roomEventRollups.sourceEventCount,
        modelId: roomEventRollups.modelId,
        compactorVersion: roomEventRollups.compactorVersion,
        createdAt: roomEventRollups.createdAt,
        ordinaryFallbackReason: roomEventRollups.ordinaryFallbackReason,
        ordinaryFallbackRebuildGeneration:
          roomEventRollups.ordinaryFallbackRebuildGeneration,
        ordinaryOutputFingerprint: roomEventRollups.ordinaryOutputFingerprint,
        modelExposureDependencies:
          roomEventRollups.modelExposureDependencies,
      })
      .from(roomEventRollups)
      .where(and(
        eq(roomEventRollups.roomId, input.claim.roomId),
        eq(
          roomEventRollups.throughEventSequence,
          input.claim.plan.throughEventSequence,
        ),
        eq(roomEventRollups.compactorVersion, "m219-v1"),
      ))
      .limit(2);
    const winner = winningRows[0];
    if (winningRows.length !== 1 || winner === undefined || winner.content === null) {
      throw new Error("Stenographer compaction output is unavailable");
    }
    const insertedId = insertedRows[0]?.id ?? null;
    if (insertedId !== null && insertedId !== winner.id) {
      throw new Error("Stenographer compaction winner changed");
    }
    if (
      canonicalModelExposureDependencies(winner.modelExposureDependencies)
        !== canonicalModelExposureDependencies(input.modelExposureDependencies)
    ) {
      throw new Error("Stenographer compaction model exposure changed");
    }
    if (input.ordinaryFallbackReason !== undefined) {
      const existingReason = winner.ordinaryFallbackReason;
      const existingGeneration = winner.ordinaryFallbackRebuildGeneration;
      const existingFingerprint = winner.ordinaryOutputFingerprint;
      if (
        (existingReason === null) !== (existingGeneration === null)
        || (existingReason === null) !== (existingFingerprint === null)
      ) {
        throw new Error("Stenographer compaction provenance is incoherent");
      }
      const provenanceReason = existingReason ?? input.ordinaryFallbackReason;
      const provenanceGeneration = existingGeneration
        ?? asNumber(state.rebuildGeneration);
      const payloadBytes = encodeRoomEventRollupPayloadV1({
        rollupId: winner.id,
        roomId: winner.roomId,
        namespaceId: state.namespaceId,
        throughEventSequence: winner.throughEventSequence,
        content: winner.content,
        sourceEventCount: winner.sourceEventCount,
        modelId: winner.modelId,
        compactorVersion: winner.compactorVersion,
        createdAt: winner.createdAt.toISOString(),
        ...(winner.modelExposureDependencies === null
          || winner.modelExposureDependencies === undefined
          ? {}
          : {
              modelExposureDependencies:
                rollupPayloadExposureDependencies(
                  winner.modelExposureDependencies,
                ),
            }),
      });
      const fingerprint = stenographerOrdinaryOutputFingerprint({
        kind: "compaction",
        receiptId: winner.id,
        roomId: winner.roomId,
        namespaceId: state.namespaceId,
        rebuildGeneration: provenanceGeneration,
        fallbackReason: provenanceReason,
        outputs: [{
          logicalId: winner.id,
          objectType: "room_event_rollup",
          createdAt: winner.createdAt.getTime(),
          payloadBytes,
        }],
      });
      try {
        if (existingFingerprint !== null) {
          if (!sameBytes(existingFingerprint, fingerprint)) {
            throw new Error("Stenographer compaction provenance changed");
          }
        } else if (insertedId !== null) {
          const updated = await tx.update(roomEventRollups).set({
            ordinaryFallbackReason: provenanceReason,
            ordinaryFallbackRebuildGeneration: provenanceGeneration,
            ordinaryOutputFingerprint: fingerprint,
          }).where(and(
            eq(roomEventRollups.id, winner.id),
            eq(roomEventRollups.roomId, input.claim.roomId),
            eq(
              roomEventRollups.throughEventSequence,
              input.claim.plan.throughEventSequence,
            ),
            isNull(roomEventRollups.ordinaryFallbackReason),
            isNull(roomEventRollups.ordinaryFallbackRebuildGeneration),
            isNull(roomEventRollups.ordinaryOutputFingerprint),
          )).returning({ id: roomEventRollups.id });
          if (updated.length !== 1 || updated[0]?.id !== winner.id) {
            throw new Error("Stenographer compaction provenance changed");
          }
        }
      } finally {
        payloadBytes.fill(0);
        fingerprint.fill(0);
      }
    }
    await tx.execute(sql`
      WITH remaining AS (
        SELECT
          COUNT(*)::integer AS event_count,
          COALESCE(SUM(char_length(statement)), 0)::integer AS statement_chars
        FROM room_events
        WHERE room_id = ${input.claim.roomId}
          AND status = 'active'
          AND sequence > ${input.claim.plan.throughEventSequence}
      )
      UPDATE room_journal_state rjs
      SET
        compaction_accepted_model_binding = NULL,
        compaction_accepted_plan = NULL,
        compaction_lease_token = NULL,
        compaction_lease_expires_at = NULL,
        compaction_failure_count = 0,
        compaction_last_attempt_known_nonusable = FALSE,
        compaction_retry_after = NULL,
        last_compaction_completed_at = ${timestampParam(now)},
        compaction_due_at = CASE
          WHEN remaining.event_count >= 200 OR remaining.statement_chars >= 40000
            THEN rjs.compaction_due_at
          ELSE NULL
        END,
        updated_at = ${timestampParam(now)}
      FROM remaining
      WHERE rjs.room_id = ${input.claim.roomId}
        AND rjs.compaction_lease_token = ${input.claim.leaseToken}
    `);
    return true;
  });
}

export async function failCompaction(input: {
  claim: CompactionClaim;
  errorCode: StenographerErrorCode;
  modelId: string | null;
  now?: Date;
  db?: DirectDatabase;
}): Promise<void> {
  const db = input.db ?? getSharedDirectDb();
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM rooms WHERE id = ${input.claim.roomId} FOR UPDATE`,
    );
    const rows = rowsFromExecute<{
      compaction_failure_count: number | string;
      compaction_accepted_model_binding: unknown;
      compaction_accepted_plan: unknown;
    }>(
      await tx.execute(sql`
        SELECT
          compaction_failure_count,
          compaction_accepted_model_binding,
          compaction_accepted_plan
        FROM room_journal_state
        WHERE room_id = ${input.claim.roomId}
          AND compaction_lease_token = ${input.claim.leaseToken}
        FOR UPDATE
      `),
    );
    if (!rows[0]) return;
    const current = rows[0];
    const failureCount = asNumber(current.compaction_failure_count) + 1;
    if (input.errorCode === "input_authority_unavailable" && input.claim.requiresCurrentServicePayer
      && input.claim.manualModelRecoveryId
      && await retireFreshCompactionGrant(tx, input.claim.roomId, input.claim.manualModelRecoveryId, now)) return;
    const parkedToken = await parkUnspentJournalGrant(tx, input.claim, "compaction", input.claim.modelOperationId);
    if (parkedToken !== null) {
      // Preserve the failure coordinates that authorize this exact compaction.
      // No new provider attempt happened. The first worker after backoff can
      // resume the same reservation even if the server model has changed.
      const retryAt = new Date(now.getTime() + retryDelayMs(failureCount));
      await tx.update(roomJournalState).set({
        compactionLeaseToken: parkedToken, compactionLeaseExpiresAt: retryAt,
        compactionRetryAfter: retryAt, updatedAt: now,
      }).where(eq(roomJournalState.roomId, input.claim.roomId));
      return;
    }
    await tx
      .update(roomJournalState)
      .set({
        compactionLeaseToken: null,
        compactionLeaseExpiresAt: null,
        compactionFailureCount: failureCount,
        compactionLastAttemptKnownNonusable:
          input.errorCode === "invalid_output"
          && current.compaction_accepted_model_binding !== null
          && current.compaction_accepted_model_binding !== undefined
          && current.compaction_accepted_plan !== null
          && current.compaction_accepted_plan !== undefined,
        compactionRetryAfter: input.errorCode === "provider_outcome_unknown"
          ? null
          : new Date(now.getTime() + retryDelayMs(failureCount)),
        lastCompactionErrorCode: input.errorCode,
        lastCompactionErrorAt: now,
        lastCompactionErrorAttempt: input.claim.attemptCount,
        lastCompactionErrorModelId: input.modelId,
        updatedAt: now,
      })
      .where(
        and(
          eq(roomJournalState.roomId, input.claim.roomId),
          eq(
            roomJournalState.compactionLeaseToken,
            input.claim.leaseToken,
          ),
        ),
      );
  });
}
