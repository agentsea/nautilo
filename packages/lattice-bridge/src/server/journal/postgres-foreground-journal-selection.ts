import {
  alias,
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  roomEventRollups,
  roomEvents,
  roomJournalState,
  rooms,
  sql,
} from "@nautilo/db";

import type {
  ForegroundJournalProtectedMapping,
  ForegroundJournalSelectedEvent,
  ForegroundJournalSelectedRollup,
  ForegroundJournalSelectionPort,
} from "../../journal/foreground-journal-selection.ts";
import { PROTECTED_JOURNAL_MAX_EVENTS } from
  "../../journal/protected-journal-reader.ts";
import type { RoomEventPayloadKindV1 } from
  "../../journal/room-event-payload-v1.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
} from "../message/postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function text(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function count(label: string, value: unknown, minimum = 0): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < minimum
  ) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function time(label: string, value: unknown): string {
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (!(parsed instanceof Date) || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed.toISOString();
}

function mapping(value: unknown): ForegroundJournalProtectedMapping {
  return value === null
    ? Object.freeze({ status: "missing" as const })
    : Object.freeze({
        status: "mapped" as const,
        cryptoObjectId: text("Journal crypto object", value),
      });
}

function sourceMessageIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new TypeError("Journal source Messages are invalid");
  }
  const ids = value.map((entry) => count("Journal source Message", entry, 1));
  if (ids.length > 16) {
    throw new TypeError("Journal source Messages are invalid");
  }
  if (ids.some((entry, index) => index > 0 && ids[index - 1]! >= entry)) {
    throw new TypeError("Journal source Messages are not canonical");
  }
  return Object.freeze(ids);
}

function selectedRollup(
  row: ConversationProductDatabaseRow,
  roomId: string,
  namespaceId: string,
  rebuildGeneration: number,
): ForegroundJournalSelectedRollup {
  if (row["room_id"] !== roomId || row["namespace_id"] !== namespaceId) {
    throw new TypeError("Journal rollup escaped its Room");
  }
  return Object.freeze({
    kind: "rollup" as const,
    rebuildGeneration,
    binding: Object.freeze({
      rollupId: uuid("Journal rollup", row["rollup_id"]),
      roomId,
      namespaceId,
      throughEventSequence: count(
        "Journal rollup sequence",
        row["through_event_sequence"],
        1,
      ),
      sourceEventCount: count(
        "Journal rollup source count",
        row["source_event_count"],
        1,
      ),
      modelId: text("Journal rollup model", row["model_id"]),
      compactorVersion: text(
        "Journal rollup compactor",
        row["compactor_version"],
      ),
      createdAt: time("Journal rollup timestamp", row["created_at"]),
    }),
    protectedMapping: mapping(row["crypto_object_id"]),
  });
}

