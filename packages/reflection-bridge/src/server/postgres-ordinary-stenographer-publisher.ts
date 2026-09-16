import type { RoomEventKind } from "@nautilo/reflection";
import { stenographerOrdinaryOutputFingerprint } from "@nautilo/lattice-bridge";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  roomEvents,
  roomJournalBatches,
  roomJournalRecordCutover,
  roomJournalState,
  sql,
} from "@nautilo/db";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  RecordRepositorySelection,
  RecordRequestCommitmentPort,
} from "./contracts";
import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";
import { encodeDurableRecordEnvelope } from "./record-mapping";
import { PostgresRecordProductStore } from "./postgres-record-product-store";
import type { RecordSemanticPublicationPort } from "./postgres-semantic-work-store";
import {
  buildStenographerRecordPublication,
  type StenographerMessageBinding,
} from "./stenographer-record-publication";

export interface OrdinaryStenographerExtractionClaimV2 {
  readonly batchId: string;
  readonly roomId: string;
  readonly leaseToken: string;
  readonly lane: "live" | "historical";
  readonly fromMessageIdExclusive: number;
  readonly throughMessageIdInclusive: number;
  readonly rebuildGeneration: number | null;
}

export interface OrdinaryStenographerStatusUpdateV2 {
  readonly eventId: string;
  readonly fromStatus: "active";
  readonly toStatus: "superseded" | "resolved";
}

export interface OrdinaryStenographerEventInsertV2 {
  readonly batchLocalOrdinal: number;
  readonly sequence: number;
  readonly kind: RoomEventKind;
  readonly statement: string;
  readonly sourceMessageIds: readonly number[];
  readonly status: "active";
  readonly supersedesEventId: string | null;
  readonly resolvesEventId: string | null;
}

export interface OrdinaryStenographerTransitionPlanV2 {
  readonly statusUpdates: readonly OrdinaryStenographerStatusUpdateV2[];
  readonly inserts: readonly OrdinaryStenographerEventInsertV2[];
  readonly foldedBatchLocalOrdinals: readonly number[];
  readonly nextSequence: number;
}

export interface OrdinaryStenographerExtractionPublicationV2 {
  readonly claim: OrdinaryStenographerExtractionClaimV2;
  readonly transition: OrdinaryStenographerTransitionPlanV2;
  readonly operationCount: number;
  readonly modelId: string | null;
  readonly extractorVersion: string;
  readonly now: Date;
  readonly ordinaryFallbackReason?: "device" | "authority";
}

export type OrdinaryStenographerExtractionPublicationResultV2 = Readonly<{
  published: boolean;
  eventsWritten: number;
}>;

export type OrdinaryStenographerConversionPageResultV2 = Readonly<{
  roomId: string | null;
  converted: number;
  completedRoom: boolean;
}>;

const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_FAILURE = "40P01";
const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_LEGACY_PREDECESSOR_CHAIN = 50;
const encoder = new TextEncoder();

function rowString(row: RecordProductPostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Invalid Stenographer row");
  return value;
}

function rowInteger(row: RecordProductPostgresRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Stenographer counter");
  }
  return value;
}

function rowBytes(row: RecordProductPostgresRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Invalid Stenographer bytes");
  }
  return value;
}

function rowTimestamp(row: RecordProductPostgresRow, key: string): Date {
  const raw = row[key];
  const value = raw instanceof Date
    ? raw
    : typeof raw === "string" ? new Date(raw) : null;
  if (value === null || !Number.isFinite(value.getTime())) {
    throw new TypeError("Invalid Stenographer timestamp");
  }
  return value;
}

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === SERIALIZATION_FAILURE || error.code === DEADLOCK_FAILURE);
}

function messageFingerprint(row: RecordProductPostgresRow): string {
  const canonical = JSON.stringify([
    "nautilo/stenographer/message-observation/v1",
    rowInteger(row, "id"),
    rowInteger(row, "edit_revision"),
    rowString(row, "content"),
  ]);
  return `sha256:${bytesToHex(sha256(encoder.encode(canonical)))}`;
}

function transitionForInsert(
  insert: OrdinaryStenographerEventInsertV2,
):
  | Readonly<{ operation: "append" }>
  | Readonly<{
      operation: "supersede" | "resolve";
      predecessorEventId: string;
    }> {
  if (insert.supersedesEventId !== null) {
    return {
      operation: "supersede",
      predecessorEventId: insert.supersedesEventId,
    };
  }
  if (insert.resolvesEventId !== null) {
    return {
      operation: "resolve",
      predecessorEventId: insert.resolvesEventId,
    };
  }
  return { operation: "append" };
}

