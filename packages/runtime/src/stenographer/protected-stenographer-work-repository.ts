import {sourceInventoryIsCurrent, type CurrentSourceCheckInput} from "./protected-publication-repository";
import { createHash, randomUUID } from "node:crypto";
import {
  acquireEncryptionPublicationFence,
  acquireEncryptionConsumptionFence,
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  or,
  roomEvents,
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalState,
  rooms,
  sql,
} from "@nautilo/db";
import {
  assertConversationProductCanonicalTransactionRunner,
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductCanonicalTransactionRunner,
  PROTECTED_JOURNAL_EVENT_PROJECTION_SQL,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "@nautilo/lattice-bridge/server";

const typedDb = conversationProductTypedDb;

import {
  fingerprintProtectedStenographerCoveredRange,
  planProtectedStenographerBatch,
  PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS,
  type ProtectedStenographerBatchPlan,
  type ProtectedStenographerSourceMetadata,
} from "./protected-batch-planner";
import {
  planProtectedStenographerCompaction,
  PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS,
} from "./protected-stenographer-compaction-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS,
  type ProtectedStenographerMessageBinding,
  type ProtectedStenographerSourceBinding,
} from "./protected-source-loader";

export const PROTECTED_STENOGRAPHER_WORK_LEASE_MS = 2 * 60_000;
export const PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION = "m241-v1";
export const PROTECTED_STENOGRAPHER_WORK_COMPACTOR_VERSION = "m241-v1";
export const PROTECTED_STENOGRAPHER_MAX_PRIOR_CONTEXT_MESSAGES = 50;
export const PROTECTED_STENOGRAPHER_OUTPUT_SLOT_COUNT = 5;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const COMPACTION_OLDEST_EVENT_LIMIT =
  PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS - 50;

export type StenographerLane = "live" | "historical";
type StenographerMessageRole = "user" | "assistant" | "tool" | "system";

export interface ProtectedStenographerEventOutputSlot {
  readonly eventId: string;
  readonly objectId: string;
}

export interface ProtectedStenographerExtractionWorkClaim {
  readonly kind: "extraction";
  readonly workKind:
    | "stenographer.extraction"
    | "stenographer.historical"
    | "stenographer.rebuild";
  readonly workId: string;
  readonly sourceBatchId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly ownerId: string;
  readonly rebuildGeneration: number;
  /** Present only for work pinned to an active prepared rebuild. */
  readonly rebuildTargetMessageId?: number;
  readonly lane: StenographerLane;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly attemptCount: number;
  readonly fromMessageIdExclusive: number;
  readonly throughMessageIdInclusive: number;
  readonly trigger: ProtectedStenographerBatchPlan["trigger"];
  readonly requiresContentRecheck: boolean;
  readonly bindings: readonly ProtectedStenographerSourceBinding[];
  readonly inputObjectIds: readonly string[];
  readonly coveredRangeFingerprint: Uint8Array;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly participantIds: readonly string[];
  readonly outputSlots: readonly ProtectedStenographerEventOutputSlot[];
  readonly extractorVersion:
    typeof PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION;
  readonly createdAt: string;
}

export interface ProtectedStenographerCompactionOutputSlot {
  readonly rollupId: string;
  readonly objectId: string;
}

export interface ProtectedStenographerCompactionWorkClaim {
  readonly kind: "compaction";
  readonly workKind: "stenographer.compaction";
  readonly workId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly ownerId: string;
  readonly rebuildGeneration: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly attemptCount: number;
  readonly bindings: readonly ProtectedStenographerSourceBinding[];
  readonly inputObjectIds: readonly string[];
  readonly sourceBindingFingerprint: Uint8Array;
  readonly activeEventCount: number;
  readonly selectedEventCount: number;
  readonly hasDeferredMiddle: boolean;
  readonly outputSlot: ProtectedStenographerCompactionOutputSlot;
  readonly compactorVersion:
    typeof PROTECTED_STENOGRAPHER_WORK_COMPACTOR_VERSION;
  readonly createdAt: string;
}

export type ProtectedStenographerExtractionClaimResult =
  | Readonly<{
    readonly status: "claimed";
    readonly claim: ProtectedStenographerExtractionWorkClaim;
  }>
  | Readonly<{
    readonly status: "completed";
    readonly completion: "excluded_range_acknowledged";
    readonly roomId: string;
    readonly namespaceId: string;
    readonly rebuildGeneration: number;
    readonly lane: StenographerLane;
    readonly workKind:
      | "stenographer.extraction"
      | "stenographer.historical"
      | "stenographer.rebuild";
    readonly fromMessageIdExclusive: number;
    readonly throughMessageIdInclusive: number;
    readonly sourceFingerprint: Uint8Array;
  }>
  | Readonly<{
    readonly status: "blocked";
    readonly reason:
      | "invalid_metadata"
      | "protected_source_unavailable"
      | "input_bound_exceeded";
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "missing"
      | "ineligible"
      | "not_due"
      | "leased"
      | "rebuild_pending"
      | "stale";
  }>;

export type ProtectedStenographerCompactionClaimResult =
  | Readonly<{
    readonly status: "claimed";
    readonly claim: ProtectedStenographerCompactionWorkClaim;
  }>
  | Readonly<{
    readonly status: "blocked";
    readonly reason:
      | "invalid_metadata"
      | "protected_source_unavailable"
      | "duplicate_identity"
      | "out_of_order";
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "missing"
      | "ineligible"
      | "not_due"
      | "leased"
      | "rebuild_pending"
      | "stale";
  }>;

interface RepositoryOptions {
  readonly leaseToken?: () => string;
}

interface ExtractionRecoveryContext {
  readonly workId: string;
  readonly fromMessageIdExclusive: number;
  readonly throughMessageIdInclusive: number;
  readonly extractorVersion: string;
  readonly lane: StenographerLane;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly status: "pending" | "running" | "failed";
  readonly currentRunningBatchId: string | null;
}

interface RebuildClaimContext {
  readonly rebuildGeneration: number;
  readonly targetMessageId: number;
}

interface CompactionRecoveryContext {
  readonly workId: string;
  readonly roomId: string;
  readonly rebuildGeneration: number;
  readonly throughEventSequence: number;
  readonly createdAt: string;
}

interface ProductWorkState {
  readonly roomId: string;
  readonly namespaceId: string;
  readonly ownerId: string;
  readonly roomKind: string;
  readonly suspendedAt: Date | null;
  readonly hasAgent: boolean;
  readonly cursor: number;
  readonly historicalStatus: "pending" | "completed" | "not_needed";
  readonly historicalCursor: number | null;
  readonly historicalTarget: number | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly extractionRetryAfter: Date | null;
  readonly extractionFailureCount: number;
  readonly rebuildGeneration: number;
  readonly rebuildRequestedAt: Date | null;
  readonly rebuildTarget: number | null;
  readonly upperBound: number | null;
  readonly retryFixedRange: boolean;
  readonly priorContextFloor: number;
  readonly priorContextLimit: number;
  readonly compactionDueAt: Date | null;
  readonly compactionLeaseToken: string | null;
  readonly compactionLeaseExpiresAt: Date | null;
  readonly compactionRetryAfter: Date | null;
  readonly compactionFailureCount: number;
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function portableId(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < minimum
  ) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return normalized;
}

function date(label: string, value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return new Date(value);
}

/** Drizzle's owned postgres-js pool returns raw timestamp strings on its bridge. */
function rowDate(label: string, value: unknown): Date {
  return date(label, typeof value === "string" ? new Date(value) : value);
}

function nullableDate(label: string, value: unknown): Date | null {
  return value === null ? null : rowDate(label, value);
}

function boolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be boolean`);
  }
  return value;
}

function nullableCounter(label: string, value: unknown): number | null {
  return value === null ? null : counter(label, value);
}

function nullableText(
  label: string,
  value: unknown,
  maximum = 256,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
  ) {
    throw new TypeError(`${label} must be bounded text`);
  }
  return value;
}

function exactlyOne(
  label: string,
  rows: readonly ConversationProductDatabaseRow[],
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function role(value: unknown): StenographerMessageRole {
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) {
    throw new TypeError("protected Stenographer message role is invalid");
  }
  return value;
}

function stateFromRow(
  row: ConversationProductDatabaseRow,
): ProductWorkState {
  const leaseToken = row["lease_token"] === null
    ? null
    : uuid("protected extraction lease token", row["lease_token"]);
  const leaseExpiresAt = nullableDate(
    "protected extraction lease expiry",
    row["lease_expires_at"],
  );
  const compactionLeaseToken = row["compaction_lease_token"] === null
    ? null
    : uuid(
      "protected compaction lease token",
      row["compaction_lease_token"],
    );
  const compactionLeaseExpiresAt = nullableDate(
    "protected compaction lease expiry",
    row["compaction_lease_expires_at"],
  );
  if (
    (leaseToken === null) !== (leaseExpiresAt === null)
    || (compactionLeaseToken === null)
      !== (compactionLeaseExpiresAt === null)
  ) {
    throw new TypeError("protected Stenographer lease state is incoherent");
  }
  const historicalStatus = row["historical_backfill_status"];
  if (
    historicalStatus !== "pending"
    && historicalStatus !== "completed"
    && historicalStatus !== "not_needed"
  ) {
    throw new TypeError(
      "protected Stenographer historical state is invalid",
    );
  }
  return Object.freeze({
    roomId: uuid("protected Stenographer Room", row["room_id"]),
    namespaceId: uuid(
      "protected Stenographer Namespace",
      row["namespace_id"],
    ),
    ownerId: uuid("protected Stenographer owner", row["owner_id"]),
    roomKind: portableId(
      "protected Stenographer Room kind",
      row["room_kind"],
    ),
    suspendedAt: nullableDate(
      "protected Stenographer suspension",
      row["suspended_at"],
    ),
    hasAgent: boolean(
      "protected Stenographer Agent eligibility",
      row["has_agent"],
    ),
    cursor: counter(
      "protected Stenographer live cursor",
      row["last_processed_message_id"],
    ),
    historicalStatus,
    historicalCursor: nullableCounter(
      "protected Stenographer historical cursor",
      row["historical_backfill_cursor_message_id"],
    ),
    historicalTarget: nullableCounter(
      "protected Stenographer historical target",
      row["historical_backfill_target_message_id"],
    ),
    leaseToken,
    leaseExpiresAt,
    extractionRetryAfter: nullableDate(
      "protected Stenographer extraction retry",
      row["extraction_retry_after"],
    ),
    extractionFailureCount: counter(
      "protected Stenographer extraction failure count",
      row["extraction_failure_count"],
    ),
    rebuildGeneration: counter(
      "protected Stenographer rebuild generation",
      row["rebuild_generation"],
    ),
    rebuildRequestedAt: nullableDate(
      "protected Stenographer rebuild request",
      row["rebuild_requested_at"],
    ),
    rebuildTarget: nullableCounter(
      "protected Stenographer rebuild target",
      row["rebuild_target_message_id"],
    ),
    upperBound: nullableCounter(
      "protected Stenographer upper bound",
      row["upper_bound_message_id"],
    ),
    retryFixedRange: boolean(
      "protected Stenographer fixed retry marker",
      row["retry_fixed_range"],
    ),
    priorContextFloor: counter(
      "protected Stenographer prior context floor",
      row["prior_context_floor_message_id"],
    ),
    priorContextLimit: counter(
      "protected Stenographer prior context limit",
      row["prior_context_limit"],
    ),
    compactionDueAt: nullableDate(
      "protected Stenographer compaction due time",
      row["compaction_due_at"],
    ),
    compactionLeaseToken,
    compactionLeaseExpiresAt,
    compactionRetryAfter: nullableDate(
      "protected Stenographer compaction retry",
      row["compaction_retry_after"],
    ),
    compactionFailureCount: counter(
      "protected Stenographer compaction failure count",
      row["compaction_failure_count"],
    ),
  });
}

function messageMetadata(
  row: ConversationProductDatabaseRow,
): ProtectedStenographerSourceMetadata & { readonly participantId: string } {
  const keyClass = row["key_class"];
  if (keyClass !== null && keyClass !== "ai" && keyClass !== "human") {
    throw new TypeError("protected message key class is invalid");
  }
  const completion = row["crypto_completion"];
  if (
    completion !== null
    && completion !== "pending"
    && completion !== "complete"
  ) {
    throw new TypeError("protected message completion is invalid");
  }
  const transcriptOrigin = row["transcript_origin"];
  if (transcriptOrigin !== "main" && transcriptOrigin !== "subagent") {
    throw new TypeError("protected transcript origin is invalid");
  }
  return Object.freeze({
    messageId: counter(
      "protected source message",
      row["message_id"],
      1,
    ),
    editRevision: counter(
      "protected source edit revision",
      row["edit_revision"],
    ),
    createdAt: rowDate(
      "protected source creation time",
      row["created_at"],
    ),
    role: role(row["role"]),
    fingerprint: nullableText(
      "protected source fingerprint",
      row["fingerprint"],
    ),
    transcriptOrigin,
    originatedBy: nullableText(
      "protected source origin",
      row["originated_by"],
    ),
    excludedFromEvidence: boolean(
      "protected source exclusion",
      row["excluded_from_evidence"],
    ),
    keyClass,
    cryptoObjectId: row["crypto_object_id"] === null
      ? null
      : portableId(
        "protected source crypto object",
        row["crypto_object_id"],
      ),
    cryptoCompletion: completion,
    participantId: uuid(
      "protected source participant",
      row["participant_id"],
    ),
  });
}

function messageBinding(
  metadata: ReturnType<typeof messageMetadata>,
  source: ProtectedStenographerMessageBinding["source"],
  conversationalBoundary: boolean,
): ProtectedStenographerMessageBinding {
  if (metadata.cryptoObjectId === null) {
    throw new TypeError("protected source object mapping is absent");
  }
  return Object.freeze({
    kind: "message",
    objectId: metadata.cryptoObjectId,
    source,
    messageId: metadata.messageId,
    editRevision: metadata.editRevision,
    createdAt: new Date(metadata.createdAt),
    participantId: metadata.participantId,
    role: metadata.role,
    conversationalBoundary,
  });
}

function parseSourceIds(value: unknown): readonly number[] {
  if (typeof value !== "string" || value.length < 1 || value.length > 192) {
    throw new TypeError("protected event source IDs are invalid");
  }
  const ids = value.split(",").map((item) =>
    counter("protected event source message", item, 1)
  );
  if (
    ids.length > 16
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
  ) {
    throw new TypeError(
      "protected event source IDs must be bounded, ascending, and unique",
    );
  }
  return Object.freeze(ids);
}

function rowTimestampText(label: string, value: unknown): string {
  return rowDate(label, value).toISOString();
}

function timestampText(label: string, value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (
    typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical timestamp`);
}

function eventMetadata(row: ConversationProductDatabaseRow) {
  const kind = row["kind"];
  if (
    kind !== "decision"
    && kind !== "commitment"
    && kind !== "goal"
    && kind !== "state_change"
    && kind !== "fact"
    && kind !== "preference_or_norm"
    && kind !== "open_question"
    && kind !== "risk"
  ) {
    throw new TypeError("protected event kind is invalid");
  }
  const status = row["status"];
  if (
    status !== "active"
    && status !== "superseded"
    && status !== "resolved"
  ) {
    throw new TypeError("protected event status is invalid");
  }
  const native = row["projection_kind"] === "native";
  if (!native && row["projection_kind"] !== "legacy") {
    throw new TypeError("protected event projection kind is invalid");
  }
  const lifecycle = row["record_lifecycle"];
  if (
    native
    && lifecycle !== "current"
    && lifecycle !== "stale"
    && lifecycle !== "superseded"
    && lifecycle !== "resolved"
    && lifecycle !== "sunset"
  ) {
    throw new TypeError("protected event Record lifecycle is invalid");
  }
  const recordLifecycle = lifecycle as
    | "current"
    | "stale"
    | "superseded"
    | "resolved"
    | "sunset";
  return Object.freeze({
    eventId: uuid("protected event", row["event_id"]),
    objectId: row["crypto_object_id"] === null
      ? null
      : portableId("protected event object", row["crypto_object_id"]),
    roomId: uuid("protected event Room", row["room_id"]),
    namespaceId: uuid(
      "protected event Namespace",
      row["namespace_id"],
    ),
    sequence: counter("protected event sequence", row["sequence"], 1),
    kind,
    status,
    supersedesEventId: row["supersedes_event_id"] === null
      ? null
      : uuid(
        "protected superseded event",
        row["supersedes_event_id"],
      ),
    resolvesEventId: row["resolves_event_id"] === null
      ? null
      : uuid("protected resolved event", row["resolves_event_id"]),
    sourceMessageIds: parseSourceIds(row["source_message_ids_csv"]),
    sourceBatchId: uuid(
      "protected event source batch",
      row["source_batch_id"],
    ),
    batchLocalOrdinal: counter(
      "protected event batch ordinal",
      row["batch_local_ordinal"],
    ),
    extractorVersion: portableId(
      "protected event extractor",
      row["extractor_version"],
    ),
    createdAt: rowTimestampText(
      "protected event creation time",
      row["created_at"],
    ),
    ...(native
      ? {
        payloadFormat: "record_v1" as const,
        recordMetadata: Object.freeze({
          lifecycle: recordLifecycle,
          structuralHeight: counter(
            "protected event Record height",
            row["record_structural_height"],
          ),
          processingGeneration: counter(
            "protected event Record generation",
            row["record_processing_generation"],
            1,
          ),
        }),
      }
      : {}),
  });
}

function rollupMetadata(
  row: ConversationProductDatabaseRow,
) {
  return Object.freeze({
    rollupId: uuid("protected rollup", row["rollup_id"]),
    objectId: row["crypto_object_id"] === null
      ? null
      : portableId("protected rollup object", row["crypto_object_id"]),
    roomId: uuid("protected rollup Room", row["room_id"]),
    namespaceId: uuid(
      "protected rollup Namespace",
      row["namespace_id"],
    ),
    throughEventSequence: counter(
      "protected rollup sequence",
      row["through_event_sequence"],
      1,
    ),
    sourceEventCount: counter(
      "protected rollup source count",
      row["source_event_count"],
      1,
    ),
    modelId: portableId("protected rollup model", row["model_id"]),
    compactorVersion: portableId(
      "protected rollup compactor",
      row["compactor_version"],
    ),
    createdAt: rowTimestampText(
      "protected rollup creation time",
      row["created_at"],
    ),
  });
}

function deterministicUuid(
  domain: string,
  values: readonly (string | number)[],
): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([domain, ...values]), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function extractionOutputSlots(
  sourceBatchId: string,
): readonly ProtectedStenographerEventOutputSlot[] {
  return Object.freeze(Array.from(
    { length: PROTECTED_STENOGRAPHER_OUTPUT_SLOT_COUNT },
    (_, ordinal) => Object.freeze({
      eventId: deterministicUuid(
        "nautilo/stenographer/protected-event-slot/v1",
        [sourceBatchId, ordinal],
      ),
      objectId:
        `journal/event/${sourceBatchId}/slot-${String(ordinal).padStart(3, "0")}`,
    }),
  ));
}

function compactionOutputSlot(
  workId: string,
): ProtectedStenographerCompactionOutputSlot {
  const rollupId = deterministicUuid(
    "nautilo/stenographer/protected-rollup-slot/v1",
    [workId],
  );
  return Object.freeze({
    rollupId,
    objectId: `journal/rollup/${rollupId}/slot-000`,
  });
}

