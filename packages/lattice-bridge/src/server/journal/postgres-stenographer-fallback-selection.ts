import {
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  stenographerOrdinaryOutputFingerprint,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
  actors,
  alias,
  and,
  asc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecords,
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
  roomJournalState,
  roomMembers,
  rooms,
  sql,
} from "@nautilo/db";

import type {
  ForegroundJournalProtectedMapping,
  ForegroundJournalSelectedEvent,
  ForegroundJournalSelectedRollup,
  ForegroundJournalSelectionSnapshot,
} from "../../journal/foreground-journal-selection.ts";
import type {RoomEventPayloadKindV1} from
  "../../journal/room-event-payload-v1.ts";
import {
  decodeStenographerOutputRepairPlan,
  encodeStenographerOutputRepairPlan,
  type StenographerOutputRepairPlan,
} from "../../journal/stenographer-output-repair-plan.ts";
import {ClassifiedDataOperationError} from
  "../../transition/encryption-data-operation-owner.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const EVENT_KINDS = new Set<RoomEventPayloadKindV1>([
  "decision",
  "commitment",
  "goal",
  "state_change",
  "fact",
  "preference_or_norm",
  "open_question",
  "risk",
]);

export type PostgresStenographerFallbackReceiptSelection = Readonly<{
  kind: "extraction" | "compaction";
  id: string;
  roomId: string;
  namespaceId: string;
  rebuildGeneration: number;
  fallbackReason: "device" | "authority";
  ordinaryOutputFingerprint: Uint8Array;
  createdAt: number;
}>;

export type PostgresStenographerFallbackSelectionResult =
  | Readonly<{
      status: "ready";
      receipt: PostgresStenographerFallbackReceiptSelection;
      snapshot: ForegroundJournalSelectionSnapshot;
      /** Current ordinary payload timestamps in the exact snapshot output order. */
      outputCreatedAt: readonly number[];
    }>
  | Readonly<{status: "missing" | "stale"}>;

export type PostgresStenographerFallbackCandidate = Readonly<{
  kind: "extraction" | "compaction";
  id: string;
  roomId: string;
  namespaceId: string;
  rebuildGeneration: number;
  createdAt: number;
}>;

export type PostgresStenographerFallbackCandidateCursor = Readonly<{
  createdAt: number;
  kind: "extraction" | "compaction";
  id: string;
}>;

export type PostgresStenographerFallbackCandidatePage = Readonly<{
  candidates: readonly PostgresStenographerFallbackCandidate[];
  continuation: PostgresStenographerFallbackCandidateCursor | null;
}>;

type ProductTransaction = Parameters<
  Parameters<ConversationProductPostgresHandle["transaction"]>[0]
>[0];

function candidateCursor(
  value: PostgresStenographerFallbackCandidateCursor | undefined,
): PostgresStenographerFallbackCandidateCursor | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isFinite(new Date(value.createdAt).getTime())
    || (value.kind !== "extraction" && value.kind !== "compaction")) {
    throw new TypeError("Stenographer fallback candidate cursor is invalid");
  }
  return Object.freeze({
    createdAt: value.createdAt,
    kind: value.kind,
    id: inputUuid("Stenographer fallback candidate cursor", value.id),
  });
}

function candidateRow(
  kind: "extraction" | "compaction",
  row: ConversationProductDatabaseRow,
): PostgresStenographerFallbackCandidate {
  return Object.freeze({
    kind,
    id: rowUuid("Stenographer fallback candidate", row["id"]),
    roomId: rowUuid("Stenographer fallback candidate Room", row["room_id"]),
    namespaceId: rowUuid(
      "Stenographer fallback candidate Namespace",
      row["namespace_id"],
    ),
    rebuildGeneration: rowCount(
      "Stenographer fallback candidate rebuild generation",
      row["ordinary_fallback_rebuild_generation"],
    ),
    createdAt: rowTime(
      "Stenographer fallback candidate timestamp",
      row[kind === "extraction" ? "completed_at" : "created_at"],
    ),
  });
}

function compareCandidates(
  left: PostgresStenographerFallbackCandidate,
  right: PostgresStenographerFallbackCandidate,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.kind !== right.kind) return left.kind === "extraction" ? -1 : 1;
  return left.id.localeCompare(right.id);
}

/**
 * Page content-free fallback receipts that still have a missing protected
 * mapping. A completed extraction with no native events is deliberately absent:
 * its stored empty-output fingerprint is already the durable proof of its
 * result, so it must never create a device grant or block later repair work.
 */