function selectedEvent(
  row: ConversationProductDatabaseRow,
  roomId: string,
  namespaceId: string,
  rebuildGeneration: number,
): ForegroundJournalSelectedEvent {
  const eventId = uuid("Journal event", row["event_id"]);
  const kind = row["kind"];
  const status = row["status"];
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind as RoomEventPayloadKindV1)) {
    throw new TypeError("Journal event kind is invalid");
  }
  if (status !== "active" && status !== "superseded" && status !== "resolved") {
    throw new TypeError("Journal event status is invalid");
  }
  const binding = Object.freeze({
    eventId,
    roomId,
    namespaceId,
    sequence: count("Journal event sequence", row["sequence"], 1),
    kind: kind as RoomEventPayloadKindV1,
    supersedesEventId: row["supersedes_event_id"] === null
      ? null
      : uuid("Journal superseded event", row["supersedes_event_id"]),
    resolvesEventId: row["resolves_event_id"] === null
      ? null
      : uuid("Journal resolved event", row["resolves_event_id"]),
    sourceMessageIds: sourceMessageIds(row["source_message_ids"]),
    sourceBatchId: uuid("Journal source batch", row["source_batch_id"]),
    batchLocalOrdinal: count(
      "Journal batch ordinal",
      row["batch_local_ordinal"],
    ),
    extractorVersion: text("Journal extractor", row["extractor_version"]),
    createdAt: time("Journal event timestamp", row["created_at"]),
  });
  const projectionKind = row["projection_kind"];
  if (projectionKind === "legacy") return Object.freeze({
    kind: "event" as const,
    rebuildGeneration,
    status,
    binding,
    payload: Object.freeze({
      kind: "legacy_event" as const,
      protectedMapping: mapping(row["event_crypto_object_id"]),
    }),
  });
  if (projectionKind !== "native" || row["record_id"] !== eventId) {
    throw new TypeError("Journal native Record projection is invalid");
  }
  const lifecycle = row["record_lifecycle"];
  if (
    lifecycle !== "current"
    && lifecycle !== "stale"
    && lifecycle !== "superseded"
    && lifecycle !== "resolved"
    && lifecycle !== "sunset"
  ) throw new TypeError("Journal Record lifecycle is invalid");
  const protectedObject = row["protected_record_crypto_object_id"];
  const protectedGeneration = row["protected_representation_generation"];
  if ((protectedObject === null) !== (protectedGeneration === null)) {
    throw new TypeError("Journal protected Record mapping is incomplete");
  }
  return Object.freeze({
    kind: "event" as const,
    rebuildGeneration,
    status,
    binding,
    payload: Object.freeze({
      kind: "reflection_record" as const,
      recordId: eventId,
      lifecycle,
      structuralHeight: count(
        "Journal Record height",
        row["record_structural_height"],
      ),
      processingGeneration: count(
        "Journal Record processing generation",
        row["record_processing_generation"],
        1,
      ),
      ordinaryRepresentationGeneration:
        row["ordinary_representation_generation"] === null
          ? null
          : count(
              "Journal ordinary Record generation",
              row["ordinary_representation_generation"],
              1,
            ),
      protectedMapping: protectedObject === null
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({
            status: "mapped" as const,
            representationGeneration: count(
              "Journal protected Record generation",
              protectedGeneration,
              1,
            ),
            cryptoObjectId: text(
              "Journal protected Record object",
              protectedObject,
            ),
          }),
    }),
  });
}