function extractionAvailability(
  state: ProductWorkState,
  lane: StenographerLane,
  now: Date,
  rebuildMode: boolean,
): ProtectedStenographerExtractionClaimResult | null {
  if (!rebuildMode && state.rebuildRequestedAt !== null) {
    return Object.freeze({
      status: "unavailable",
      reason: "rebuild_pending",
    });
  }
  if (
    state.roomKind === "task"
    || state.roomKind === "access"
    || state.suspendedAt !== null
    || !state.hasAgent
  ) {
    return Object.freeze({ status: "unavailable", reason: "ineligible" });
  }
  if (
    lane === "historical"
    && (
      state.historicalStatus !== "pending"
      || state.historicalCursor === null
      || state.historicalTarget === null
      || state.historicalCursor >= state.historicalTarget
    )
  ) {
    return Object.freeze({ status: "unavailable", reason: "ineligible" });
  }
  if (
    state.extractionRetryAfter !== null
    && state.extractionRetryAfter.getTime() > now.getTime()
  ) {
    return Object.freeze({ status: "unavailable", reason: "not_due" });
  }
  if (
    state.leaseExpiresAt !== null
    && state.leaseExpiresAt.getTime() > now.getTime()
  ) {
    return Object.freeze({ status: "unavailable", reason: "leased" });
  }
  if (state.upperBound === null) {
    return Object.freeze({ status: "unavailable", reason: "missing" });
  }
  return null;
}

function compactionAvailability(
  state: ProductWorkState,
  now: Date,
): ProtectedStenographerCompactionClaimResult | null {
  if (state.rebuildRequestedAt !== null) {
    return Object.freeze({
      status: "unavailable",
      reason: "rebuild_pending",
    });
  }
  if (
    state.roomKind === "task"
    || state.roomKind === "access"
    || state.suspendedAt !== null
    || !state.hasAgent
  ) {
    return Object.freeze({ status: "unavailable", reason: "ineligible" });
  }
  if (
    state.compactionDueAt === null
    || (
      state.compactionRetryAfter !== null
      && state.compactionRetryAfter.getTime() > now.getTime()
    )
  ) {
    return Object.freeze({ status: "unavailable", reason: "not_due" });
  }
  if (
    state.compactionLeaseExpiresAt !== null
    && state.compactionLeaseExpiresAt.getTime() > now.getTime()
  ) {
    return Object.freeze({ status: "unavailable", reason: "leased" });
  }
  return null;
}

const STATE_QUERY = `
  SELECT
    r.id::text AS room_id,
    r.namespace_id::text AS namespace_id,
    r.owner_id::text AS owner_id,
    r.kind AS room_kind,
    rjs.suspended_at,
    EXISTS (
      SELECT 1
        FROM room_members AS rm
        JOIN actors AS member_actor
          ON member_actor.id = rm.actor_id
         AND member_actor.kind = 'agent'
       WHERE rm.room_id = r.id
    ) AS has_agent,
    rjs.last_processed_message_id,
    rjs.historical_backfill_status,
    rjs.historical_backfill_cursor_message_id,
    rjs.historical_backfill_target_message_id,
    rjs.lease_token::text,
    rjs.lease_expires_at,
    rjs.extraction_retry_after,
    rjs.extraction_failure_count,
    rjs.rebuild_generation,
    rjs.rebuild_requested_at,
    rjs.rebuild_target_message_id,
    CASE
      WHEN $2::text = 'historical' THEN COALESCE((
        SELECT failed_batch.through_message_id_inclusive
          FROM room_journal_batches AS failed_batch
         WHERE failed_batch.room_id = r.id
           AND failed_batch.lane = 'historical'
           AND failed_batch.from_message_id_exclusive =
             rjs.historical_backfill_cursor_message_id
           AND failed_batch.status = 'failed'
         ORDER BY failed_batch.created_at DESC
         LIMIT 1
      ), (
        SELECT MAX(bounded.id)
          FROM (
            SELECT sm.id
              FROM sessions AS s
              JOIN session_messages AS sm ON sm.session_id = s.id
             WHERE s.room_id = r.id
               AND sm.id > rjs.historical_backfill_cursor_message_id
               AND sm.id <= rjs.historical_backfill_target_message_id
             ORDER BY sm.id
             LIMIT 500
          ) AS bounded
      ))
      ELSE COALESCE((
        SELECT failed_batch.through_message_id_inclusive
          FROM room_journal_batches AS failed_batch
         WHERE failed_batch.room_id = r.id
           AND failed_batch.lane = 'live'
           AND failed_batch.from_message_id_exclusive =
             rjs.last_processed_message_id
           AND failed_batch.status = 'failed'
         ORDER BY failed_batch.created_at DESC
         LIMIT 1
      ), (
        SELECT MAX(sm.id)
          FROM sessions AS s
          JOIN session_messages AS sm ON sm.session_id = s.id
         WHERE s.room_id = r.id
           AND sm.id > rjs.last_processed_message_id
      ))
    END AS upper_bound_message_id,
    EXISTS (
      SELECT 1
        FROM room_journal_batches AS retry_batch
       WHERE retry_batch.room_id = r.id
         AND retry_batch.lane = $2::text
         AND retry_batch.from_message_id_exclusive = CASE
           WHEN $2::text = 'historical'
             THEN rjs.historical_backfill_cursor_message_id
           ELSE rjs.last_processed_message_id
         END
         AND retry_batch.status = 'failed'
    ) AS retry_fixed_range,
    COALESCE((
      SELECT MIN(prior_batch.from_message_id_exclusive)
        FROM room_journal_batches AS prior_batch
       WHERE prior_batch.room_id = r.id
         AND prior_batch.lane = $2::text
    ), CASE
      WHEN $2::text = 'historical'
        THEN rjs.historical_backfill_cursor_message_id
      ELSE rjs.last_processed_message_id
    END, 0)::integer AS prior_context_floor_message_id,
    LEAST(50, GREATEST(0, COALESCE((
      SELECT scc.stenographer_prior_conversation_limit
        FROM server_context_config AS scc
       WHERE scc.id = 'server'
    ), 10)))::integer AS prior_context_limit,
    rjs.compaction_due_at,
    rjs.compaction_lease_token::text,
    rjs.compaction_lease_expires_at,
    rjs.compaction_retry_after,
    rjs.compaction_failure_count
  FROM room_journal_state AS rjs
  JOIN rooms AS r ON r.id = rjs.room_id
  WHERE rjs.room_id = $1::uuid
  LIMIT 2
  FOR UPDATE OF rjs`;

const SOURCE_METADATA_PROJECTION = `
  SELECT
    sm.id AS message_id,
    sm.edit_revision,
    sm.created_at,
    sm.role,
    sm.fingerprint,
    sm.transcript_origin,
    sm.metadata->>'originatedBy' AS originated_by,
    EXISTS (
      SELECT 1
        FROM room_silence_state AS rss
       WHERE rss.room_id = $1::uuid
         AND rss.kind = 'deaf'
         AND sm.created_at >= rss.started_at
         AND sm.created_at <= rss.expires_at
    ) AS excluded_from_evidence,
    lifecycle.key_class,
    sm.crypto_object_id,
    CASE
      WHEN lifecycle.crypto_object_id = sm.crypto_object_id
        THEN lifecycle.completion
      ELSE NULL
    END AS crypto_completion,
    CASE
      WHEN sm.role = 'user' THEN human_actor.id::text
      ELSE COALESCE(agent_actor.id, human_actor.id)::text
    END AS participant_id
  FROM sessions AS s
  JOIN session_messages AS sm ON sm.session_id = s.id
  LEFT JOIN session_message_crypto_revisions AS lifecycle
    ON lifecycle.session_id = s.id
   AND lifecycle.message_id = sm.id
   AND lifecycle.edit_revision = sm.edit_revision
  LEFT JOIN actors AS agent_actor
    ON agent_actor.agent_id = s.agent_id
   AND agent_actor.kind = 'agent'
  LEFT JOIN actors AS human_actor
    ON human_actor.owner_id = s.owner_id
   AND human_actor.kind = 'user'`;

const ROLLUP_METADATA_PROJECTION = `
  SELECT
    rollup.id::text AS rollup_id,
    rollup.crypto_object_id,
    rollup.room_id::text AS room_id,
    room.namespace_id::text AS namespace_id,
    rollup.through_event_sequence,
    rollup.source_event_count,
    rollup.model_id,
    rollup.compactor_version,
    to_char(rollup.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM room_event_rollups AS rollup
  JOIN rooms AS room ON room.id = rollup.room_id`;