export async function listPostgresStenographerFallbackCandidates(input: Readonly<{
  product: ConversationProductPostgresHandle;
  limit: number;
  after?: PostgresStenographerFallbackCandidateCursor;
}>): Promise<PostgresStenographerFallbackCandidatePage> {
  assertVerifiedConversationProductPostgresHandle(input.product);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
    || input.limit > BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.pruningBatch) {
    throw new TypeError("Stenographer fallback candidate limit must be bounded");
  }
  const after = candidateCursor(input.after);
  const afterDate = after === undefined ? undefined : new Date(after.createdAt);
  const pageSize = input.limit + 1;
  return input.product.transaction(async transaction => {
    const agentMember = conversationProductTypedDb.select({id: actors.id})
      .from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(roomMembers.roomId, rooms.id),
        eq(actors.kind, "agent"),
      ));
    const eligible = and(
      notInArray(rooms.kind, ["task", "access"]),
      isNull(roomJournalState.suspendedAt),
      isNull(roomJournalState.rebuildRequestedAt),
      isNull(roomJournalState.rebuildTargetMessageId),
      exists(agentMember),
    );
    const nativeProtectedHead = conversationProductTypedDb.select({
      id: reflectionRecordPayloadRepresentationHeads.recordId,
    }).from(reflectionRecordPayloadRepresentationHeads).where(and(
      eq(reflectionRecordPayloadRepresentationHeads.recordId, roomEvents.recordId),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
    ));
    const unprotectedEvent = conversationProductTypedDb.select({id: roomEvents.id})
      .from(roomEvents).where(and(
        eq(roomEvents.sourceBatchId, roomJournalBatches.id),
        eq(roomEvents.roomId, roomJournalBatches.roomId),
        eq(roomEvents.projectionKind, "native"),
        notExists(nativeProtectedHead),
      ));
    const extractionAfter = after === undefined ? undefined
      : after.kind === "compaction"
      ? gt(roomJournalBatches.completedAt, afterDate!)
      : or(
        gt(roomJournalBatches.completedAt, afterDate!),
        and(
          eq(roomJournalBatches.completedAt, afterDate!),
          gt(roomJournalBatches.id, after.id),
        ),
      );
    const compactionAfter = after === undefined ? undefined
      : after.kind === "extraction"
      ? or(
        gt(roomEventRollups.createdAt, afterDate!),
        eq(roomEventRollups.createdAt, afterDate!),
      )
      : or(
        gt(roomEventRollups.createdAt, afterDate!),
        and(
          eq(roomEventRollups.createdAt, afterDate!),
          gt(roomEventRollups.id, after.id),
        ),
      );
    const extractionRows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        id: roomJournalBatches.id,
        roomId: roomJournalBatches.roomId,
        namespaceId: rooms.namespaceId,
        rebuildGeneration: roomJournalBatches.ordinaryFallbackRebuildGeneration,
        completedAt: roomJournalBatches.completedAt,
      }).from(roomJournalBatches)
        .innerJoin(roomJournalState,
          eq(roomJournalState.roomId, roomJournalBatches.roomId))
        .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
        .where(and(
          eligible,
          eq(roomJournalBatches.status, "completed"),
          eq(roomJournalBatches.observationPublicationVersion, 2),
          isNotNull(roomJournalBatches.ordinaryFallbackReason),
          isNotNull(roomJournalBatches.ordinaryOutputFingerprint),
          eq(roomJournalBatches.ordinaryFallbackRebuildGeneration,
            roomJournalState.rebuildGeneration),
          exists(unprotectedEvent),
          extractionAfter,
        ))
        .orderBy(asc(roomJournalBatches.completedAt), asc(roomJournalBatches.id))
        .limit(pageSize),
    );
    const compactionRows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        id: roomEventRollups.id,
        roomId: roomEventRollups.roomId,
        namespaceId: rooms.namespaceId,
        rebuildGeneration: roomEventRollups.ordinaryFallbackRebuildGeneration,
        createdAt: roomEventRollups.createdAt,
      }).from(roomEventRollups)
        .innerJoin(roomJournalState,
          eq(roomJournalState.roomId, roomEventRollups.roomId))
        .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
        .where(and(
          eligible,
          isNotNull(roomEventRollups.ordinaryFallbackReason),
          isNotNull(roomEventRollups.ordinaryOutputFingerprint),
          isNull(roomEventRollups.cryptoObjectId),
          eq(roomEventRollups.ordinaryFallbackRebuildGeneration,
            roomJournalState.rebuildGeneration),
          compactionAfter,
        ))
        .orderBy(asc(roomEventRollups.createdAt), asc(roomEventRollups.id))
        .limit(pageSize),
    );
    const merged = [
      ...extractionRows.map(row => candidateRow("extraction", row)),
      ...compactionRows.map(row => candidateRow("compaction", row)),
    ].sort(compareCandidates);
    const candidates = Object.freeze(merged.slice(0, input.limit));
    const last = candidates.at(-1);
    return Object.freeze({
      candidates,
      continuation: merged.length > input.limit && last !== undefined
        ? Object.freeze({
          createdAt: last.createdAt,
          kind: last.kind,
          id: last.id,
        })
        : null,
    });
  }, {isolationLevel: "serializable"});
}

