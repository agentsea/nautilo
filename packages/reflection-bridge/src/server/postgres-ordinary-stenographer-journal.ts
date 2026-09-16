import type { RoomEventKind } from "@nautilo/reflection";
import {
  and,
  asc,
  eq,
  gt,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  roomEvents,
  rooms,
  sql,
} from "@nautilo/db";

import { decodeDurableRecordEnvelope } from "./record-mapping";
import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";
import { assertStenographerRecordPayloadBinding } from "./stenographer-record-publication";

export interface OrdinaryStenographerJournalEventView {
  readonly id: string;
  readonly roomId: string;
  readonly sequence: number;
  readonly kind: RoomEventKind;
  readonly statement: string;
  readonly status: "active" | "superseded" | "resolved";
  readonly supersedesEventId: string | null;
  readonly resolvesEventId: string | null;
}

export interface OrdinaryStenographerJournalRead {
  readonly roomId: string;
  readonly activeOnly?: boolean;
  readonly afterSequence?: number;
}

function stringValue(row: RecordProductPostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Invalid Journal event row");
  return value;
}

function nullableString(
  row: RecordProductPostgresRow,
  key: string,
): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new TypeError("Invalid Journal event link");
  }
  return value;
}

function integerValue(row: RecordProductPostgresRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Journal event sequence");
  }
  return value;
}

function integerArrayValue(
  row: RecordProductPostgresRow,
  key: string,
): readonly number[] {
  const raw = row[key];
  if (!Array.isArray(raw)) throw new TypeError("Invalid Journal event sources");
  return (raw as unknown[]).map((value) => {
    const normalized = typeof value === "bigint" ? Number(value) : value;
    if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)) {
      throw new TypeError("Invalid Journal event source");
    }
    return normalized;
  });
}

/**
 * One ordinary mixed Journal reader. Legacy bodies and native Record payloads
 * are resolved here so Runtime never grows a second Record codec.
 */
export async function readOrdinaryStenographerJournalEvents(
  executor: RecordProductPostgresExecutor,
  input: OrdinaryStenographerJournalRead,
): Promise<readonly OrdinaryStenographerJournalEventView[]> {
  const rows = await executeTypedRecordProductQuery(executor,
    recordProductTypedDb.select({
      id: roomEvents.id,
      room_id: roomEvents.roomId,
      sequence: roomEvents.sequence,
      kind: roomEvents.kind,
      statement: roomEvents.statement,
      status: roomEvents.status,
      supersedes_event_id: roomEvents.supersedesEventId,
      resolves_event_id: roomEvents.resolvesEventId,
      source_message_ids: roomEvents.sourceMessageIds,
      extractor_version: roomEvents.extractorVersion,
      projection_kind: roomEvents.projectionKind,
      record_id: roomEvents.recordId,
      namespace_id: rooms.namespaceId,
      record_lifecycle: sql`${reflectionRecords.lifecycle}`
        .as("record_lifecycle"),
      structural_height: reflectionRecords.structuralHeight,
      processing_generation: reflectionRecords.processingGeneration,
      plaintext_payload_bytes:
        reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
    })
      .from(roomEvents)
      .innerJoin(rooms, eq(rooms.id, roomEvents.roomId))
      .leftJoin(reflectionRecords, and(
        eq(roomEvents.projectionKind, "native"),
        eq(reflectionRecords.recordId, roomEvents.recordId),
      ))
      .leftJoin(reflectionRecordPayloadRepresentationHeads, and(
        eq(roomEvents.projectionKind, "native"),
        eq(reflectionRecordPayloadRepresentationHeads.recordId, roomEvents.recordId),
        eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
      ))
      .leftJoin(reflectionRecordPayloadRepresentations, and(
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
      ))
      .where(and(
        eq(roomEvents.roomId, input.roomId),
        input.activeOnly === true ? eq(roomEvents.status, "active") : undefined,
        gt(roomEvents.sequence, input.afterSequence ?? 0),
      ))
      .orderBy(asc(roomEvents.sequence)));
  return rows.map((row) => {
    const id = stringValue(row, "id");
    const projectionKind = stringValue(row, "projection_kind");
    let statement: string;
    if (projectionKind === "legacy") {
      statement = stringValue(row, "statement");
    } else if (projectionKind === "native") {
      const recordId = stringValue(row, "record_id");
      const bytes = row["plaintext_payload_bytes"];
      if (recordId !== id || !(bytes instanceof Uint8Array)) {
        throw new Error("Native ordinary Journal representation is unavailable");
      }
      const record = decodeDurableRecordEnvelope({
        recordRef: recordId,
        lifecycle: stringValue(row, "record_lifecycle") as
          | "current"
          | "stale"
          | "superseded"
          | "resolved"
          | "sunset",
        structuralHeight: integerValue(row, "structural_height"),
        processingGeneration: integerValue(row, "processing_generation"),
        payloadBytes: bytes,
      });
      if (record.recordRef !== id) {
        throw new Error("Native ordinary Journal identity is inconsistent");
      }
      assertStenographerRecordPayloadBinding(record, {
        eventId: id,
        roomId: stringValue(row, "room_id"),
        namespaceId: stringValue(row, "namespace_id"),
        kind: stringValue(row, "kind") as RoomEventKind,
        status: stringValue(row, "status") as
          | "active"
          | "superseded"
          | "resolved",
        sourceMessageIds: integerArrayValue(row, "source_message_ids"),
        extractorVersion: stringValue(row, "extractor_version"),
      });
      statement = record.semantic.statement;
    } else {
      throw new TypeError("Invalid Journal projection kind");
    }
    return {
      id,
      roomId: stringValue(row, "room_id"),
      sequence: integerValue(row, "sequence"),
      kind: stringValue(row, "kind") as RoomEventKind,
      statement,
      status: stringValue(row, "status") as OrdinaryStenographerJournalEventView["status"],
      supersedesEventId: nullableString(row, "supersedes_event_id"),
      resolvesEventId: nullableString(row, "resolves_event_id"),
    };
  });
}

export async function readOrdinaryStenographerJournalEventsWithHandle(
  handle: RecordProductPostgresHandle,
  input: OrdinaryStenographerJournalRead,
): Promise<readonly OrdinaryStenographerJournalEventView[]> {
  assertVerifiedRecordProductPostgresHandle(handle);
  return readOrdinaryStenographerJournalEvents(handle, input);
}
/** Trusted SQL fragments owned with the mixed-representation decoder. */
export const ORDINARY_STENOGRAPHER_STATEMENT_PROJECTION_SQL = `CASE
  WHEN event.projection_kind = 'legacy' THEN event.statement
  ELSE convert_from(payload.plaintext_payload_bytes, 'UTF8')::jsonb->>'statement'
END`;

export const ORDINARY_STENOGRAPHER_RECORD_JOIN_SQL = `
LEFT JOIN reflection_record_payload_representation_heads head
  ON event.projection_kind = 'native'
 AND head.record_id = event.record_id
 AND head.representation = 'ordinary'
LEFT JOIN reflection_record_payload_representations payload
  ON payload.record_id = head.record_id
 AND payload.representation = head.representation
 AND payload.representation_generation = head.current_representation_generation`;
