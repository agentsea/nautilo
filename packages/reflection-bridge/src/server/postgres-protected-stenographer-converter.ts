import {
  assertRoomEventPayloadBindingV1,
  decodeRoomEventPayloadV1,
  type RoomEventPayloadBindingV1,
} from "@nautilo/lattice-bridge";
import type { DurableRecordPublication } from "@nautilo/reflection/durable";
import {
  and,
  eq,
  roomEvents,
  roomJournalRecordCutover,
  roomJournalState,
  sql,
} from "@nautilo/db";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { RecordRepositorySelection } from "./contracts";
import { encodeDurableRecordEnvelope } from "./record-mapping";
import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";
import {
  buildStenographerRecordPublication,
  type StenographerMessageBinding,
} from "./stenographer-record-publication";

export const PROTECTED_STENOGRAPHER_CONVERSION_LEASE_MS = 2 * 60_000;

export interface ProtectedLegacyStenographerConversionClaim {
  readonly leaseToken: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly conversionFailureCount: number;
  readonly legacyObjectId: string;
  readonly binding: RoomEventPayloadBindingV1;
  readonly status: "active" | "superseded" | "resolved";
  readonly sources: readonly StenographerMessageBinding[];
  readonly publicationBindingRef: string;
}

export interface ProtectedLegacyStenographerAuthorityPort {
  /**
   * Execute under current Wave-10 processor authority. The implementation
   * opens only `legacyObjectId`, invokes `transform` inside that plaintext
   * scope, publishes the returned protected Record through the canonical
   * Record repository, and verifies it can be reopened before returning.
   */
  publishConvertedRecord(input: Readonly<{
    legacyObjectId: string;
    recordId: string;
    transform: (legacyPayloadBytes: Uint8Array) => Readonly<{
      publication: DurableRecordPublication;
      canonicalRecordPayloadBytes: Uint8Array;
    }>;
  }>): Promise<Readonly<{
    status: "published" | "authorization_unavailable" | "conflict";
  }>>;
}

export type ProtectedLegacyStenographerConversionResult = Readonly<{
  roomId: string | null;
  converted: number;
  pendingAuthority: boolean;
}>;

const encoder = new TextEncoder();

function text(row: RecordProductPostgresRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Protected Stenographer conversion metadata is invalid");
  }
  return value;
}

function counter(
  row: RecordProductPostgresRow,
  field: string,
  minimum = 0,
): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new TypeError("Protected Stenographer conversion counter is invalid");
  }
  return value;
}

function nullableText(
  row: RecordProductPostgresRow,
  field: string,
): string | null {
  const value = row[field];
  return value === null ? null : text(row, field);
}

function sourceIds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Protected Stenographer sources are invalid");
  }
  const ids = value.map((item: unknown) => {
    const id = typeof item === "bigint" ? Number(item) : item;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new TypeError("Protected Stenographer source is invalid");
    }
    return id;
  });
  if (
    ids.length === 0
    || ids.length > 16
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
  ) {
    throw new TypeError("Protected Stenographer source inventory is invalid");
  }
  return Object.freeze(ids);
}

function bindingFingerprint(row: RecordProductPostgresRow): string {
  const canonical = JSON.stringify([
    "nautilo/stenographer/protected-message-binding/v1",
    counter(row, "id", 1),
    counter(row, "edit_revision"),
    nullableText(row, "fingerprint"),
    text(row, "crypto_object_id"),
  ]);
  return `sha256:${bytesToHex(sha256(encoder.encode(canonical)))}`;
}

function timestamp(row: RecordProductPostgresRow): string {
  const value = row["created_at"];
  const date = value instanceof Date ? value : new Date(text(row, "created_at"));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Protected Stenographer timestamp is invalid");
  }
  return date.toISOString();
}

function transition(row: RecordProductPostgresRow):
  | Readonly<{ operation: "append" }>
  | Readonly<{
      operation: "supersede" | "resolve";
      predecessorEventId: string;
    }> {
  const supersedes = nullableText(row, "supersedes_event_id");
  const resolves = nullableText(row, "resolves_event_id");
  if (supersedes !== null && resolves !== null) {
    throw new TypeError("Protected Stenographer transition is invalid");
  }
  if (supersedes !== null) {
    return { operation: "supersede", predecessorEventId: supersedes };
  }
  if (resolves !== null) {
    return { operation: "resolve", predecessorEventId: resolves };
  }
  return { operation: "append" };
}