type ExactReceipt = Readonly<{
  kind: "extraction" | "compaction";
  id: string;
  roomId: string;
  namespaceId: string;
  rebuildGeneration: number;
  fallbackReason: "device" | "authority";
  ordinaryOutputFingerprint: Uint8Array;
  createdAt: number;
  operationCount: number | null;
  extractorVersion: string | null;
  rollup: ForegroundJournalSelectedRollup | null;
}>;

type NativeProtectedMapping = Extract<
  ForegroundJournalSelectedEvent["payload"],
  Readonly<{kind: "reflection_record"}>
>["protectedMapping"];

function integrity(message: string): never {
  throw new ClassifiedDataOperationError("integrity", message);
}

function inputUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function rowUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    return integrity(`${label} is invalid`);
  }
  return value;
}

function rowText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || !PORTABLE_ID.test(value)) {
    return integrity(`${label} is invalid`);
  }
  return value;
}

function rowCount(label: string, value: unknown, minimum = 0): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)
    || normalized < minimum) return integrity(`${label} is invalid`);
  return normalized;
}

function rowTime(label: string, value: unknown): number {
  const instant = value instanceof Date ? value.getTime()
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(instant) || instant < 0) {
    return integrity(`${label} is invalid`);
  }
  return instant;
}

function fingerprint(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    return integrity("Stenographer fallback fingerprint is invalid");
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function fallbackReason(value: unknown): "device" | "authority" {
  if (value !== "device" && value !== "authority") {
    return integrity("Stenographer fallback reason is invalid");
  }
  return value;
}

function sourceMessageIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return integrity("Stenographer fallback event sources are invalid");
  }
  const result = value.map((entry) =>
    rowCount("Stenographer fallback source Message", entry, 1));
  if (result.some((entry, index) => index > 0 && result[index - 1]! >= entry)) {
    return integrity("Stenographer fallback event sources are not canonical");
  }
  return Object.freeze(result);
}

function nullableUuid(label: string, value: unknown): string | null {
  return value === null ? null : rowUuid(label, value);
}

function selectedEvent(input: Readonly<{
  row: ConversationProductDatabaseRow;
  receipt: ExactReceipt;
}>): ForegroundJournalSelectedEvent {
  const {row, receipt} = input;
  const eventId = rowUuid("Stenographer fallback event", row["event_id"]);
  const roomId = rowUuid("Stenographer fallback event Room", row["room_id"]);
  if (roomId !== receipt.roomId
    || row["source_batch_id"] !== receipt.id
    || row["extractor_version"] !== receipt.extractorVersion) {
    return integrity("Stenographer fallback event provenance changed");
  }
  const kind = row["kind"];
  const status = row["status"];
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind as RoomEventPayloadKindV1)
    || (status !== "active" && status !== "superseded" && status !== "resolved")) {
    return integrity("Stenographer fallback event state is invalid");
  }
  const createdAt = rowTime("Stenographer fallback event timestamp", row["created_at"]);
  if (row["projection_kind"] !== "native" || row["record_id"] !== eventId
    || row["event_crypto_object_id"] !== null) {
    return integrity("Stenographer fallback event is not an exact native Record");
  }
  const lifecycle = row["record_lifecycle"];
  if (lifecycle !== "current" && lifecycle !== "stale"
    && lifecycle !== "superseded" && lifecycle !== "resolved"
    && lifecycle !== "sunset") {
    return integrity("Stenographer fallback Record lifecycle is invalid");
  }
  if (row["record_disposition"] !== "available"
    || row["record_producer_policy_version"] !== receipt.extractorVersion
    || row["record_payload_version"] !== 1) {
    return integrity("Stenographer fallback Record metadata changed");
  }

  // Event observation time precedes the canonical Record insertion transaction.
  rowTime("Stenographer fallback Record timestamp", row["record_created_at"]);
  const ordinaryHead = rowCount(
    "Stenographer fallback ordinary head",
    row["ordinary_head_generation"],
    1,
  );
  if (row["ordinary_representation_generation"] !== ordinaryHead
    || row["ordinary_representation_payload_version"] !== 1
    || row["ordinary_representation_crypto_object_id"] !== null
    || typeof row["ordinary_publication_id"] !== "string") {
    return integrity("Stenographer fallback ordinary representation is incomplete");
  }

  const protectedHead = row["protected_head_generation"];
  let protectedMapping: NativeProtectedMapping;
  if (protectedHead === null) {
    if (row["protected_representation_generation"] !== null
      || row["protected_representation_payload_version"] !== null
      || row["protected_record_crypto_object_id"] !== null
      || row["protected_publication_id"] !== null) {
      return integrity("Stenographer fallback protected head is incoherent");
    }
    protectedMapping = Object.freeze({status: "missing" as const});
  } else {
    const generation = rowCount(
      "Stenographer fallback protected head",
      protectedHead,
      1,
    );
    if (row["protected_representation_generation"] !== generation
      || row["protected_representation_payload_version"] !== 1
      || typeof row["protected_publication_id"] !== "string") {
      return integrity("Stenographer fallback protected publication is incomplete");
    }
    protectedMapping = Object.freeze({
      status: "mapped" as const,
      representationGeneration: generation,
      cryptoObjectId: rowText(
        "Stenographer fallback protected object",
        row["protected_record_crypto_object_id"],
      ),
    });
  }

  return Object.freeze({
    kind: "event" as const,
    rebuildGeneration: receipt.rebuildGeneration,
    status,
    binding: Object.freeze({
      eventId,
      roomId: receipt.roomId,
      namespaceId: receipt.namespaceId,
      sequence: rowCount("Stenographer fallback event sequence", row["sequence"], 1),
      kind: kind as RoomEventPayloadKindV1,
      supersedesEventId: nullableUuid(
        "Stenographer fallback superseded event",
        row["supersedes_event_id"],
      ),
      resolvesEventId: nullableUuid(
        "Stenographer fallback resolved event",
        row["resolves_event_id"],
      ),
      sourceMessageIds: sourceMessageIds(row["source_message_ids"]),
      sourceBatchId: receipt.id,
      batchLocalOrdinal: rowCount(
        "Stenographer fallback batch ordinal",
        row["batch_local_ordinal"],
      ),
      extractorVersion: receipt.extractorVersion!,
      createdAt: new Date(createdAt).toISOString(),
    }),
    payload: Object.freeze({
      kind: "reflection_record" as const,
      recordId: eventId,
      lifecycle,
      structuralHeight: rowCount(
        "Stenographer fallback Record height",
        row["record_structural_height"],
      ),
      processingGeneration: rowCount(
        "Stenographer fallback Record processing generation",
        row["record_processing_generation"],
        1,
      ),
      ordinaryRepresentationGeneration: ordinaryHead,
      protectedMapping,
    }),
  });
}