function claimIdentityIsInternallyConsistent(
  claim:
    | ProtectedStenographerExtractionWorkClaim
    | ProtectedStenographerCompactionWorkClaim,
): boolean {
  if (
    claim.inputObjectIds.length !== claim.bindings.length
    || claim.inputObjectIds.some(
      (objectId, index) =>
        portableId("protected fallback input object", objectId)
          !== claim.bindings[index]?.objectId,
    )
    || !(claim.sourceBindingFingerprint instanceof Uint8Array)
    || claim.sourceBindingFingerprint.byteLength !== 32
  ) return false;
  const fingerprint =
    fingerprintProtectedStenographerSourceBindings(claim.bindings);
  try {
    if (!equalBytes(fingerprint, claim.sourceBindingFingerprint)) return false;
  } finally {
    fingerprint.fill(0);
  }
  for (const binding of claim.bindings) {
    if (
      (binding.kind === "event" || binding.kind === "rollup")
      && (
        binding.binding.roomId !== claim.roomId
        || binding.binding.namespaceId !== claim.namespaceId
      )
    ) return false;
  }
  timestampText("protected fallback claim creation", claim.createdAt);
  if (claim.kind === "extraction") {
    if (
      uuid("protected fallback source batch", claim.sourceBatchId)
        !== claim.workId
      || claim.extractorVersion
        !== PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION
      || counter(
        "protected fallback range start",
        claim.fromMessageIdExclusive,
      ) >= counter(
        "protected fallback range end",
        claim.throughMessageIdInclusive,
        1,
      )
      || !(claim.coveredRangeFingerprint instanceof Uint8Array)
      || claim.coveredRangeFingerprint.byteLength !== 32
      || claim.outputSlots.length
        !== PROTECTED_STENOGRAPHER_OUTPUT_SLOT_COUNT
      || extractionOutputSlots(claim.sourceBatchId).some((slot, index) =>
        slot.eventId !== claim.outputSlots[index]?.eventId
        || slot.objectId !== claim.outputSlots[index]?.objectId
      )
    ) return false;
    const participants = [...new Set(claim.bindings.flatMap((binding) =>
      binding.kind === "message" ? [binding.participantId] : []
    ))].sort();
    return participants.length === claim.participantIds.length
      && participants.every(
        (participantId, index) =>
          participantId === claim.participantIds[index],
      );
  }
  if (
    claim.workKind !== "stenographer.compaction"
    || claim.compactorVersion
      !== PROTECTED_STENOGRAPHER_WORK_COMPACTOR_VERSION
    || counter(
      "protected fallback active event count",
      claim.activeEventCount,
      1,
    ) < counter(
      "protected fallback selected event count",
      claim.selectedEventCount,
      1,
    )
    || claim.selectedEventCount !== claim.bindings.filter(
      (binding) => binding.kind === "event",
    ).length
    || claim.hasDeferredMiddle
      !== (claim.activeEventCount > claim.selectedEventCount)
  ) return false;
  const through = claim.bindings.reduce((maximum, binding) =>
    binding.kind === "event"
      ? Math.max(maximum, binding.binding.sequence)
      : binding.kind === "rollup"
      ? Math.max(maximum, binding.binding.throughEventSequence)
      : maximum
  , 0);
  const expectedWorkId =
    `stenographer-compaction/${claim.roomId}/${claim.rebuildGeneration}/${through}`;
  const expectedOutput = compactionOutputSlot(expectedWorkId);
  return through > 0
    && claim.workId === expectedWorkId
    && claim.outputSlot.rollupId === expectedOutput.rollupId
    && claim.outputSlot.objectId === expectedOutput.objectId;
}

function extractionClaimMatchesProduct(
  claim: ProtectedStenographerExtractionWorkClaim,
  state: ProductWorkState,
  batch: ConversationProductDatabaseRow,
): boolean {
  const expectedWorkKind = claim.workKind === "stenographer.rebuild"
    ? claim.lane === "live" ? "stenographer.rebuild" : null
    : claim.lane === "historical"
    ? "stenographer.historical"
    : "stenographer.extraction";
  const expectedCursor = claim.lane === "historical"
    ? state.historicalCursor
    : state.cursor;
  const rebuildMatches = claim.workKind === "stenographer.rebuild"
    ? state.rebuildRequestedAt !== null
      && claim.rebuildTargetMessageId !== undefined
      && state.rebuildTarget === claim.rebuildTargetMessageId
    : claim.rebuildTargetMessageId === undefined
      && state.rebuildRequestedAt === null
      && state.rebuildTarget === null;
  return expectedWorkKind === claim.workKind
    && expectedCursor === claim.fromMessageIdExclusive
    && rebuildMatches
    && uuid("protected fallback batch", batch["id"]) === claim.sourceBatchId
    && uuid("protected fallback batch Room", batch["room_id"])
      === claim.roomId
    && counter(
      "protected fallback batch range start",
      batch["from_message_id_exclusive"],
    ) === claim.fromMessageIdExclusive
    && counter(
      "protected fallback batch range end",
      batch["through_message_id_inclusive"],
      1,
    ) === claim.throughMessageIdInclusive
    && portableId(
      "protected fallback batch extractor",
      batch["extractor_version"],
    ) === claim.extractorVersion
    && batch["lane"] === claim.lane
    && batch["status"] === "running"
    && counter(
      "protected fallback batch attempt",
      batch["attempt_count"],
      1,
    ) === claim.attemptCount
    && rowTimestampText(
      "protected fallback batch creation",
      batch["created_at"],
    ) === claim.createdAt;
}

/**
 * Dormant product-role half of protected Stenographer work selection.
 *
 * It intentionally returns no Domain, epoch, access revision, policy
 * revision, credential, or descriptor. Those facts belong to the current
 * crypto-authority resolver and cannot be inferred safely from product SQL.
 */
export class PostgresProtectedStenographerWorkRepository {
  readonly #leaseToken: () => string;