function retryAt(now: Date, failureCount: number): Date {
  const seconds = Math.min(60 * 60, 15 * 2 ** Math.min(failureCount, 8));
  return new Date(now.getTime() + seconds * 1_000);
}

/**
 * Dormant protected conversion composition. It deliberately accepts only an
 * authority capability, never a key, plaintext reader, or ordinary fallback.
 */
export class PostgresProtectedLegacyStenographerConverter {
  constructor(private readonly options: Readonly<{
    handle: RecordProductPostgresHandle;
    authority: ProtectedLegacyStenographerAuthorityPort;
    selection: RecordRepositorySelection;
    leaseToken: () => string;
  }>) {
    assertVerifiedRecordProductPostgresHandle(options.handle);
    if (
      options.selection.selectedRepresentation !== "protected"
      || !Number.isSafeInteger(options.selection.migrationGeneration)
      || options.selection.migrationGeneration < 1
    ) {
      throw new TypeError(
        "Protected Stenographer conversion requires protected selection",
      );
    }
  }

  async convertNextLegacyEvent(
    input: Readonly<{ now?: Date }> = {},
  ): Promise<ProtectedLegacyStenographerConversionResult> {
    const now = input.now ?? new Date();
    const claim = await this.#claim(now);
    if (claim === null) {
      return { roomId: null, converted: 0, pendingAuthority: false };
    }
    const result = await this.options.authority.publishConvertedRecord({
      legacyObjectId: claim.legacyObjectId,
      recordId: claim.binding.eventId,
      transform: (legacyPayloadBytes) => {
        const payload = decodeRoomEventPayloadV1(legacyPayloadBytes);
        assertRoomEventPayloadBindingV1(payload, claim.binding);
        const publication = buildStenographerRecordPublication({
          eventId: claim.binding.eventId,
          roomId: claim.roomId,
          namespaceId: claim.namespaceId,
          kind: claim.binding.kind,
          statement: payload.statement,
          sources: claim.sources,
          sourceBatchId: claim.binding.sourceBatchId,
          batchLocalOrdinal: claim.binding.batchLocalOrdinal,
          extractorVersion: claim.binding.extractorVersion,
          rebuildGeneration: claim.rebuildGeneration,
          transition: transition({
            supersedes_event_id: claim.binding.supersedesEventId,
            resolves_event_id: claim.binding.resolvesEventId,
          }),
          publicationBindingRef: claim.publicationBindingRef,
        });
        return {
          publication,
          canonicalRecordPayloadBytes:
            encodeDurableRecordEnvelope(publication.record),
        };
      },
    });
    if (result.status !== "published") {
      await this.#releaseFailure(
        claim,
        now,
        result.status === "authorization_unavailable"
          ? "authorization_unavailable"
          : "publication_ambiguous",
      );
      return {
        roomId: claim.roomId,
        converted: 0,
        pendingAuthority: result.status === "authorization_unavailable",
      };
    }
    await this.#attach(claim, now);
    return { roomId: claim.roomId, converted: 1, pendingAuthority: false };
  }

  async #claim(
    now: Date,
  ): Promise<ProtectedLegacyStenographerConversionClaim | null> {
    return this.options.handle.transaction(async (tx) => {
      await tx.query(
        "SELECT set_config('nautilo.stenographer_writer_version', '2', true)",
      );
      const rooms = await tx.query(
        `SELECT state.room_id::text AS room_id,
                state.rebuild_generation,
                state.record_conversion_failure_count,
                room.namespace_id::text AS namespace_id
           FROM room_journal_state AS state
           JOIN rooms AS room ON room.id = state.room_id
          WHERE state.record_conversion_status = 'pending'
            AND (state.record_conversion_retry_after IS NULL
              OR state.record_conversion_retry_after <= $1)
            AND (state.record_conversion_lease_expires_at IS NULL
              OR state.record_conversion_lease_expires_at <= $1)
            AND EXISTS (
              SELECT 1 FROM room_events AS event
               WHERE event.room_id = state.room_id
                 AND event.projection_kind = 'legacy'
                 AND event.crypto_object_id IS NOT NULL
            )
          ORDER BY state.updated_at, state.room_id
          LIMIT 1
          FOR UPDATE OF state SKIP LOCKED`,
        [now],
      );
      if (rooms[0] === undefined) return null;
      const roomId = text(rooms[0], "room_id");
      const events = await tx.query(
        `SELECT event.id::text AS event_id, event.crypto_object_id,
                event.sequence, event.kind, event.status,
                event.supersedes_event_id::text AS supersedes_event_id,
                event.resolves_event_id::text AS resolves_event_id,
                event.source_message_ids,
                event.source_batch_id::text AS source_batch_id,
                event.batch_local_ordinal, event.extractor_version,
                event.created_at,
                predecessor.projection_kind AS predecessor_projection_kind
           FROM room_events AS event
           LEFT JOIN room_events AS predecessor
             ON predecessor.id = COALESCE(
               event.supersedes_event_id,
               event.resolves_event_id
             )
          WHERE event.room_id = $1
            AND event.projection_kind = 'legacy'
            AND event.crypto_object_id IS NOT NULL
          ORDER BY event.sequence, event.id
          LIMIT 1
          FOR UPDATE OF event`,
        [roomId],
      );
      const event = events[0];
      if (event === undefined) return null;
      if (event["predecessor_projection_kind"] === "legacy") {
        throw new Error("Protected Stenographer predecessor is not native");
      }
      const ids = sourceIds(event["source_message_ids"]);
      const sourceRows = await tx.query(
        `SELECT message.id, message.edit_revision, message.fingerprint,
                revision.crypto_object_id
           FROM sessions AS session
           JOIN session_messages AS message ON message.session_id = session.id
           JOIN session_message_crypto_revisions AS revision
             ON revision.session_id = session.id
            AND revision.message_id = message.id
            AND revision.edit_revision = message.edit_revision
            AND revision.completion = 'complete'
          WHERE session.room_id = $1
            AND message.id = ANY($2::integer[])
          ORDER BY message.id
          FOR SHARE OF message`,
        [roomId, ids],
      );
      if (sourceRows.length !== ids.length) {
        throw new Error("Protected Stenographer source is unavailable");
      }
      const status = text(event, "status");
      if (
        status !== "active"
        && status !== "superseded"
        && status !== "resolved"
      ) throw new TypeError("Protected Stenographer status is invalid");
      const leaseToken = this.options.leaseToken();
      const leased = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(roomJournalState)
          .set({
            recordConversionLeaseToken: leaseToken,
            recordConversionLeaseExpiresAt: new Date(
              now.getTime() + PROTECTED_STENOGRAPHER_CONVERSION_LEASE_MS,
            ),
            updatedAt: now,
          })
          .where(and(
            eq(roomJournalState.roomId, roomId),
            eq(roomJournalState.recordConversionStatus, "pending"),
          ))
          .returning({ room_id: roomJournalState.roomId }));
      if (leased.length !== 1) return null;
      const binding: RoomEventPayloadBindingV1 = Object.freeze({
        eventId: text(event, "event_id"),
        roomId,
        namespaceId: text(rooms[0], "namespace_id"),
        sequence: counter(event, "sequence", 1),
        kind: text(event, "kind") as RoomEventPayloadBindingV1["kind"],
        supersedesEventId: nullableText(event, "supersedes_event_id"),
        resolvesEventId: nullableText(event, "resolves_event_id"),
        sourceMessageIds: ids,
        sourceBatchId: text(event, "source_batch_id"),
        batchLocalOrdinal: counter(event, "batch_local_ordinal"),
        extractorVersion: text(event, "extractor_version"),
        createdAt: timestamp(event),
      });
      return Object.freeze({
        leaseToken,
        roomId,
        namespaceId: binding.namespaceId,
        rebuildGeneration: counter(rooms[0], "rebuild_generation"),
        conversionFailureCount: counter(
          rooms[0],
          "record_conversion_failure_count",
        ),
        legacyObjectId: text(event, "crypto_object_id"),
        binding,
        status,
        sources: Object.freeze(sourceRows.map((row) => Object.freeze({
          messageId: counter(row, "id", 1),
          editRevision: counter(row, "edit_revision"),
          observedContentFingerprint: bindingFingerprint(row),
        }))),
        publicationBindingRef:
          `journal:namespace:${binding.namespaceId}:protected:v${this.options.selection.migrationGeneration}`,
      });
    }, { isolationLevel: "serializable" });
  }

  async #attach(
    claim: ProtectedLegacyStenographerConversionClaim,
    now: Date,
  ): Promise<void> {
    await this.options.handle.transaction(async (tx) => {
      await tx.query(
        "SELECT set_config('nautilo.stenographer_writer_version', '2', true)",
      );
      const verified = await tx.query(
        `SELECT record.record_id
           FROM reflection_records AS record
           JOIN reflection_record_payload_representation_heads AS head
             ON head.record_id = record.record_id
            AND head.representation = 'protected'
           JOIN reflection_record_payload_representations AS representation
             ON representation.record_id = head.record_id
            AND representation.representation = head.representation
            AND representation.representation_generation =
                  head.current_representation_generation
           JOIN reflection_record_publications AS publication
             ON publication.record_id = record.record_id
            AND publication.representation = 'protected'
            AND publication.representation_generation =
                  head.current_representation_generation
            AND publication.state = 'complete'
          WHERE record.record_id = $1
            AND record.disposition = 'available'
            AND representation.crypto_object_id IS NOT NULL
          FOR SHARE OF record`,
        [claim.binding.eventId],
      );
      if (verified.length !== 1) {
        throw new Error("Protected Stenographer Record is not durable");
      }
      const attached = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(roomEvents)
          .set({
            projectionKind: "native",
            recordId: sql`${roomEvents.id}::text`,
            cryptoObjectId: null,
            statement: null,
            nativeAttachedAt: now,
          })
          .where(and(
            eq(roomEvents.id, claim.binding.eventId),
            eq(roomEvents.roomId, claim.roomId),
            eq(roomEvents.projectionKind, "legacy"),
            eq(roomEvents.cryptoObjectId, claim.legacyObjectId),
            sql`EXISTS (
              SELECT 1 FROM ${roomJournalState} AS state
               WHERE state.room_id = ${roomEvents.roomId}
                 AND state.rebuild_generation = ${claim.rebuildGeneration}
                 AND state.record_conversion_lease_token = ${claim.leaseToken}
            )`,
          ))
          .returning({ id: roomEvents.id }));
      if (attached.length !== 1) {
        throw new Error("Protected Stenographer projection attach conflicted");
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(roomJournalRecordCutover)
        .values({
          singletonKey: 1,
          cutoverVersion: 1,
          firstNativeRecordId: claim.binding.eventId,
          activatedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing({ target: roomJournalRecordCutover.singletonKey }));
      const progress = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(roomJournalState)
          .set({
            recordConversionStatus: sql`CASE WHEN EXISTS (
              SELECT 1 FROM ${roomEvents} AS event
               WHERE event.room_id = ${roomJournalState.roomId}
                 AND event.projection_kind = 'legacy'
            ) THEN 'pending' ELSE 'completed' END`,
            recordConversionCursorSequence:
              sql`GREATEST(${roomJournalState.recordConversionCursorSequence}, ${claim.binding.sequence})`,
            recordConversionFailureCount: 0,
            recordConversionRetryAfter: null,
            recordConversionLastErrorCode: null,
            recordConversionLeaseToken: null,
            recordConversionLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(roomJournalState.roomId, claim.roomId),
            eq(roomJournalState.rebuildGeneration, claim.rebuildGeneration),
            eq(roomJournalState.recordConversionLeaseToken, claim.leaseToken),
          ))
          .returning({ room_id: roomJournalState.roomId }));
      if (progress.length !== 1) {
        throw new Error("Protected Stenographer conversion lease was lost");
      }
    }, { isolationLevel: "serializable" });
  }

  async #releaseFailure(
    claim: ProtectedLegacyStenographerConversionClaim,
    now: Date,
    code: "authorization_unavailable" | "publication_ambiguous",
  ): Promise<void> {
    await executeTypedRecordProductQuery(this.options.handle, recordProductTypedDb
      .update(roomJournalState)
      .set({
        recordConversionFailureCount:
          sql`${roomJournalState.recordConversionFailureCount} + 1`,
        recordConversionRetryAfter: retryAt(now, claim.conversionFailureCount + 1),
        recordConversionLastErrorCode: code,
        recordConversionLeaseToken: null,
        recordConversionLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(roomJournalState.roomId, claim.roomId),
        eq(roomJournalState.rebuildGeneration, claim.rebuildGeneration),
        eq(roomJournalState.recordConversionLeaseToken, claim.leaseToken),
      )));
  }
}