async function currentScope(
  tx: ProductTransaction,
  receipt: ExactReceipt,
): Promise<"current" | "stale"> {
  const rows = await executeTypedConversationProductQuery(tx,
    conversationProductTypedDb.select({
      namespaceId: rooms.namespaceId,
      rebuildGeneration: roomJournalState.rebuildGeneration,
      rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
      rebuildTargetMessageId: roomJournalState.rebuildTargetMessageId,
    }).from(roomJournalState)
      .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
      .where(eq(roomJournalState.roomId, receipt.roomId)).limit(2));
  if (rows.length === 0) return "stale";
  if (rows.length !== 1) return integrity("Stenographer fallback Room state is duplicated");
  const row = rows[0]!;
  return row["namespace_id"] === receipt.namespaceId
      && rowCount("Stenographer fallback current rebuild", row["rebuild_generation"])
        === receipt.rebuildGeneration
      && row["rebuild_requested_at"] === null
      && row["rebuild_target_message_id"] === null
    ? "current"
    : "stale";
}

function provenanceIsAbsent(row: ConversationProductDatabaseRow): boolean {
  return row["ordinary_fallback_reason"] === null
    && row["ordinary_fallback_rebuild_generation"] === null
    && row["ordinary_output_fingerprint"] === null;
}

function exactProvenance(row: ConversationProductDatabaseRow): Readonly<{
  rebuildGeneration: number;
  fallbackReason: "device" | "authority";
  ordinaryOutputFingerprint: Uint8Array;
}> {
  if (provenanceIsAbsent(row)) {
    return integrity("Stenographer fallback provenance is absent");
  }
  if (row["ordinary_fallback_reason"] === null
    || row["ordinary_fallback_rebuild_generation"] === null
    || row["ordinary_output_fingerprint"] === null) {
    return integrity("Stenographer fallback provenance is incoherent");
  }
  return Object.freeze({
    rebuildGeneration: rowCount(
      "Stenographer fallback rebuild generation",
      row["ordinary_fallback_rebuild_generation"],
    ),
    fallbackReason: fallbackReason(row["ordinary_fallback_reason"]),
    ordinaryOutputFingerprint: fingerprint(row["ordinary_output_fingerprint"]),
  });
}