/**
 * Ordinary production cutover transaction. Runtime supplies its already-pure
 * transition plan; this bridge revalidates current product state and commits
 * Records, projection, batch, cursor, and first-write fence atomically.
 */
export class PostgresOrdinaryStenographerRecordPublisher {
  readonly #product: PostgresRecordProductStore;

  constructor(
    private readonly options: Readonly<{
      handle: RecordProductPostgresHandle;
      commitment: RecordRequestCommitmentPort;
      selection: RecordRepositorySelection;
      semanticWork?: RecordSemanticPublicationPort;
    }>,
  ) {
    assertVerifiedRecordProductPostgresHandle(options.handle);
    if (
      options.selection.selectedRepresentation !== "ordinary"
      || !Number.isSafeInteger(options.selection.migrationGeneration)
      || options.selection.migrationGeneration < 1
    ) {
      throw new TypeError("Ordinary Stenographer publisher requires canonical ordinary selection");
    }
    this.#product = new PostgresRecordProductStore(options.handle, options.semanticWork);
  }

  async publishExtraction(
    input: OrdinaryStenographerExtractionPublicationV2,
  ): Promise<OrdinaryStenographerExtractionPublicationResultV2> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.handle.transaction(
          (tx) => this.#publishExtraction(tx, input),
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable Stenographer transaction state");
  }