  constructor(
    private readonly handle: ConversationProductPostgresHandle,
    options: RepositoryOptions = {},
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError(
        "protected Stenographer work requires the nautilo product role",
      );
    }
    this.#leaseToken = options.leaseToken ?? randomUUID;
  }

  /**
   * Releases product work only when the current durable queue declined the
   * still-unstarted protected attempt. The policy fence, product locks,
   * cancellation winner, and exact lease CAS share one serializable boundary.
   */
  async releaseUnstartedClaimForFallback(
    claim:
      | ProtectedStenographerExtractionWorkClaim
      | ProtectedStenographerCompactionWorkClaim,
    options: Readonly<{
      canonical: ConversationProductCanonicalTransactionRunner;
      expectedPolicyRevision: number;
      cancel: () => Promise<boolean>;
    }>,
  ): Promise<boolean> {
    return this.#withUnstartedClaim(claim, {...options, release: true});
  }

  /** Supersede only while the current product claim and complete source remain locked; keep its lease. */
  async supersedeUnstartedClaim(
    claim: ProtectedStenographerExtractionWorkClaim | ProtectedStenographerCompactionWorkClaim,
    options: Readonly<{
      canonical: ConversationProductCanonicalTransactionRunner;
      expectedPolicyRevision: number;
      now: Date;
      supersede: () => Promise<boolean>;
    }>,
  ): Promise<boolean> {
    return this.#withUnstartedClaim(claim, {...options, cancel: options.supersede, release: false});
  }

  /** Retire obsolete queue metadata without releasing or changing a current
   * product lease. The restricted owner still refuses any consumed request. */
  async retireObsoleteUnstartedRequest(input: Readonly<{
    roomId: string; namespaceId: string; workId: string;
    canonical: ConversationProductCanonicalTransactionRunner; retire(): Promise<boolean>;
  }>): Promise<boolean> {
    assertConversationProductCanonicalTransactionRunner(this.handle, input.canonical);
    return input.canonical.transaction(async (tx, transaction) => {
      await acquireEncryptionConsumptionFence(tx);
      const locked = await executeTypedConversationProductQuery(transaction, typedDb.select({id: rooms.id})
        .from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.namespaceId, input.namespaceId))).for("update"));
      if (locked.length !== 1) return false;
      await executeTypedConversationProductQuery(transaction, typedDb.select({roomId: roomJournalState.roomId})
        .from(roomJournalState).where(eq(roomJournalState.roomId, input.roomId)).for("update"));
      const receipts = await executeTypedConversationProductQuery(transaction, typedDb.select({id: roomJournalCryptoPublications.publicationId, state: roomJournalCryptoPublications.state,
          failureCode: roomJournalCryptoPublications.failureCode, cryptoCommittedAt: roomJournalCryptoPublications.cryptoCommittedAt,
          attachedAt: roomJournalCryptoPublications.attachedAt})
        .from(roomJournalCryptoPublications).where(eq(roomJournalCryptoPublications.workId, input.workId)).limit(1).for("update"));
      const uncommitted = receipts.length === 0 || receipts.every(receipt => receipt.state === "superseded"
        && receipt.failure_code === "crypto_publication_failed" && receipt.crypto_committed_at === null && receipt.attached_at === null);
      return uncommitted && await input.retire();
    }, {isolationLevel: "serializable"});
  }

  async #withUnstartedClaim(
    claim: ProtectedStenographerExtractionWorkClaim | ProtectedStenographerCompactionWorkClaim,
    options: Readonly<{
      canonical: ConversationProductCanonicalTransactionRunner;
      expectedPolicyRevision: number;
      cancel: () => Promise<boolean>;
    }> & (Readonly<{release: true}> | Readonly<{release: false; now: Date}>),
  ): Promise<boolean> {
    claim = structuredClone(claim);
    assertConversationProductCanonicalTransactionRunner(
      this.handle,
      options.canonical,
    );
    const expectedPolicyRevision = counter(
      "protected Stenographer fallback policy revision",
      options.expectedPolicyRevision,
    );
    if (typeof options.cancel !== "function") {
      throw new TypeError("protected Stenographer fallback cancel is invalid");
    }
    const roomId = uuid("protected Stenographer fallback Room", claim.roomId);
    const namespaceId = uuid(
      "protected Stenographer fallback Namespace",
      claim.namespaceId,
    );
    const ownerId = uuid(
      "protected Stenographer fallback owner",
      claim.ownerId,
    );
    const leaseToken = uuid(
      "protected Stenographer fallback lease",
      claim.leaseToken,
    );
    const leaseExpiresAt = date(
      "protected Stenographer fallback lease expiry",
      claim.leaseExpiresAt,
    );
    const rebuildGeneration = counter(
      "protected Stenographer fallback rebuild generation",
      claim.rebuildGeneration,
    );
    const attemptCount = counter(
      "protected Stenographer fallback attempt",
      claim.attemptCount,
      1,
    );
    const workId = portableId(
      "protected Stenographer fallback work",
      claim.workId,
    );
    if (!claimIdentityIsInternallyConsistent(claim)) return false;

    return options.canonical.transaction(async (tx, transaction) => {
      await acquireEncryptionPublicationFence(tx, {
        expectedRevision: expectedPolicyRevision,
        representation: options.release ? "ordinary" : "protected_only",
      });
      if (!options.release) {
        const locked = await executeTypedConversationProductQuery(transaction, typedDb.select({id: rooms.id})
          .from(rooms).where(eq(rooms.id, roomId)).limit(2).for("update"));
        if (locked.length !== 1 || locked[0]?.["id"] !== roomId
          || leaseExpiresAt.getTime() <= date("Current plan supersession time", options.now).getTime()) return false;
      }
      const stateRow = exactlyOne(
        "protected Stenographer fallback state",
        await transaction.query(
          STATE_QUERY,
          [roomId, claim.kind === "extraction" ? claim.lane : "live"],
        ),
      );
      if (stateRow === null) return false;
      const state = stateFromRow(stateRow);
      if (
        state.roomId !== roomId
        || state.namespaceId !== namespaceId
        || state.ownerId !== ownerId
        || state.rebuildGeneration !== rebuildGeneration
      ) return false;

      if (claim.kind === "extraction") {
        if (
          state.leaseToken !== leaseToken
          || state.leaseExpiresAt?.getTime() !== leaseExpiresAt.getTime()
        ) return false;
        const batchRow = exactlyOne(
          "protected Stenographer fallback batch",
          await executeTypedConversationProductQuery(transaction,
            typedDb.select({
              id: roomJournalBatches.id,
              roomId: roomJournalBatches.roomId,
              fromMessageIdExclusive: roomJournalBatches.fromMessageIdExclusive,
              throughMessageIdInclusive: roomJournalBatches.throughMessageIdInclusive,
              extractorVersion: roomJournalBatches.extractorVersion,
              lane: roomJournalBatches.lane,
              status: roomJournalBatches.status,
              attemptCount: roomJournalBatches.attemptCount,
              createdAt: roomJournalBatches.createdAt,
            }).from(roomJournalBatches).where(and(
              eq(roomJournalBatches.id, claim.sourceBatchId),
              eq(roomJournalBatches.roomId, roomId),
            )).limit(2).for("update")),
        );
        if (batchRow === null || !extractionClaimMatchesProduct(
          claim,
          state,
          batchRow,
        )) return false;
      } else if (
        state.compactionLeaseToken !== leaseToken
        || state.compactionLeaseExpiresAt?.getTime()
          !== leaseExpiresAt.getTime()
        || state.compactionFailureCount + 1 !== attemptCount
        || state.compactionDueAt === null
        || state.rebuildRequestedAt !== null
      ) return false;

      const receipts = await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({publication_id:
          roomJournalCryptoPublications.publicationId})
          .from(roomJournalCryptoPublications)
          .where(eq(roomJournalCryptoPublications.workId, workId))
          .limit(1),
      );
      if (receipts.length !== 0) return false;
      if (!options.release) {
        const source: CurrentSourceCheckInput = {roomId, namespaceId, rebuildGeneration,
          sourceBatchId: claim.kind === "extraction" ? claim.sourceBatchId : null,
          now: options.now, sourceLeaseToken: leaseToken,
          sourceBindingFingerprint: claim.sourceBindingFingerprint, sourceBindings: claim.bindings,
          source: claim.kind === "extraction" ? {kind: "extraction", lane: claim.lane,
            ...(claim.rebuildTargetMessageId === undefined ? {} : {rebuildTargetMessageId: claim.rebuildTargetMessageId}),
            fromMessageIdExclusive: claim.fromMessageIdExclusive, throughMessageIdInclusive: claim.throughMessageIdInclusive,
            extractorVersion: claim.extractorVersion, coveredRangeFingerprint: claim.coveredRangeFingerprint}
            : {kind: "compaction", activeEventCount: claim.activeEventCount, selectedEventCount: claim.selectedEventCount,
              hasDeferredMiddle: claim.hasDeferredMiddle}};
        if (!await sourceInventoryIsCurrent(transaction, source)) return false;
        return options.cancel();
      }
      if (!await options.cancel()) return false;

      if (claim.kind === "extraction") {
        const pending = await executeTypedConversationProductQuery(
          transaction,
          typedDb.update(roomJournalBatches)
            .set({status: "pending"})
            .where(and(
              eq(roomJournalBatches.id, claim.sourceBatchId),
              eq(roomJournalBatches.roomId, roomId),
              eq(roomJournalBatches.status, "running"),
              eq(roomJournalBatches.attemptCount, attemptCount),
              eq(
                roomJournalBatches.fromMessageIdExclusive,
                claim.fromMessageIdExclusive,
              ),
              eq(
                roomJournalBatches.throughMessageIdInclusive,
                claim.throughMessageIdInclusive,
              ),
              eq(roomJournalBatches.extractorVersion, claim.extractorVersion),
              eq(roomJournalBatches.lane, claim.lane),
            ))
            .returning({id: roomJournalBatches.id}),
        );
        if (
          pending.length !== 1
          || pending[0]?.["id"] !== claim.sourceBatchId
        ) throw new Error(
          "protected Stenographer fallback batch release lost its exact claim",
        );
        const released = await executeTypedConversationProductQuery(
          transaction,
          typedDb.update(roomJournalState)
            .set({leaseToken: null, leaseExpiresAt: null})
            .where(and(
              eq(roomJournalState.roomId, roomId),
              eq(roomJournalState.rebuildGeneration, rebuildGeneration),
              eq(roomJournalState.leaseToken, leaseToken),
              eq(roomJournalState.leaseExpiresAt, leaseExpiresAt),
            ))
            .returning({room_id: roomJournalState.roomId}),
        );
        if (
          released.length !== 1
          || released[0]?.["room_id"] !== roomId
        ) throw new Error(
          "protected Stenographer fallback lease release lost its exact claim",
        );
      } else {
        const released = await executeTypedConversationProductQuery(
          transaction,
          typedDb.update(roomJournalState)
            .set({
              compactionLeaseToken: null,
              compactionLeaseExpiresAt: null,
            })
            .where(and(
              eq(roomJournalState.roomId, roomId),
              eq(roomJournalState.rebuildGeneration, rebuildGeneration),
              eq(roomJournalState.compactionLeaseToken, leaseToken),
              eq(roomJournalState.compactionLeaseExpiresAt, leaseExpiresAt),
            ))
            .returning({room_id: roomJournalState.roomId}),
        );
        if (
          released.length !== 1
          || released[0]?.["room_id"] !== roomId
        ) throw new Error(
          "protected Stenographer fallback compaction release lost its exact claim",
        );
      }
      return true;
    }, {isolationLevel: "serializable"});
  }

  async recoverExtraction(input: Readonly<{
    readonly workId: string;
    readonly now: Date;
  }>): Promise<ProtectedStenographerExtractionClaimResult> {
    const workId = uuid(
      "protected Stenographer extraction recovery work",
      input.workId,
    );
    const now = date("protected Stenographer recovery time", input.now);
    return this.handle.transaction(async (transaction) => {
      const batchRow = exactlyOne(
        "protected Stenographer recovery batch",
        await executeTypedConversationProductQuery(transaction, typedDb
          .select({
            id: roomJournalBatches.id,
            room_id: roomJournalBatches.roomId,
            from_message_id_exclusive:
              roomJournalBatches.fromMessageIdExclusive,
            through_message_id_inclusive:
              roomJournalBatches.throughMessageIdInclusive,
            extractor_version: roomJournalBatches.extractorVersion,
            lane: roomJournalBatches.lane,
            status: roomJournalBatches.status,
            attempt_count: roomJournalBatches.attemptCount,
            created_at: roomJournalBatches.createdAt,
          })
          .from(roomJournalBatches)
          .where(eq(roomJournalBatches.id, workId))
          .limit(2)),
      );
      if (batchRow === null) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "missing" as const,
        });
      }
      const recoveryRoomId = uuid(
        "protected recovery Room",
        batchRow["room_id"],
      );
      const currentRunningRows = await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({ id: roomJournalBatches.id })
          .from(roomJournalBatches)
          .where(and(
            eq(roomJournalBatches.roomId, recoveryRoomId),
            eq(roomJournalBatches.status, "running"),
          ))
          .orderBy(
            sql`${roomJournalBatches.startedAt} DESC NULLS LAST`,
            desc(roomJournalBatches.createdAt),
          )
          .limit(1),
      );
      const row: ConversationProductDatabaseRow = {
        ...batchRow,
        current_running_batch_id: currentRunningRows[0]?.["id"] ?? null,
      };
      const lane = row["lane"];
      if (lane !== "live" && lane !== "historical") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "stale" as const,
        });
      }
      const status = row["status"];
      if (
        status !== "pending"
        && status !== "running"
        && status !== "failed"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "stale" as const,
        });
      }
      const recovery: ExtractionRecoveryContext = Object.freeze({
        workId,
        fromMessageIdExclusive: counter(
          "protected recovery range start",
          row["from_message_id_exclusive"],
        ),
        throughMessageIdInclusive: counter(
          "protected recovery range end",
          row["through_message_id_inclusive"],
          1,
        ),
        extractorVersion: portableId(
          "protected recovery extractor",
          row["extractor_version"],
        ),
        lane,
        attemptCount: counter(
          "protected recovery attempt",
          row["attempt_count"],
          1,
        ),
        createdAt: rowTimestampText(
          "protected recovery creation time",
          row["created_at"],
        ),
        status,
        currentRunningBatchId: row["current_running_batch_id"] === null
          ? null
          : uuid(
            "protected current running batch",
            row["current_running_batch_id"],
          ),
      });
      return this.#claimExtractionInTransaction(
        transaction,
        recoveryRoomId,
        lane,
        now,
        recovery,
      );
    }, { isolationLevel: "serializable" });
  }

  async claimExtraction(input: Readonly<{
    readonly roomId: string;
    readonly lane: StenographerLane;
    readonly now: Date;
  }>): Promise<ProtectedStenographerExtractionClaimResult> {
    const exactRoomId = uuid("protected Stenographer Room", input.roomId);
    if (input.lane !== "live" && input.lane !== "historical") {
      throw new TypeError("protected Stenographer lane is invalid");
    }
    const now = date("protected Stenographer claim time", input.now);
    return this.handle.transaction(
      (transaction) =>
        this.#claimExtractionInTransaction(
          transaction,
          exactRoomId,
          input.lane,
          now,
        ),
      { isolationLevel: "serializable" },
    );
  }

  async claimRebuildExtraction(input: Readonly<{
    readonly roomId: string;
    readonly rebuildGeneration: number;
    readonly targetMessageId: number;
    readonly now: Date;
  }>): Promise<ProtectedStenographerExtractionClaimResult> {
    const exactRoomId = uuid("protected Stenographer Room", input.roomId);
    const rebuildGeneration = counter(
      "protected Stenographer rebuild generation",
      input.rebuildGeneration,
    );
    const targetMessageId = counter(
      "protected Stenographer rebuild target",
      input.targetMessageId,
    );
    const now = date("protected Stenographer rebuild claim time", input.now);
    return this.handle.transaction(
      (transaction) =>
        this.#claimExtractionInTransaction(
          transaction,
          exactRoomId,
          "live",
          now,
          undefined,
          { rebuildGeneration, targetMessageId },
        ),
      { isolationLevel: "serializable" },
    );
  }

  async #claimExtractionInTransaction(
    transaction: ConversationProductPostgresTransaction,
    roomId: string,
    lane: StenographerLane,
    now: Date,
    recovery?: ExtractionRecoveryContext,
    requestedRebuild?: RebuildClaimContext,
  ): Promise<ProtectedStenographerExtractionClaimResult> {
    const stateRow = exactlyOne(
      "protected Stenographer state",
      await transaction.query(STATE_QUERY, [roomId, lane]),
    );
    if (stateRow === null) {
      return Object.freeze({ status: "unavailable", reason: "missing" });
    }
    const state = stateFromRow(stateRow);
    const rebuildMode = requestedRebuild !== undefined
      || (
        recovery !== undefined
        && lane === "live"
        && state.rebuildRequestedAt !== null
      );
    if (
      rebuildMode
      && (
        lane !== "live"
        || state.rebuildRequestedAt === null
        || state.rebuildTarget === null
        || requestedRebuild !== undefined
          && (
            requestedRebuild.rebuildGeneration !== state.rebuildGeneration
            || requestedRebuild.targetMessageId !== state.rebuildTarget
          )
      )
    ) {
      return Object.freeze({ status: "unavailable", reason: "stale" });
    }
    const unavailable = extractionAvailability(
      state,
      lane,
      now,
      rebuildMode,
    );
    if (
      recovery !== undefined
      && unavailable?.status === "unavailable"
      && unavailable.reason === "leased"
    ) {
      // An exact durable recovery may reuse the one Room extraction lease.
      // The recovered batch/range and current source inventory are verified
      // below before the lease token is returned.
    } else if (unavailable !== null) {
      return unavailable;
    }

    const cursor = lane === "live"
      ? state.cursor
      : state.historicalCursor!;
    const availableUpperBound = rebuildMode
      ? Math.min(state.upperBound!, state.rebuildTarget!)
      : state.upperBound!;
    if (
      recovery !== undefined
      && (
        recovery.lane !== lane
        || recovery.extractorVersion
          !== PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION
        || recovery.fromMessageIdExclusive !== cursor
        || recovery.throughMessageIdInclusive > availableUpperBound
      )
    ) {
      return Object.freeze({ status: "unavailable", reason: "stale" });
    }
    if (rebuildMode && state.rebuildTarget! <= cursor) {
      return Object.freeze({ status: "unavailable", reason: "stale" });
    }
    const upperBound = recovery?.throughMessageIdInclusive
      ?? availableUpperBound;
    const sourceRows = await transaction.query(
      `${SOURCE_METADATA_PROJECTION}
        WHERE s.room_id = $1::uuid
          AND sm.id > $2::integer
          AND sm.id <= $3::integer
        ORDER BY sm.id
        LIMIT $4::integer`,
      [
        roomId,
        cursor,
        upperBound,
        PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS,
      ],
    );
    let sources: readonly ReturnType<typeof messageMetadata>[];
    try {
      sources = Object.freeze(sourceRows.map(messageMetadata));
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }
    const pendingFingerprints = [
      ...new Set(
        sources.flatMap((source) =>
          source.role === "user" && source.fingerprint !== null
            ? [source.fingerprint]
            : []
        ),
      ),
    ];
    const fingerprintRows = pendingFingerprints.length === 0
      ? []
      : await transaction.query(
        `SELECT DISTINCT sm.fingerprint
           FROM sessions AS s
           JOIN session_messages AS sm ON sm.session_id = s.id
          WHERE s.room_id = $1::uuid
            AND sm.id <= $2::integer
            AND sm.role = 'user'
            AND sm.fingerprint = ANY($3::text[])
          LIMIT $4::integer`,
        [
          roomId,
          cursor,
          `{${pendingFingerprints.join(",")}}`,
          pendingFingerprints.length,
        ],
      );
    const seenFingerprints = new Set(
      fingerprintRows.map((row) =>
        portableId(
          "protected prior source fingerprint",
          row["fingerprint"],
        )
      ),
    );
    const planned = planProtectedStenographerBatch({
      cursorMessageId: cursor,
      fixedUpperBoundMessageId: upperBound,
      rows: sources,
      now,
      fingerprintsAtOrBeforeCursor: seenFingerprints,
      retryFixedRange: state.retryFixedRange,
    });
    if (planned.status === "wait") {
      return Object.freeze({
        status: "unavailable",
        reason: planned.reason === "not_due" ? "not_due" : "missing",
      });
    }
    if (planned.status === "blocked") {
      return Object.freeze({
        status: "blocked",
        reason: "protected_source_unavailable",
      });
    }
    if (planned.status === "skip_excluded") {
      const verificationRows = await transaction.query(
        `${SOURCE_METADATA_PROJECTION}
          WHERE s.room_id = $1::uuid
            AND sm.id > $2::integer
            AND sm.id <= $3::integer
          ORDER BY sm.id
          LIMIT $4::integer
          FOR SHARE OF sm`,
        [
          roomId,
          planned.plan.fromMessageIdExclusive,
          planned.plan.throughMessageIdInclusive,
          PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS,
        ],
      );
      let verifiedFingerprint: Uint8Array;
      try {
        verifiedFingerprint = fingerprintProtectedStenographerCoveredRange({
          fromMessageIdExclusive: planned.plan.fromMessageIdExclusive,
          throughMessageIdInclusive: planned.plan.throughMessageIdInclusive,
          rows: verificationRows.map(messageMetadata),
        });
      } catch {
        return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
      }
      if (!equalBytes(verifiedFingerprint, planned.plan.sourceFingerprint)) {
        return Object.freeze({ status: "unavailable", reason: "stale" });
      }
      const through = planned.plan.throughMessageIdInclusive;
      const rebuildCompleted = rebuildMode && through === state.rebuildTarget;
      const historicalCompleted = lane === "historical"
        && through === state.historicalTarget;
      const acknowledged = await executeTypedConversationProductQuery(
        transaction,
        typedDb.update(roomJournalState)
          .set(lane === "historical"
            ? {
              historicalBackfillCursorMessageId: through,
              historicalBackfillStatus: historicalCompleted
                ? "completed"
                : "pending",
              historicalBackfillCompletedAt: historicalCompleted ? now : null,
              extractionFailureCount: 0,
              extractionRetryAfter: null,
              lastExtractionCompletedAt: now,
              updatedAt: now,
            }
            : {
              lastProcessedMessageId: through,
              lastProcessedAt: now,
              extractionFailureCount: 0,
              extractionRetryAfter: null,
              lastExtractionCompletedAt: now,
              ...(rebuildCompleted
                ? {
                  rebuildRequestedAt: null,
                  rebuildTargetMessageId: null,
                }
                : {}),
              updatedAt: now,
            })
          .where(and(
            eq(roomJournalState.roomId, roomId),
            eq(roomJournalState.rebuildGeneration, state.rebuildGeneration),
            lane === "historical"
              ? and(
                isNull(roomJournalState.rebuildRequestedAt),
                eq(roomJournalState.historicalBackfillStatus, "pending"),
                eq(roomJournalState.historicalBackfillCursorMessageId, cursor),
                eq(
                  roomJournalState.historicalBackfillTargetMessageId,
                  state.historicalTarget!,
                ),
              )
              : rebuildMode
                ? and(
                  isNotNull(roomJournalState.rebuildRequestedAt),
                  eq(roomJournalState.rebuildTargetMessageId,
                    state.rebuildTarget!),
                  eq(roomJournalState.lastProcessedMessageId, cursor),
                )
                : and(
                  isNull(roomJournalState.rebuildRequestedAt),
                  isNull(roomJournalState.rebuildTargetMessageId),
                  eq(roomJournalState.lastProcessedMessageId, cursor),
                ),
          ))
          .returning({ room_id: roomJournalState.roomId }),
      );
      if (
        acknowledged.length !== 1
        || acknowledged[0]?.["room_id"] !== roomId
      ) {
        return Object.freeze({ status: "unavailable", reason: "stale" });
      }
      return Object.freeze({
        status: "completed",
        completion: "excluded_range_acknowledged",
        roomId: state.roomId,
        namespaceId: state.namespaceId,
        rebuildGeneration: state.rebuildGeneration,
        lane,
        workKind: rebuildMode
          ? "stenographer.rebuild"
          : lane === "live"
            ? "stenographer.extraction"
            : "stenographer.historical",
        fromMessageIdExclusive: planned.plan.fromMessageIdExclusive,
        throughMessageIdInclusive: planned.plan.throughMessageIdInclusive,
        sourceFingerprint: planned.plan.sourceFingerprint.slice(),
      });
    }

    const sourceById = new Map(
      sources.map((source) => [source.messageId, source]),
    );
    const currentBindings = planned.plan.sourceObjects.map((source) => {
      const metadata = sourceById.get(source.messageId);
      if (metadata === undefined) {
        throw new TypeError("protected source plan lost its metadata");
      }
      return messageBinding(
        metadata,
        "current",
        source.potentialConversationalBoundary,
      );
    });
    const remainingAfterCurrent =
      PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS - currentBindings.length;
    const priorLimit = Math.min(
      state.priorContextLimit,
      PROTECTED_STENOGRAPHER_MAX_PRIOR_CONTEXT_MESSAGES,
      remainingAfterCurrent,
    );
    const priorRows = priorLimit === 0
      ? []
      : await transaction.query(
        `WITH bounded_prior AS (
           ${SOURCE_METADATA_PROJECTION}
            WHERE s.room_id = $1::uuid
              AND sm.id > $2::integer
              AND sm.id <= $3::integer
              AND sm.transcript_origin = 'main'
              AND sm.role IN ('user', 'assistant', 'tool')
              AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
              AND lifecycle.key_class = 'ai'
              AND lifecycle.completion = 'complete'
              AND sm.crypto_object_id IS NOT NULL
            ORDER BY sm.id DESC
            LIMIT $4::integer
         )
         SELECT *
           FROM bounded_prior
          ORDER BY message_id`,
        [
          roomId,
          state.priorContextFloor,
          cursor,
          priorLimit,
        ],
      );
    let priorBindings: readonly ProtectedStenographerMessageBinding[];
    try {
      priorBindings = Object.freeze(
        priorRows.map(messageMetadata).map((metadata) =>
          messageBinding(
            metadata,
            "prior",
            metadata.role === "user" || metadata.role === "assistant",
          )
        ),
      );
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }
    let remaining =
      PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS
      - currentBindings.length
      - priorBindings.length;

    const rollupRows = remaining === 0
      ? []
      : await transaction.query(
        `${ROLLUP_METADATA_PROJECTION}
          WHERE rollup.room_id = $1::uuid
          ORDER BY rollup.through_event_sequence DESC, rollup.created_at DESC
          LIMIT 1`,
        [roomId],
      );
    let latestRollup: ReturnType<typeof rollupMetadata> | null = null;
    try {
      latestRollup = rollupRows[0] === undefined
        ? null
        : rollupMetadata(rollupRows[0]);
    } catch {
      return Object.freeze({
        status: "blocked",
        reason: "protected_source_unavailable",
      });
    }
    if (latestRollup?.objectId === null) {
      return Object.freeze({
        status: "blocked",
        reason: "protected_source_unavailable",
      });
    }
    if (latestRollup !== null) remaining -= 1;
    const eventRows = await transaction.query(
      `${PROTECTED_JOURNAL_EVENT_PROJECTION_SQL}
        WHERE event.room_id = $1::uuid
          AND event.status = 'active'
          AND event.sequence > $2::integer
        ORDER BY event.sequence
        LIMIT $3::integer`,
      [
        roomId,
        latestRollup?.throughEventSequence ?? 0,
        remaining + 1,
      ],
    );
    if (eventRows.length > remaining) {
      return Object.freeze({
        status: "blocked",
        reason: "input_bound_exceeded",
      });
    }
    let events: readonly ReturnType<typeof eventMetadata>[];
    try {
      events = Object.freeze(eventRows.map(eventMetadata));
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }
    if (events.some((event) => event.objectId === null)) {
      return Object.freeze({
        status: "blocked",
        reason: "protected_source_unavailable",
      });
    }
    const bindings: readonly ProtectedStenographerSourceBinding[] =
      Object.freeze([
        ...priorBindings,
        ...currentBindings,
        ...(latestRollup === null
          ? []
          : [Object.freeze({
            kind: "rollup" as const,
            objectId: latestRollup.objectId,
            binding: Object.freeze({
              rollupId: latestRollup.rollupId,
              roomId: latestRollup.roomId,
              namespaceId: latestRollup.namespaceId,
              throughEventSequence: latestRollup.throughEventSequence,
              sourceEventCount: latestRollup.sourceEventCount,
              modelId: latestRollup.modelId,
              compactorVersion: latestRollup.compactorVersion,
              createdAt: latestRollup.createdAt,
            }),
          })]),
        ...events.map((event) => Object.freeze({
          kind: "event" as const,
          objectId: event.objectId!,
          status: event.status,
          binding: Object.freeze({
            eventId: event.eventId,
            roomId: event.roomId,
            namespaceId: event.namespaceId,
            sequence: event.sequence,
            kind: event.kind,
            supersedesEventId: event.supersedesEventId,
            resolvesEventId: event.resolvesEventId,
            sourceMessageIds: event.sourceMessageIds,
            sourceBatchId: event.sourceBatchId,
            batchLocalOrdinal: event.batchLocalOrdinal,
            extractorVersion: event.extractorVersion,
            createdAt: event.createdAt,
          }),
          ...(event.payloadFormat === "record_v1"
            ? {
              payloadFormat: event.payloadFormat,
              recordMetadata: event.recordMetadata,
            }
            : {}),
        })),
      ]);
    const participantIds = Object.freeze([
      ...new Set(
        bindings.flatMap((binding) =>
          binding.kind === "message" ? [binding.participantId] : []
        ),
      ),
    ].sort());
    if (participantIds.length > PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS) {
      return Object.freeze({
        status: "blocked",
        reason: "input_bound_exceeded",
      });
    }
    let sourceBindingFingerprint: Uint8Array;
    try {
      sourceBindingFingerprint =
        fingerprintProtectedStenographerSourceBindings(bindings);
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }

    if (
      recovery !== undefined
      && state.leaseToken !== null
      && state.leaseExpiresAt !== null
      && state.leaseExpiresAt.getTime() > now.getTime()
      && (
        recovery.status !== "running"
        || recovery.currentRunningBatchId !== recovery.workId
      )
    ) {
      return Object.freeze({ status: "unavailable", reason: "leased" });
    }
    // Reusing the exact durable product lease reconstructs metadata only. It
    // does not authorize a model call: the processor credential claim port's
    // durable claimed→running CAS is the single execution winner.
    const reusableLease = recovery !== undefined
      && state.leaseToken !== null
      && state.leaseExpiresAt !== null
      && state.leaseExpiresAt.getTime() > now.getTime();
    const leaseToken = reusableLease
      ? state.leaseToken
      : uuid(
        "protected Stenographer lease token",
        this.#leaseToken(),
      );
    const leaseExpiresAt = reusableLease
      ? new Date(state.leaseExpiresAt)
      : new Date(
        now.getTime() + PROTECTED_STENOGRAPHER_WORK_LEASE_MS,
      );
    if (!reusableLease) {
      const leased = await executeTypedConversationProductQuery(
        transaction,
        typedDb.update(roomJournalState)
          .set({
            leaseToken,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(and(
            eq(roomJournalState.roomId, roomId),
            eq(roomJournalState.rebuildGeneration, state.rebuildGeneration),
            rebuildMode
              ? and(
                isNotNull(roomJournalState.rebuildRequestedAt),
                eq(
                  roomJournalState.rebuildTargetMessageId,
                  state.rebuildTarget!,
                ),
              )
              : and(
                isNull(roomJournalState.rebuildRequestedAt),
                isNull(roomJournalState.rebuildTargetMessageId),
              ),
            or(
              isNull(roomJournalState.leaseToken),
              isNull(roomJournalState.leaseExpiresAt),
              lte(roomJournalState.leaseExpiresAt, now),
            ),
          ))
          .returning({ room_id: roomJournalState.roomId }),
      );
      if (leased.length !== 1 || leased[0]?.["room_id"] !== roomId) {
        return Object.freeze({ status: "unavailable", reason: "stale" });
      }
    }
    const batchRows = recovery === undefined
      ? await executeTypedConversationProductQuery(transaction, typedDb
        .insert(roomJournalBatches)
        .values({
          roomId,
          fromMessageIdExclusive: planned.plan.fromMessageIdExclusive,
          throughMessageIdInclusive: planned.plan.throughMessageIdInclusive,
          extractorVersion: PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION,
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
            attemptCount: sql`${roomJournalBatches.attemptCount} + 1`,
            startedAt: now,
            completedAt: null,
          },
        })
        .returning({
          id: roomJournalBatches.id,
          attempt_count: roomJournalBatches.attemptCount,
          created_at: roomJournalBatches.createdAt,
        }))
      : reusableLease
      ? [{
        id: recovery.workId,
        attempt_count: recovery.attemptCount,
        created_at: recovery.createdAt,
      }]
      : await executeTypedConversationProductQuery(transaction, typedDb
        .update(roomJournalBatches)
        .set({
          status: "running",
          attemptCount: sql`${roomJournalBatches.attemptCount} + 1`,
          startedAt: now,
          completedAt: null,
        })
        .where(and(
          eq(roomJournalBatches.id, recovery.workId),
          eq(roomJournalBatches.roomId, roomId),
          eq(
            roomJournalBatches.fromMessageIdExclusive,
            recovery.fromMessageIdExclusive,
          ),
          eq(
            roomJournalBatches.throughMessageIdInclusive,
            recovery.throughMessageIdInclusive,
          ),
          eq(roomJournalBatches.extractorVersion, recovery.extractorVersion),
          eq(roomJournalBatches.lane, recovery.lane),
        ))
        .returning({
          id: roomJournalBatches.id,
          attempt_count: roomJournalBatches.attemptCount,
          created_at: roomJournalBatches.createdAt,
        }));
    const batchRow = exactlyOne(
      "protected Stenographer batch",
      batchRows,
    );
    if (batchRow === null) {
      throw new Error("protected Stenographer batch upsert returned no row");
    }
    const sourceBatchId = uuid(
      "protected Stenographer batch",
      batchRow["id"],
    );
    const attemptCount = counter(
      "protected Stenographer attempt",
      batchRow["attempt_count"],
      1,
    );
    const createdAt = rowTimestampText(
      "protected Stenographer batch creation time",
      batchRow["created_at"],
    );
    const inputObjectIds = Object.freeze(
      bindings.map((binding) => binding.objectId),
    );
    return Object.freeze({
      status: "claimed",
      claim: Object.freeze({
        kind: "extraction",
        workKind: rebuildMode
          ? "stenographer.rebuild"
          : lane === "live"
          ? "stenographer.extraction"
          : "stenographer.historical",
        workId: sourceBatchId,
        sourceBatchId,
        roomId: state.roomId,
        namespaceId: state.namespaceId,
        ownerId: state.ownerId,
        rebuildGeneration: state.rebuildGeneration,
        ...(rebuildMode
          ? { rebuildTargetMessageId: state.rebuildTarget! }
          : {}),
        lane,
        leaseToken,
        leaseExpiresAt,
        attemptCount,
        fromMessageIdExclusive: planned.plan.fromMessageIdExclusive,
        throughMessageIdInclusive:
          planned.plan.throughMessageIdInclusive,
        trigger: planned.plan.trigger,
        requiresContentRecheck: planned.plan.requiresContentRecheck,
        bindings,
        inputObjectIds,
        coveredRangeFingerprint: planned.plan.sourceFingerprint.slice(),
        sourceBindingFingerprint,
        participantIds,
        outputSlots: extractionOutputSlots(sourceBatchId),
        extractorVersion:
          PROTECTED_STENOGRAPHER_WORK_EXTRACTOR_VERSION,
        createdAt,
      }),
    });
  }

  async claimCompaction(input: Readonly<{
    readonly roomId: string;
    readonly now: Date;
  }>): Promise<ProtectedStenographerCompactionClaimResult> {
    const exactRoomId = uuid("protected Stenographer Room", input.roomId);
    const now = date("protected Stenographer claim time", input.now);
    return this.handle.transaction(
      (transaction) =>
        this.#claimCompactionInTransaction(transaction, exactRoomId, now),
      { isolationLevel: "serializable" },
    );
  }

  async recoverCompaction(input: Readonly<{
    readonly workId: string;
    readonly createdAt: string;
    readonly now: Date;
  }>): Promise<ProtectedStenographerCompactionClaimResult> {
    const workId = portableId(
      "protected compaction recovery work",
      input.workId,
    );
    const match =
      /^stenographer-compaction\/([0-9a-f-]{36})\/([0-9]+)\/([0-9]+)$/u
        .exec(workId);
    if (match === null) {
      return Object.freeze({ status: "unavailable", reason: "missing" });
    }
    const recovery: CompactionRecoveryContext = Object.freeze({
      workId,
      roomId: uuid("protected compaction recovery Room", match[1]),
      rebuildGeneration: counter(
        "protected compaction recovery generation",
        match[2],
      ),
      throughEventSequence: counter(
        "protected compaction recovery sequence",
        match[3],
      ),
      createdAt: timestampText(
        "protected compaction recovery creation time",
        input.createdAt,
      ),
    });
    const now = date("protected compaction recovery time", input.now);
    return this.handle.transaction(
      (transaction) =>
        this.#claimCompactionInTransaction(
          transaction,
          recovery.roomId,
          now,
          recovery,
        ),
      { isolationLevel: "serializable" },
    );
  }

  async #claimCompactionInTransaction(
    transaction: ConversationProductPostgresTransaction,
    roomId: string,
    now: Date,
    recovery?: CompactionRecoveryContext,
  ): Promise<ProtectedStenographerCompactionClaimResult> {
    const stateRow = exactlyOne(
      "protected Stenographer state",
      await transaction.query(STATE_QUERY, [roomId, "live"]),
    );
    if (stateRow === null) {
      return Object.freeze({ status: "unavailable", reason: "missing" });
    }
    const state = stateFromRow(stateRow);
    const unavailable = compactionAvailability(state, now);
    if (
      recovery !== undefined
      && unavailable?.status === "unavailable"
      && unavailable.reason === "leased"
    ) {
      // Exact recovery reuses the one current compaction lease only after the
      // current metadata selection is reproduced below.
    } else if (unavailable !== null) {
      return unavailable;
    }
    if (
      recovery !== undefined
      && (
        recovery.roomId !== state.roomId
        || recovery.rebuildGeneration !== state.rebuildGeneration
      )
    ) {
      return Object.freeze({ status: "unavailable", reason: "stale" });
    }

    const rollupRows = await transaction.query(
      `${ROLLUP_METADATA_PROJECTION}
        WHERE rollup.room_id = $1::uuid
        ORDER BY rollup.through_event_sequence DESC, rollup.created_at DESC
        LIMIT 1`,
      [roomId],
    );
    let latestRollup: ReturnType<typeof rollupMetadata> | null;
    try {
      latestRollup = rollupRows[0] === undefined
        ? null
        : rollupMetadata(rollupRows[0]);
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }
    const through = latestRollup?.throughEventSequence ?? 0;
    const countRow = exactlyOne(
      "protected Stenographer active event count",
      await executeTypedConversationProductQuery(transaction, typedDb
        .select({ active_event_count: count().as("active_event_count") })
        .from(roomEvents)
        .where(and(
          eq(roomEvents.roomId, roomId),
          eq(roomEvents.status, "active"),
          sql`${roomEvents.sequence} > ${through}`,
        )),
      ),
    );
    if (countRow === null) {
      throw new Error("protected Stenographer event count returned no row");
    }
    const activeEventCount = counter(
      "protected Stenographer active event count",
      countRow["active_event_count"],
    );
    const eventRows = await transaction.query(
      `WITH active_event AS (
         ${PROTECTED_JOURNAL_EVENT_PROJECTION_SQL}
          WHERE event.room_id = $1::uuid
            AND event.status = 'active'
            AND event.sequence > $2::integer
       ),
       selected_event AS (
         (SELECT * FROM active_event
           ORDER BY sequence
           LIMIT $3::integer)
         UNION
         (SELECT * FROM active_event
           ORDER BY sequence DESC
           LIMIT 50)
       )
       SELECT * FROM selected_event ORDER BY sequence`,
      [
        roomId,
        through,
        COMPACTION_OLDEST_EVENT_LIMIT,
      ],
    );
    let events: readonly ReturnType<typeof eventMetadata>[];
    try {
      events = Object.freeze(eventRows.map(eventMetadata));
    } catch {
      return Object.freeze({ status: "blocked", reason: "invalid_metadata" });
    }
    const planned = planProtectedStenographerCompaction({
      events,
      latestRollup,
      force: true,
    });
    if (planned.status === "wait") {
      return Object.freeze({ status: "unavailable", reason: "not_due" });
    }
    if (planned.status === "blocked") {
      return Object.freeze({
        status: "blocked",
        reason: planned.reason,
      });
    }
    const lastSequence = events.at(-1)?.sequence
      ?? latestRollup?.throughEventSequence
      ?? 0;
    const workId =
      `stenographer-compaction/${roomId}/${state.rebuildGeneration}/${lastSequence}`;
    if (
      recovery !== undefined
      && (
        recovery.workId !== workId
        || recovery.throughEventSequence !== lastSequence
      )
    ) {
      return Object.freeze({ status: "unavailable", reason: "stale" });
    }
    // This metadata lease may be observed by duplicate restart contenders.
    // Exactly one can cross the later durable processor credential CAS and
    // receive a transform capability; losers never invoke the model.
    const reusableLease = recovery !== undefined
      && state.compactionLeaseToken !== null
      && state.compactionLeaseExpiresAt !== null
      && state.compactionLeaseExpiresAt.getTime() > now.getTime();
    const leaseToken = reusableLease
      ? state.compactionLeaseToken
      : uuid(
        "protected compaction lease token",
        this.#leaseToken(),
      );
    const leaseExpiresAt = reusableLease
      ? new Date(state.compactionLeaseExpiresAt)
      : new Date(
        now.getTime() + PROTECTED_STENOGRAPHER_WORK_LEASE_MS,
      );
    if (!reusableLease) {
      const leased = await executeTypedConversationProductQuery(
        transaction,
        typedDb.update(roomJournalState)
          .set({
            compactionLeaseToken: leaseToken,
            compactionLeaseExpiresAt: leaseExpiresAt,
            updatedAt: now,
          })
          .where(and(
            eq(roomJournalState.roomId, roomId),
            eq(roomJournalState.rebuildGeneration, state.rebuildGeneration),
            isNull(roomJournalState.rebuildRequestedAt),
            isNotNull(roomJournalState.compactionDueAt),
            or(
              isNull(roomJournalState.compactionLeaseToken),
              isNull(roomJournalState.compactionLeaseExpiresAt),
              lte(roomJournalState.compactionLeaseExpiresAt, now),
            ),
          ))
          .returning({ room_id: roomJournalState.roomId }),
      );
      if (leased.length !== 1 || leased[0]?.["room_id"] !== roomId) {
        return Object.freeze({ status: "unavailable", reason: "stale" });
      }
    }
    return Object.freeze({
      status: "claimed",
      claim: Object.freeze({
        kind: "compaction",
        workKind: "stenographer.compaction",
        workId,
        roomId: state.roomId,
        namespaceId: state.namespaceId,
        ownerId: state.ownerId,
        rebuildGeneration: state.rebuildGeneration,
        leaseToken,
        leaseExpiresAt,
        attemptCount: state.compactionFailureCount + 1,
        bindings: planned.bindings,
        inputObjectIds: planned.inputObjectIds,
        sourceBindingFingerprint:
          planned.sourceBindingFingerprint.slice(),
        activeEventCount,
        selectedEventCount: planned.selectedEventCount,
        hasDeferredMiddle:
          activeEventCount > planned.selectedEventCount,
        outputSlot: compactionOutputSlot(workId),
        compactorVersion:
          PROTECTED_STENOGRAPHER_WORK_COMPACTOR_VERSION,
        createdAt: recovery?.createdAt ?? now.toISOString(),
      }),
    });
  }
}