async function loadExtractionReceipt(
  tx: ProductTransaction,
  id: string,
): Promise<ExactReceipt | "missing" | "stale"> {
  const rows = await executeTypedConversationProductQuery(tx,
    conversationProductTypedDb.select({
      receiptId: roomJournalBatches.id,
      roomId: roomJournalBatches.roomId,
      namespaceId: rooms.namespaceId,
      status: roomJournalBatches.status,
      observationPublicationVersion:
        roomJournalBatches.observationPublicationVersion,
      operationCount: roomJournalBatches.operationCount,
      extractorVersion: roomJournalBatches.extractorVersion,
      ordinaryFallbackReason: roomJournalBatches.ordinaryFallbackReason,
      ordinaryFallbackRebuildGeneration:
        roomJournalBatches.ordinaryFallbackRebuildGeneration,
      ordinaryOutputFingerprint: roomJournalBatches.ordinaryOutputFingerprint,
      completedAt: roomJournalBatches.completedAt,
    }).from(roomJournalBatches)
      .innerJoin(rooms, eq(rooms.id, roomJournalBatches.roomId))
      .where(eq(roomJournalBatches.id, id)).limit(2));
  if (rows.length === 0) return "missing";
  if (rows.length !== 1) return integrity("Stenographer fallback batch is duplicated");
  const row = rows[0]!;
  if (row["status"] !== "completed"
    || row["observation_publication_version"] !== 2
    || provenanceIsAbsent(row)) return "stale";
  const provenance = exactProvenance(row);
  const operationCount = rowCount(
    "Stenographer fallback operation count",
    row["operation_count"],
  );
  if (operationCount > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2) {
    return integrity("Stenographer fallback operation count is excessive");
  }
  return Object.freeze({
    kind: "extraction" as const,
    id: rowUuid("Stenographer fallback batch", row["id"]),
    roomId: rowUuid("Stenographer fallback Room", row["room_id"]),
    namespaceId: rowUuid("Stenographer fallback Namespace", row["namespace_id"]),
    rebuildGeneration: provenance.rebuildGeneration,
    fallbackReason: provenance.fallbackReason,
    ordinaryOutputFingerprint: provenance.ordinaryOutputFingerprint,
    createdAt: rowTime("Stenographer fallback completion", row["completed_at"]),
    operationCount,
    extractorVersion: rowText(
      "Stenographer fallback extractor",
      row["extractor_version"],
    ),
    rollup: null,
  });
}

async function loadCompactionReceipt(
  tx: ProductTransaction,
  id: string,
): Promise<ExactReceipt | "missing" | "stale"> {
  const rows = await executeTypedConversationProductQuery(tx,
    conversationProductTypedDb.select({
      receiptId: roomEventRollups.id,
      roomId: roomEventRollups.roomId,
      namespaceId: rooms.namespaceId,
      throughEventSequence: roomEventRollups.throughEventSequence,
      sourceEventCount: roomEventRollups.sourceEventCount,
      modelId: roomEventRollups.modelId,
      compactorVersion: roomEventRollups.compactorVersion,
      cryptoObjectId: roomEventRollups.cryptoObjectId,
      ordinaryFallbackReason: roomEventRollups.ordinaryFallbackReason,
      ordinaryFallbackRebuildGeneration:
        roomEventRollups.ordinaryFallbackRebuildGeneration,
      ordinaryOutputFingerprint: roomEventRollups.ordinaryOutputFingerprint,
      createdAt: roomEventRollups.createdAt,
    }).from(roomEventRollups)
      .innerJoin(rooms, eq(rooms.id, roomEventRollups.roomId))
      .where(eq(roomEventRollups.id, id)).limit(2));
  if (rows.length === 0) return "missing";
  if (rows.length !== 1) return integrity("Stenographer fallback rollup is duplicated");
  const row = rows[0]!;
  if (provenanceIsAbsent(row)) return "stale";
  const provenance = exactProvenance(row);
  const roomId = rowUuid("Stenographer fallback Room", row["room_id"]);
  const namespaceId = rowUuid("Stenographer fallback Namespace", row["namespace_id"]);
  const receiptId = rowUuid("Stenographer fallback rollup", row["id"]);
  const createdAt = rowTime("Stenographer fallback rollup timestamp", row["created_at"]);
  const protectedMapping: ForegroundJournalProtectedMapping =
    row["crypto_object_id"] === null
      ? Object.freeze({status: "missing" as const})
      : Object.freeze({status: "mapped" as const,
          cryptoObjectId: rowText(
            "Stenographer fallback rollup object",
            row["crypto_object_id"],
          )});
  const rollup: ForegroundJournalSelectedRollup = Object.freeze({
    kind: "rollup" as const,
    rebuildGeneration: provenance.rebuildGeneration,
    binding: Object.freeze({
      rollupId: receiptId,
      roomId,
      namespaceId,
      throughEventSequence: rowCount(
        "Stenographer fallback rollup sequence",
        row["through_event_sequence"],
        1,
      ),
      sourceEventCount: rowCount(
        "Stenographer fallback rollup source count",
        row["source_event_count"],
        1,
      ),
      modelId: rowText("Stenographer fallback rollup model", row["model_id"]),
      compactorVersion: rowText(
        "Stenographer fallback rollup compactor",
        row["compactor_version"],
      ),
      createdAt: new Date(createdAt).toISOString(),
    }),
    protectedMapping,
  });
  return Object.freeze({
    kind: "compaction" as const,
    id: receiptId,
    roomId,
    namespaceId,
    rebuildGeneration: provenance.rebuildGeneration,
    fallbackReason: provenance.fallbackReason,
    ordinaryOutputFingerprint: provenance.ordinaryOutputFingerprint,
    createdAt,
    operationCount: null,
    extractorVersion: null,
    rollup,
  });
}