  /** Convert at most one deterministic legacy Room page without a model call. */
  async convertNextLegacyPage(
    input: Readonly<{ limit?: number; now?: Date }> = {},
  ): Promise<OrdinaryStenographerConversionPageResultV2> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Stenographer conversion page limit is invalid");
    }
    const now = input.now ?? new Date();
    let failedRoomId: string | null = null;
    let failedRoomFailureCount = 0;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.handle.transaction(async (tx) => {
          await tx.query(
            "SELECT set_config('nautilo.stenographer_writer_version', '2', true)",
          );
          const candidates = await tx.query(
            `SELECT state.room_id::text AS room_id,
                    state.rebuild_generation,
                    state.record_conversion_failure_count,
                    room.namespace_id::text AS namespace_id
               FROM room_journal_state state
               JOIN rooms room ON room.id = state.room_id
              WHERE state.record_conversion_status = 'pending'
                AND (state.record_conversion_retry_after IS NULL
                  OR state.record_conversion_retry_after <= $1)
                AND (state.record_conversion_lease_expires_at IS NULL
                  OR state.record_conversion_lease_expires_at <= $1)
                AND EXISTS (
                  SELECT 1 FROM room_events event
                   WHERE event.room_id = state.room_id
                     AND event.projection_kind = 'legacy'
                     AND event.crypto_object_id IS NULL
                )
              ORDER BY state.updated_at, state.room_id
              LIMIT 1
              FOR UPDATE OF state SKIP LOCKED`,
            [now],
          );
          const candidate = candidates[0];
          if (candidate === undefined) {
            return { roomId: null, converted: 0, completedRoom: false };
          }
          const roomId = rowString(candidate, "room_id");
          failedRoomId = roomId;
          failedRoomFailureCount = rowInteger(
            candidate,
            "record_conversion_failure_count",
          );
          await tx.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [roomId]);
          const page = await tx.query(
            `SELECT id::text AS id
               FROM room_events
              WHERE room_id = $1
                AND projection_kind = 'legacy'
                AND crypto_object_id IS NULL
              ORDER BY sequence, id
              LIMIT $2
              FOR UPDATE`,
            [roomId, limit],
          );
          for (const event of page) {
            await this.#ensureLegacyPredecessorNative(tx, {
              eventId: rowString(event, "id"),
              roomId,
              namespaceId: rowString(candidate, "namespace_id"),
              rebuildGeneration: rowInteger(candidate, "rebuild_generation"),
              now,
              remainingDepth: MAX_LEGACY_PREDECESSOR_CHAIN,
            });
          }
          const remaining = await executeTypedRecordProductQuery(tx,
            recordProductTypedDb.select({
              has_remaining: sql<boolean>`exists (
                select 1 from ${roomEvents} as remaining_event
                where remaining_event.room_id = ${roomId}
                  and remaining_event.projection_kind = 'legacy'
              )`.as("has_remaining"),
              converted_through: sql<number>`coalesce(max(${roomEvents.sequence})
                filter (where ${roomEvents.projectionKind} = 'native'), 0)::integer`
                .as("converted_through"),
            })
              .from(roomEvents)
              .where(eq(roomEvents.roomId, roomId)));
          const completedRoom = remaining[0]?.["has_remaining"] === false;
          await executeTypedRecordProductQuery(tx, recordProductTypedDb
            .update(roomJournalState)
            .set({
              recordConversionStatus: completedRoom ? "completed" : "pending",
              recordConversionCursorSequence:
                rowInteger(remaining[0]!, "converted_through"),
              recordConversionFailureCount: 0,
              recordConversionRetryAfter: null,
              recordConversionLastErrorCode: null,
              recordConversionLeaseToken: null,
              recordConversionLeaseExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(roomJournalState.roomId, roomId)));
          return { roomId, converted: page.length, completedRoom };
        }, { isolationLevel: "serializable" });
      } catch (error) {
        if (retryable(error) && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        if (failedRoomId !== null) {
          await executeTypedRecordProductQuery(this.options.handle,
            recordProductTypedDb.update(roomJournalState)
              .set({
                recordConversionFailureCount:
                  sql`${roomJournalState.recordConversionFailureCount} + 1`,
                recordConversionRetryAfter: new Date(now.getTime() + Math.min(
                60 * 60_000,
                15_000 * 2 ** Math.min(failedRoomFailureCount + 1, 8),
                )),
                recordConversionLastErrorCode: "persistence",
                recordConversionLeaseToken: null,
                recordConversionLeaseExpiresAt: null,
                updatedAt: now,
              })
              .where(eq(roomJournalState.roomId, failedRoomId)));
        }
        throw error;
      }
    }
    throw new Error("Unreachable Stenographer conversion state");
  }

  async #publishExtraction(
    tx: RecordProductPostgresExecutor,
    input: OrdinaryStenographerExtractionPublicationV2,
  ): Promise<OrdinaryStenographerExtractionPublicationResultV2> {
    await tx.query(
      "SELECT set_config('nautilo.stenographer_writer_version', '2', true)",
    );
    await tx.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [
      input.claim.roomId,
    ]);
    const states = await tx.query(
      `SELECT state.lease_token,
              state.suspended_at,
              state.rebuild_generation,
              room.namespace_id::text AS namespace_id,
              EXISTS (
                SELECT 1
                  FROM room_members member
                  JOIN actors actor ON actor.id = member.actor_id
                 WHERE member.room_id = state.room_id
                   AND actor.kind = 'agent'
              ) AS has_agent
         FROM room_journal_state state
         JOIN rooms room ON room.id = state.room_id
        WHERE state.room_id = $1
        FOR UPDATE OF state`,
      [input.claim.roomId],
    );
    const state = states[0];
    if (
      state === undefined
      || state["lease_token"] !== input.claim.leaseToken
      || state["suspended_at"] !== null
      || state["has_agent"] !== true
      || (
        input.claim.rebuildGeneration !== null
        && rowInteger(state, "rebuild_generation")
          !== input.claim.rebuildGeneration
      )
    ) return { published: false, eventsWritten: 0 };
    const namespaceId = rowString(state, "namespace_id");
    const rebuildGeneration = input.claim.rebuildGeneration
      ?? rowInteger(state, "rebuild_generation");

    const sourceIds = [...new Set(
      input.transition.inserts.flatMap((insert) => insert.sourceMessageIds),
    )].sort((left, right) => left - right);
    const sourceRows = sourceIds.length === 0
      ? []
      : await tx.query(
        `SELECT message.id,
                message.edit_revision,
                message.fingerprint,
                message.content
           FROM sessions session
           JOIN session_messages message ON message.session_id = session.id
          WHERE session.room_id = $1
            AND message.id = ANY($2::integer[])
            AND message.id > $3
            AND message.id <= $4
          ORDER BY message.id
          FOR SHARE OF message`,
        [
          input.claim.roomId,
          sourceIds,
          input.claim.fromMessageIdExclusive,
          input.claim.throughMessageIdInclusive,
        ],
      );
    if (sourceRows.length !== sourceIds.length) {
      throw new Error("Stenographer source changed before native publication");
    }
    const sourceBindings = new Map<number, StenographerMessageBinding>(
      sourceRows.map((row) => {
        const messageId = rowInteger(row, "id");
        return [messageId, {
          messageId,
          editRevision: rowInteger(row, "edit_revision"),
          observedContentFingerprint: messageFingerprint(row),
        }];
      }),
    );

    await this.#validateTransition(tx, input);
    for (const update of input.transition.statusUpdates) {
      await this.#ensureLegacyPredecessorNative(tx, {
        eventId: update.eventId,
        roomId: input.claim.roomId,
        namespaceId,
        rebuildGeneration,
        now: input.now,
        remainingDepth: MAX_LEGACY_PREDECESSOR_CHAIN,
      });
    }

    const allocated = input.transition.inserts.length === 0
      ? []
      : await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          event_id: sql<string>`gen_random_uuid()::text`.as("event_id"),
        }).from(sql`generate_series(1, ${input.transition.inserts.length}::integer)`));
    if (allocated.length !== input.transition.inserts.length) {
      throw new Error("Stenographer event identity allocation failed");
    }

    const recordIds: string[] = [];
    for (const [index, insert] of input.transition.inserts.entries()) {
      const eventId = rowString(allocated[index]!, "event_id");
      const sources = insert.sourceMessageIds.map((messageId) => {
        const binding = sourceBindings.get(messageId);
        if (binding === undefined) {
          throw new Error("Stenographer source binding is unavailable");
        }
        return binding;
      });
      const publication = buildStenographerRecordPublication({
        eventId,
        roomId: input.claim.roomId,
        namespaceId,
        kind: insert.kind,
        statement: insert.statement,
        sources,
        sourceBatchId: input.claim.batchId,
        batchLocalOrdinal: insert.batchLocalOrdinal,
        extractorVersion: input.extractorVersion,
        rebuildGeneration,
        transition: transitionForInsert(insert),
        publicationBindingRef:
          `journal:namespace:${namespaceId}:ordinary:v${this.options.selection.migrationGeneration}`,
      });
      const payloadBytes = encodeDurableRecordEnvelope(publication.record);
      const requestCommitment = this.options.commitment.commit(
        payloadBytes,
        publication,
      );
      const result = await this.#product.publishOrdinaryWithinTransaction(tx, {
        publication,
        payloadBytes,
        requestCommitment,
      });
      if (result.status === "rejected") {
        throw new Error(`Stenographer Record publication rejected: ${result.reason}`);
      }
      recordIds.push(eventId);
    }

    if (recordIds.length > 0) {
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(roomJournalRecordCutover)
        .values({
          singletonKey: 1,
          cutoverVersion: 1,
          firstNativeRecordId: recordIds[0]!,
          activatedAt: input.now,
          createdAt: input.now,
        })
        .onConflictDoNothing({ target: roomJournalRecordCutover.singletonKey }));
    }
    for (const update of input.transition.statusUpdates) {
      const changed = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(roomEvents)
          .set({ status: update.toStatus })
          .where(and(
            eq(roomEvents.id, update.eventId),
            eq(roomEvents.roomId, input.claim.roomId),
            eq(roomEvents.status, update.fromStatus),
          ))
          .returning({ id: roomEvents.id }));
      if (changed.length !== 1) {
        throw new Error("Stenographer transition target changed before attach");
      }
    }
    for (const [index, insert] of input.transition.inserts.entries()) {
      const eventId = recordIds[index]!;
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(roomEvents)
        .values({
          id: eventId,
          roomId: input.claim.roomId,
          sequence: insert.sequence,
          kind: insert.kind,
          statement: null,
          status: "active",
          supersedesEventId: insert.supersedesEventId,
          resolvesEventId: insert.resolvesEventId,
          sourceMessageIds: [...insert.sourceMessageIds],
          sourceBatchId: input.claim.batchId,
          batchLocalOrdinal: insert.batchLocalOrdinal,
          extractorVersion: input.extractorVersion,
          projectionKind: "native",
          recordId: eventId,
          cryptoObjectId: null,
          createdAt: input.now,
          nativeAttachedAt: input.now,
        }));
    }
    let ordinaryOutputFingerprint: Uint8Array | null = null;
    if (input.ordinaryFallbackReason !== undefined) {
      const actualOutputs = recordIds.length === 0
        ? []
        : await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .select({
            id: roomEvents.id,
            created_at: roomEvents.createdAt,
            plaintext_payload_bytes:
              reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
          })
          .from(roomEvents)
          .innerJoin(
            reflectionRecordPayloadRepresentationHeads,
            and(
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
          .innerJoin(
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
            eq(roomEvents.roomId, input.claim.roomId),
            eq(roomEvents.sourceBatchId, input.claim.batchId),
            eq(roomEvents.projectionKind, "native"),
            inArray(roomEvents.id, recordIds),
          ))
          .orderBy(roomEvents.batchLocalOrdinal));
      if (
        actualOutputs.length !== recordIds.length
        || actualOutputs.some((row, index) =>
          rowString(row, "id") !== recordIds[index]
        )
      ) {
        throw new Error("Stenographer persisted ordinary outputs changed");
      }
      ordinaryOutputFingerprint = stenographerOrdinaryOutputFingerprint({
        kind: "extraction",
        receiptId: input.claim.batchId,
        roomId: input.claim.roomId,
        namespaceId,
        rebuildGeneration,
        fallbackReason: input.ordinaryFallbackReason,
        outputs: actualOutputs.map((row) => ({
          logicalId: rowString(row, "id"),
          objectType: "nautilo.reflection.record.v1" as const,
          createdAt: rowTimestamp(row, "created_at").getTime(),
          payloadBytes: rowBytes(row, "plaintext_payload_bytes"),
        })),
      });
    }
    await this.#completeBatchAndCursor(
      tx,
      input,
      rebuildGeneration,
      ordinaryOutputFingerprint,
    );
    return { published: true, eventsWritten: recordIds.length };
  }

  async #validateTransition(
    tx: RecordProductPostgresExecutor,
    input: OrdinaryStenographerExtractionPublicationV2,
  ): Promise<void> {
    const maxRows = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        maximum_sequence: sql<number>`coalesce(max(${roomEvents.sequence}), 0)::integer`
          .as("maximum_sequence"),
      })
        .from(roomEvents)
        .where(eq(roomEvents.roomId, input.claim.roomId)));
    const expected = rowInteger(maxRows[0]!, "maximum_sequence") + 1;
    if (
      input.transition.inserts.some(
        (insert, index) => insert.sequence !== expected + index,
      )
      || input.transition.nextSequence !== expected + input.transition.inserts.length
    ) {
      throw new Error("Stenographer transition sequence changed before publish");
    }
    if (input.transition.statusUpdates.length === 0) return;
    const targetIds = input.transition.statusUpdates.map((update) => update.eventId);
    const rows = await tx.query(
      `SELECT id::text AS id, status
         FROM room_events
        WHERE room_id = $1 AND id = ANY($2::uuid[])
        FOR UPDATE`,
      [input.claim.roomId, targetIds],
    );
    if (
      rows.length !== targetIds.length
      || rows.some((row) => row["status"] !== "active")
    ) throw new Error("Stenographer transition target changed before publish");
  }

  async #ensureLegacyPredecessorNative(
    tx: RecordProductPostgresExecutor,
    input: Readonly<{
      eventId: string;
      roomId: string;
      namespaceId: string;
      rebuildGeneration: number;
      now: Date;
      remainingDepth: number;
    }>,
  ): Promise<void> {
    const rows = await tx.query(
      `SELECT event.id::text AS id,
              event.kind,
              event.statement,
              event.source_message_ids,
              event.source_batch_id::text AS source_batch_id,
              event.batch_local_ordinal,
              event.extractor_version,
              event.projection_kind,
              event.crypto_object_id,
              event.supersedes_event_id::text AS supersedes_event_id,
              event.resolves_event_id::text AS resolves_event_id,
              event.created_at
         FROM room_events event
        WHERE event.id = $1 AND event.room_id = $2
        FOR UPDATE`,
      [input.eventId, input.roomId],
    );
    const event = rows[0];
    if (event === undefined) throw new Error("Stenographer predecessor is unavailable");
    if (event["projection_kind"] === "native") return;
    if (event["crypto_object_id"] !== null) {
      throw new Error("Protected legacy predecessor cannot enter ordinary publication");
    }
    const predecessorId = typeof event["supersedes_event_id"] === "string"
      ? event["supersedes_event_id"]
      : typeof event["resolves_event_id"] === "string"
        ? event["resolves_event_id"]
        : null;
    if (predecessorId !== null) {
      if (input.remainingDepth === 0) {
        throw new Error("Legacy Stenographer predecessor chain exceeds conversion bound");
      }
      await this.#ensureLegacyPredecessorNative(tx, {
        ...input,
        eventId: predecessorId,
        remainingDepth: input.remainingDepth - 1,
      });
    }
    if (!Array.isArray(event["source_message_ids"])) {
      throw new Error("Legacy Stenographer sources are invalid");
    }
    const sourceIds = (event["source_message_ids"] as unknown[]).map((value) => {
      const number = typeof value === "bigint" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isSafeInteger(number)) {
        throw new Error("Legacy Stenographer source is invalid");
      }
      return number;
    });
    const sourceRows = await tx.query(
      `SELECT message.id,
              message.edit_revision,
              message.fingerprint,
              message.content
         FROM sessions session
         JOIN session_messages message ON message.session_id = session.id
        WHERE session.room_id = $1
          AND message.id = ANY($2::integer[])
        ORDER BY message.id
        FOR SHARE OF message`,
      [input.roomId, sourceIds],
    );
    if (sourceRows.length !== sourceIds.length) {
      throw new Error("Legacy Stenographer source is unavailable");
    }
    const publication = buildStenographerRecordPublication({
      eventId: rowString(event, "id"),
      roomId: input.roomId,
      namespaceId: input.namespaceId,
      kind: rowString(event, "kind") as RoomEventKind,
      statement: rowString(event, "statement"),
      sources: sourceRows.map((row) => ({
        messageId: rowInteger(row, "id"),
        editRevision: rowInteger(row, "edit_revision"),
        observedContentFingerprint: messageFingerprint(row),
      })),
      sourceBatchId: rowString(event, "source_batch_id"),
      batchLocalOrdinal: rowInteger(event, "batch_local_ordinal"),
      extractorVersion: rowString(event, "extractor_version"),
      rebuildGeneration: input.rebuildGeneration,
      transition: predecessorId === null
        ? { operation: "append" }
        : {
            operation: event["resolves_event_id"] === predecessorId
              ? "resolve"
              : "supersede",
            predecessorEventId: predecessorId,
          },
      publicationBindingRef:
        `journal:namespace:${input.namespaceId}:ordinary:v${this.options.selection.migrationGeneration}`,
    });
    const payloadBytes = encodeDurableRecordEnvelope(publication.record);
    const result = await this.#product.publishOrdinaryWithinTransaction(tx, {
      publication,
      payloadBytes,
      requestCommitment: this.options.commitment.commit(payloadBytes, publication),
    });
    if (result.status === "rejected") {
      throw new Error(`Legacy Stenographer conversion rejected: ${result.reason}`);
    }
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(roomJournalRecordCutover)
      .values({
        singletonKey: 1,
        cutoverVersion: 1,
        firstNativeRecordId: input.eventId,
        activatedAt: input.now,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: roomJournalRecordCutover.singletonKey }));
    const attached = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.update(roomEvents)
        .set({
          statement: null,
          projectionKind: "native",
          recordId: sql`${roomEvents.id}::text`,
          cryptoObjectId: null,
          nativeAttachedAt: input.now,
        })
        .where(and(
          eq(roomEvents.id, input.eventId),
          eq(roomEvents.projectionKind, "legacy"),
        ))
        .returning({ id: roomEvents.id }));
    if (attached.length !== 1) {
      throw new Error("Legacy Stenographer projection attach conflicted");
    }
  }

  async #completeBatchAndCursor(
    tx: RecordProductPostgresExecutor,
    input: OrdinaryStenographerExtractionPublicationV2,
    rebuildGeneration: number,
    ordinaryOutputFingerprint: Uint8Array | null,
  ): Promise<void> {
    const emptyProvenance = and(
      isNull(roomJournalBatches.ordinaryFallbackReason),
      isNull(roomJournalBatches.ordinaryFallbackRebuildGeneration),
      isNull(roomJournalBatches.ordinaryOutputFingerprint),
    );
    const provenanceFence = input.ordinaryFallbackReason === undefined
      ? emptyProvenance
      : or(
        emptyProvenance,
        and(
          eq(
            roomJournalBatches.ordinaryFallbackReason,
            input.ordinaryFallbackReason,
          ),
          eq(
            roomJournalBatches.ordinaryFallbackRebuildGeneration,
            rebuildGeneration,
          ),
          eq(
            roomJournalBatches.ordinaryOutputFingerprint,
            ordinaryOutputFingerprint!,
          ),
        ),
      );
    const completed = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.update(roomJournalBatches)
        .set({
          status: "completed",
          observationPublicationVersion: 2,
          operationCount: input.operationCount,
          modelId: input.modelId,
          completedAt: input.now,
          ordinaryFallbackReason: input.ordinaryFallbackReason ?? null,
          ordinaryFallbackRebuildGeneration:
            input.ordinaryFallbackReason === undefined
              ? null
              : rebuildGeneration,
          ordinaryOutputFingerprint,
        })
        .where(and(
          eq(roomJournalBatches.id, input.claim.batchId),
          eq(roomJournalBatches.roomId, input.claim.roomId),
          provenanceFence,
        ))
        .returning({ id: roomJournalBatches.id }));
    if (completed.length !== 1) {
      throw new Error("Stenographer source batch changed before completion");
    }
    const live = input.claim.lane === "live";
    await tx.query(
      `WITH latest_rollup AS (
         SELECT COALESCE(MAX(through_event_sequence), 0) AS through_sequence
           FROM room_event_rollups
          WHERE room_id = $1
       ), uncompacted AS (
         SELECT COUNT(*)::integer AS event_count,
                COALESCE(SUM(char_length(
                  CASE
                    WHEN event.projection_kind = 'legacy' THEN event.statement
                    ELSE convert_from(payload.plaintext_payload_bytes, 'UTF8')::jsonb->>'statement'
                  END
                )), 0)::integer AS statement_chars
           FROM room_events event
           CROSS JOIN latest_rollup rollup
           LEFT JOIN reflection_record_payload_representation_heads head
             ON head.record_id = event.record_id
            AND head.representation = 'ordinary'
           LEFT JOIN reflection_record_payload_representations payload
             ON payload.record_id = head.record_id
            AND payload.representation = head.representation
            AND payload.representation_generation = head.current_representation_generation
          WHERE event.room_id = $1
            AND event.status = 'active'
            AND event.sequence > rollup.through_sequence
       )
       UPDATE room_journal_state state
          SET last_processed_message_id = CASE WHEN $4
                THEN GREATEST(state.last_processed_message_id, $5)
                ELSE state.last_processed_message_id END,
              last_processed_at = CASE WHEN $4 THEN $3 ELSE state.last_processed_at END,
              historical_backfill_cursor_message_id = CASE WHEN NOT $4
                THEN GREATEST(state.historical_backfill_cursor_message_id, $5)
                ELSE state.historical_backfill_cursor_message_id END,
              historical_backfill_status = CASE WHEN NOT $4 AND $5 >= state.historical_backfill_target_message_id
                THEN 'completed' ELSE state.historical_backfill_status END,
              historical_backfill_completed_at = CASE WHEN NOT $4 AND $5 >= state.historical_backfill_target_message_id
                THEN $3 ELSE state.historical_backfill_completed_at END,
              lease_token = NULL,
              lease_expires_at = NULL,
              extraction_failure_count = 0,
              extraction_retry_after = NULL,
              last_extraction_completed_at = $3,
              rebuild_requested_at = CASE WHEN state.rebuild_requested_at IS NOT NULL
                AND state.rebuild_generation = $6
                AND $5 >= state.rebuild_target_message_id
                THEN NULL ELSE state.rebuild_requested_at END,
              rebuild_target_message_id = CASE WHEN state.rebuild_requested_at IS NOT NULL
                AND state.rebuild_generation = $6
                AND $5 >= state.rebuild_target_message_id
                THEN NULL ELSE state.rebuild_target_message_id END,
              compaction_due_at = CASE WHEN work.event_count >= 200 OR work.statement_chars >= 40000
                THEN COALESCE(state.compaction_due_at, $3)
                ELSE state.compaction_due_at END,
              updated_at = $3
         FROM uncompacted work
        WHERE state.room_id = $1 AND state.lease_token = $2`,
      [
        input.claim.roomId,
        input.claim.leaseToken,
        input.now,
        live,
        input.claim.throughMessageIdInclusive,
        input.claim.rebuildGeneration,
      ],
    );
  }
}