/** Select current Journal coordinates without projecting confidential bytes. */
export function createPostgresForegroundJournalSelectionPort(input: Readonly<{
  product: ConversationProductPostgresHandle;
}>): ForegroundJournalSelectionPort {
  assertVerifiedConversationProductPostgresHandle(input.product);
  const ordinaryHead = alias(
    reflectionRecordPayloadRepresentationHeads,
    "foreground_journal_ordinary_head",
  );
  const protectedHead = alias(
    reflectionRecordPayloadRepresentationHeads,
    "foreground_journal_protected_head",
  );
  const protectedRepresentation = alias(
    reflectionRecordPayloadRepresentations,
    "foreground_journal_protected_representation",
  );
  return Object.freeze({
    selectCurrent: async (
      request: Parameters<ForegroundJournalSelectionPort["selectCurrent"]>[0],
    ) => {
      const roomId = uuid("Journal Room", request.roomId);
      const namespaceId = uuid("Journal Namespace", request.namespaceId);
      const maximumEvents = count("Journal event bound", request.maximumEvents);
      if (maximumEvents > PROTECTED_JOURNAL_MAX_EVENTS) {
        throw new RangeError("Journal event bound is excessive");
      }
      return input.product.transaction(async (tx) => {
        const states = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            namespaceId: rooms.namespaceId,
            rebuildGeneration: roomJournalState.rebuildGeneration,
          }).from(roomJournalState)
            .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
            .where(and(
              eq(roomJournalState.roomId, roomId),
              eq(rooms.namespaceId, namespaceId),
              isNull(roomJournalState.rebuildRequestedAt),
            )).limit(2));
        if (states.length === 0) return null;
        if (states.length !== 1 || states[0]!.namespace_id !== namespaceId) {
          throw new TypeError("Journal state is invalid");
        }
        const rebuildGeneration = count(
          "Journal rebuild generation",
          states[0]!.rebuild_generation,
        );
        const rollups = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            rollup_id: sql<string>`${roomEventRollups.id}`.as("rollup_id"),
            cryptoObjectId: roomEventRollups.cryptoObjectId,
            roomId: roomEventRollups.roomId,
            namespaceId: rooms.namespaceId,
            throughEventSequence: roomEventRollups.throughEventSequence,
            sourceEventCount: roomEventRollups.sourceEventCount,
            modelId: roomEventRollups.modelId,
            compactorVersion: roomEventRollups.compactorVersion,
            createdAt: roomEventRollups.createdAt,
          }).from(roomEventRollups)
            .innerJoin(rooms, eq(rooms.id, roomEventRollups.roomId))
            .where(eq(roomEventRollups.roomId, roomId))
            .orderBy(
              desc(roomEventRollups.throughEventSequence),
              desc(roomEventRollups.createdAt),
              asc(roomEventRollups.id),
            ).limit(1));
        const rollup = rollups[0] === undefined
          ? null
          : selectedRollup(
              rollups[0],
              roomId,
              namespaceId,
              rebuildGeneration,
            );
        const through = rollup?.binding.throughEventSequence ?? 0;
        const rows = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            event_id: sql<string>`${roomEvents.id}`.as("event_id"),
            event_crypto_object_id:
              sql<string | null>`${roomEvents.cryptoObjectId}`
              .as("event_crypto_object_id"),
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
            record_lifecycle: sql<string | null>`${reflectionRecords.lifecycle}`
              .as("record_lifecycle"),
            record_structural_height:
              sql<number | null>`${reflectionRecords.structuralHeight}`
                .as("record_structural_height"),
            record_processing_generation:
              sql<number | null>`${reflectionRecords.processingGeneration}`
                .as("record_processing_generation"),
            ordinary_representation_generation:
              sql<number | null>`${ordinaryHead.currentRepresentationGeneration}`
                .as("ordinary_representation_generation"),
            protected_representation_generation:
              sql<number | null>`${protectedHead.currentRepresentationGeneration}`
                .as("protected_representation_generation"),
            protected_record_crypto_object_id:
              sql<string | null>`${protectedRepresentation.cryptoObjectId}`
                .as("protected_record_crypto_object_id"),
            createdAt: roomEvents.createdAt,
          }).from(roomEvents)
            .leftJoin(reflectionRecords, and(
              eq(roomEvents.projectionKind, "native"),
              eq(reflectionRecords.recordId, roomEvents.recordId),
            ))
            .leftJoin(ordinaryHead, and(
              eq(roomEvents.projectionKind, "native"),
              eq(ordinaryHead.recordId, roomEvents.recordId),
              eq(ordinaryHead.representation, "ordinary"),
            ))
            .leftJoin(protectedHead, and(
              eq(roomEvents.projectionKind, "native"),
              eq(protectedHead.recordId, roomEvents.recordId),
              eq(protectedHead.representation, "protected"),
            ))
            .leftJoin(protectedRepresentation, and(
              eq(protectedRepresentation.recordId, protectedHead.recordId),
              eq(protectedRepresentation.representation, "protected"),
              eq(
                protectedRepresentation.representationGeneration,
                protectedHead.currentRepresentationGeneration,
              ),
            ))
            .where(and(
              eq(roomEvents.roomId, roomId),
              eq(roomEvents.status, "active"),
              gt(roomEvents.sequence, through),
            ))
            .orderBy(asc(roomEvents.sequence), asc(roomEvents.id))
            .limit(maximumEvents));
        const events = rows.map((row) => selectedEvent(
          row,
          roomId,
          namespaceId,
          rebuildGeneration,
        ));
        return Object.freeze({
          roomId,
          namespaceId,
          rebuildGeneration,
          rollup,
          events: Object.freeze(events),
        });
      }, { isolationLevel: "serializable" });
    },
  });
}