async function loadExtractionEvents(
  tx: ProductTransaction,
  receipt: ExactReceipt,
): Promise<Readonly<{events: readonly ForegroundJournalSelectedEvent[]; outputCreatedAt: readonly number[]}>> {
  const ordinaryHead = alias(
    reflectionRecordPayloadRepresentationHeads,
    "fallback_ordinary_head",
  );
  const protectedHead = alias(
    reflectionRecordPayloadRepresentationHeads,
    "fallback_protected_head",
  );
  const ordinaryRepresentation = alias(
    reflectionRecordPayloadRepresentations,
    "fallback_ordinary_representation",
  );
  const protectedRepresentation = alias(
    reflectionRecordPayloadRepresentations,
    "fallback_protected_representation",
  );
  const ordinaryPublication = alias(
    reflectionRecordPublications,
    "fallback_ordinary_publication",
  );
  const protectedPublication = alias(
    reflectionRecordPublications,
    "fallback_protected_publication",
  );
  const rows = await executeTypedConversationProductQuery(tx,
    conversationProductTypedDb.select({
      event_id: sql<string>`${roomEvents.id}`.as("event_id"),
      roomId: roomEvents.roomId,
      sequence: roomEvents.sequence,
      kind: roomEvents.kind,
      status: roomEvents.status,
      supersedesEventId: roomEvents.supersedesEventId,
      resolvesEventId: roomEvents.resolvesEventId,
      sourceMessageIds: roomEvents.sourceMessageIds,
      sourceBatchId: roomEvents.sourceBatchId,
      batchLocalOrdinal: roomEvents.batchLocalOrdinal,
      extractorVersion: roomEvents.extractorVersion,
      projectionKind: roomEvents.projectionKind,
      recordId: roomEvents.recordId,
      event_crypto_object_id:
        sql<string | null>`${roomEvents.cryptoObjectId}`
          .as("event_crypto_object_id"),
      createdAt: roomEvents.createdAt,
      record_lifecycle: sql<string | null>`${reflectionRecords.lifecycle}`
        .as("record_lifecycle"),
      record_structural_height:
        sql<number | null>`${reflectionRecords.structuralHeight}`
          .as("record_structural_height"),
      record_processing_generation:
        sql<number | null>`${reflectionRecords.processingGeneration}`
          .as("record_processing_generation"),
      record_producer_policy_version:
        sql<string | null>`${reflectionRecords.producerPolicyVersion}`
          .as("record_producer_policy_version"),
      record_payload_version:
        sql<number | null>`${reflectionRecords.payloadVersion}`
          .as("record_payload_version"),
      record_disposition: sql<string | null>`${reflectionRecords.disposition}`
        .as("record_disposition"),
      record_created_at: sql<Date | null>`${reflectionRecords.createdAt}`
        .as("record_created_at"),
      ordinary_created_at: sql<Date | null>`${ordinaryRepresentation.createdAt}`.as("ordinary_created_at"),
      ordinary_head_generation:
        sql<number | null>`${ordinaryHead.currentRepresentationGeneration}`
          .as("ordinary_head_generation"),
      ordinary_representation_generation:
        sql<number | null>`${ordinaryRepresentation.representationGeneration}`
          .as("ordinary_representation_generation"),
      ordinary_representation_payload_version:
        sql<number | null>`${ordinaryRepresentation.payloadVersion}`
          .as("ordinary_representation_payload_version"),
      ordinary_representation_crypto_object_id:
        sql<string | null>`${ordinaryRepresentation.cryptoObjectId}`
          .as("ordinary_representation_crypto_object_id"),
      ordinary_publication_id:
        sql<string | null>`${ordinaryPublication.publicationId}`
          .as("ordinary_publication_id"),
      protected_head_generation:
        sql<number | null>`${protectedHead.currentRepresentationGeneration}`
          .as("protected_head_generation"),
      protected_representation_generation:
        sql<number | null>`${protectedRepresentation.representationGeneration}`
          .as("protected_representation_generation"),
      protected_representation_payload_version:
        sql<number | null>`${protectedRepresentation.payloadVersion}`
          .as("protected_representation_payload_version"),
      protected_record_crypto_object_id:
        sql<string | null>`${protectedRepresentation.cryptoObjectId}`
          .as("protected_record_crypto_object_id"),
      protected_publication_id:
        sql<string | null>`${protectedPublication.publicationId}`
          .as("protected_publication_id"),
    }).from(roomEvents)
      .leftJoin(reflectionRecords, and(
        eq(roomEvents.projectionKind, "native"),
        eq(reflectionRecords.recordId, roomEvents.recordId),
      ))
      .leftJoin(ordinaryHead, and(
        eq(ordinaryHead.recordId, roomEvents.recordId),
        eq(ordinaryHead.representation, "ordinary"),
      ))
      .leftJoin(ordinaryRepresentation, and(
        eq(ordinaryRepresentation.recordId, ordinaryHead.recordId),
        eq(ordinaryRepresentation.representation, "ordinary"),
        eq(ordinaryRepresentation.representationGeneration,
          ordinaryHead.currentRepresentationGeneration),
      ))
      .leftJoin(ordinaryPublication, and(
        eq(ordinaryPublication.recordId, ordinaryRepresentation.recordId),
        eq(ordinaryPublication.representation, "ordinary"),
        eq(ordinaryPublication.representationGeneration,
          ordinaryRepresentation.representationGeneration),
        eq(ordinaryPublication.state, "complete"),
      ))
      .leftJoin(protectedHead, and(
        eq(protectedHead.recordId, roomEvents.recordId),
        eq(protectedHead.representation, "protected"),
      ))
      .leftJoin(protectedRepresentation, and(
        eq(protectedRepresentation.recordId, protectedHead.recordId),
        eq(protectedRepresentation.representation, "protected"),
        eq(protectedRepresentation.representationGeneration,
          protectedHead.currentRepresentationGeneration),
      ))
      .leftJoin(protectedPublication, and(
        eq(protectedPublication.recordId, protectedRepresentation.recordId),
        eq(protectedPublication.representation, "protected"),
        eq(protectedPublication.representationGeneration,
          protectedRepresentation.representationGeneration),
        eq(protectedPublication.cryptoObjectId,
          protectedRepresentation.cryptoObjectId),
        eq(protectedPublication.state, "complete"),
      ))
      .where(and(
        eq(roomEvents.roomId, receipt.roomId),
        eq(roomEvents.sourceBatchId, receipt.id),
      ))
      .orderBy(asc(roomEvents.batchLocalOrdinal), asc(roomEvents.id))
      .limit(STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2 + 1));
  if (rows.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2
    || receipt.operationCount === null
    || rows.length > receipt.operationCount) {
    return integrity("Stenographer fallback output inventory is excessive");
  }
  const events = rows.map((row) => selectedEvent({row, receipt}));
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index]!;
    if (current.binding.batchLocalOrdinal >= receipt.operationCount
      || (index > 0
        && events[index - 1]!.binding.batchLocalOrdinal
          >= current.binding.batchLocalOrdinal)
      || (index > 0
        && events[index - 1]!.binding.sequence + 1
          !== current.binding.sequence)) {
      return integrity("Stenographer fallback output ordering is invalid");
    }
  }
  if (events.length === 0) {
    const expected = stenographerOrdinaryOutputFingerprint({
      kind: "extraction",
      receiptId: receipt.id,
      roomId: receipt.roomId,
      namespaceId: receipt.namespaceId,
      rebuildGeneration: receipt.rebuildGeneration,
      fallbackReason: receipt.fallbackReason,
      outputs: [],
    });
    try {
      if (!sameBytes(expected, receipt.ordinaryOutputFingerprint)) {
        return integrity("Empty Stenographer fallback fingerprint changed");
      }
    } finally {
      expected.fill(0);
    }
  }
  return Object.freeze({events: Object.freeze(events),
    outputCreatedAt: Object.freeze(rows.map(row => rowTime("Stenographer fallback ordinary payload timestamp", row["ordinary_created_at"])))});
}

/** Select one completed ordinary fallback without reading any output body. */
export async function selectPostgresStenographerFallbackInTransaction(
  input: Readonly<{
    transaction: ConversationProductPostgresTransaction;
    receipt: Readonly<{kind: "extraction" | "compaction"; id: string}>;
  }>,
): Promise<PostgresStenographerFallbackSelectionResult> {
  if (input.receipt.kind !== "extraction" && input.receipt.kind !== "compaction") {
    throw new TypeError("Stenographer fallback receipt kind is invalid");
  }
  const id = inputUuid("Stenographer fallback receipt", input.receipt.id);
  const receipt = input.receipt.kind === "extraction"
    ? await loadExtractionReceipt(input.transaction, id)
    : await loadCompactionReceipt(input.transaction, id);
  if (receipt === "missing" || receipt === "stale") {
    return Object.freeze({status: receipt});
  }
  if (await currentScope(input.transaction, receipt) === "stale") {
    receipt.ordinaryOutputFingerprint.fill(0);
    return Object.freeze({status: "stale" as const});
  }
  const {events, outputCreatedAt} = receipt.kind === "extraction"
    ? await loadExtractionEvents(input.transaction, receipt)
    : {events: Object.freeze([] as ForegroundJournalSelectedEvent[]), outputCreatedAt: Object.freeze([receipt.createdAt])};
  const resultReceipt: PostgresStenographerFallbackReceiptSelection =
    Object.freeze({
      kind: receipt.kind,
      id: receipt.id,
      roomId: receipt.roomId,
      namespaceId: receipt.namespaceId,
      rebuildGeneration: receipt.rebuildGeneration,
      fallbackReason: receipt.fallbackReason,
      ordinaryOutputFingerprint: receipt.ordinaryOutputFingerprint,
      createdAt: receipt.createdAt,
    });
  return Object.freeze({
    status: "ready" as const,
    receipt: resultReceipt,
    outputCreatedAt,
    snapshot: Object.freeze({
      roomId: receipt.roomId,
      namespaceId: receipt.namespaceId,
      rebuildGeneration: receipt.rebuildGeneration,
      rollup: receipt.rollup,
      events,
    }),
  });
}

/** Open a serializable product snapshot before selecting exact fallback metadata. */
export async function selectPostgresStenographerFallback(input: Readonly<{
  product: ConversationProductPostgresHandle;
  receipt: Readonly<{kind: "extraction" | "compaction"; id: string}>;
}>): Promise<PostgresStenographerFallbackSelectionResult> {
  assertVerifiedConversationProductPostgresHandle(input.product);
  return input.product.transaction(
    (transaction) => selectPostgresStenographerFallbackInTransaction({
      transaction,
      receipt: input.receipt,
    }),
    {isolationLevel: "serializable"},
  );
}

/** Build and codec-validate the metadata-only repair plan for one exact selection. */
export function buildStenographerOutputRepairPlan(input: Readonly<{
  selection: Extract<
    PostgresStenographerFallbackSelectionResult,
    Readonly<{status: "ready"}>
  >;
  objectIdForMissing(logicalId: string, index: number): string;
}>): StenographerOutputRepairPlan | null {
  const {selection} = input;
  if (selection.receipt.kind === "extraction"
    && selection.snapshot.events.length === 0) {
    if (selection.snapshot.rollup !== null
      || selection.receipt.roomId !== selection.snapshot.roomId
      || selection.receipt.namespaceId !== selection.snapshot.namespaceId
      || selection.receipt.rebuildGeneration
        !== selection.snapshot.rebuildGeneration) {
      return integrity("Empty Stenographer fallback scope changed");
    }
    const expected = stenographerOrdinaryOutputFingerprint({
      kind: "extraction",
      receiptId: selection.receipt.id,
      roomId: selection.receipt.roomId,
      namespaceId: selection.receipt.namespaceId,
      rebuildGeneration: selection.receipt.rebuildGeneration,
      fallbackReason: selection.receipt.fallbackReason,
      outputs: [],
    });
    try {
      if (!sameBytes(expected, selection.receipt.ordinaryOutputFingerprint)) {
        return integrity("Empty Stenographer fallback fingerprint changed");
      }
      return null;
    } finally {
      expected.fill(0);
    }
  }
  const sources = selection.receipt.kind === "extraction"
    ? selection.snapshot.events.map((event, index) => {
      if (event.payload.kind !== "reflection_record") {
        return integrity("Stenographer repair source is not a native Record");
      }
      const mapping = event.payload.protectedMapping;
      const logicalId = event.payload.recordId;
      return Object.freeze({
        logicalId,
        objectId: mapping.status === "mapped"
          ? mapping.cryptoObjectId
          : input.objectIdForMissing(logicalId, index),
        objectType: "nautilo.reflection.record.v1" as const,
        createdAt: rowCount("Stenographer repair payload timestamp", selection.outputCreatedAt[index]),
        disposition: mapping.status === "mapped" ? "existing" as const : "create" as const,
        representationGeneration: mapping.status === "mapped"
          ? mapping.representationGeneration
          : 1,
        ordinaryRepresentationGeneration:
          event.payload.ordinaryRepresentationGeneration,
      });
    })
    : (() => {
      const rollup = selection.snapshot.rollup;
      if (rollup === null) {
        return integrity("Stenographer repair compaction source is absent");
      }
      const mapping = rollup.protectedMapping;
      const logicalId = rollup.binding.rollupId;
      return [Object.freeze({
        logicalId,
        objectId: mapping.status === "mapped"
          ? mapping.cryptoObjectId
          : input.objectIdForMissing(logicalId, 0),
        objectType: "room_event_rollup" as const,
        createdAt: Date.parse(rollup.binding.createdAt),
        disposition: mapping.status === "mapped" ? "existing" as const : "create" as const,
        representationGeneration: selection.snapshot.rebuildGeneration,
        ordinaryRepresentationGeneration: null,
      })];
    })();
  const plan: StenographerOutputRepairPlan = Object.freeze({
    version: 2 as const,
    binding: Object.freeze({
      receipt: Object.freeze({
        kind: selection.receipt.kind,
        id: selection.receipt.id,
        roomId: selection.receipt.roomId,
        namespaceId: selection.receipt.namespaceId,
        rebuildGeneration: selection.receipt.rebuildGeneration,
        fallbackReason: selection.receipt.fallbackReason,
        ordinaryOutputFingerprint: Uint8Array.from(
          selection.receipt.ordinaryOutputFingerprint,
        ),
      }),
      outputs: Object.freeze(sources),
    }),
    snapshot: selection.snapshot,
  });
  const bytes = encodeStenographerOutputRepairPlan(plan);
  try {
    return decodeStenographerOutputRepairPlan(bytes);
  } finally {
    bytes.fill(0);
    plan.binding.receipt.ordinaryOutputFingerprint.fill(0);
  }
}
