import {installInitialAuthorityClosureWithinTransaction} from "./postgres-authority-store";
import type { RoomEventKind } from "@nautilo/reflection";
import {
  and,
  eq,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecordSuccessors,
  reflectionRecords,
  roomEvents,
  roomJournalRecordCutover,
  sql,
} from "@nautilo/db";
import type {
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import {
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  RecordProductPostgresExecutor,
  RecordProductPostgresRow,
} from "./product-postgres";
import {
  admitSemanticWorkWithinTransaction,
  indexSemanticSourceDependenciesWithinTransaction,
  type RecordSemanticCommitmentPort,
} from "./postgres-semantic-work-store";
import {
  decodeDurableRecordEnvelope,
  encodeDurableRecordEnvelope,
} from "./record-mapping";
import { assertStenographerRecordPayloadBinding } from
  "./stenographer-record-publication";

export interface ProtectedStenographerRecordAttachmentEvent {
  readonly eventId: string;
  readonly objectId: string;
  readonly sequence: number;
  readonly kind: RoomEventKind;
  readonly supersedesEventId: string | null;
  readonly resolvesEventId: string | null;
  readonly sourceMessageIds: readonly number[];
  readonly sourceBatchId: string;
  readonly batchLocalOrdinal: number;
  readonly extractorVersion: string;
  readonly createdAt: string;
  readonly requestCommitment: Uint8Array;
}

export interface ProtectedStenographerRecordStatusUpdate {
  readonly eventId: string;
  readonly fromStatus: "active";
  readonly toStatus: "superseded" | "resolved";
}

export interface ProtectedStenographerOrdinaryOutput {
  readonly objectId: string;
  /** Borrowed canonical Record payload bytes; attachment never mutates them. */
  readonly plaintext: Uint8Array;
}

export type ProtectedStenographerRecordAttachmentResult =
  | Readonly<{ readonly status: "attached" }>
  | Readonly<{ readonly status: "mapping_conflict" }>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function validateOrdinaryOutputs(input: Readonly<{
  roomId: string;
  namespaceId: string;
  rebuildGeneration: number;
  events: readonly ProtectedStenographerRecordAttachmentEvent[];
  ordinaryOutputs?: readonly ProtectedStenographerOrdinaryOutput[];
}>): readonly ProtectedStenographerOrdinaryOutput[] | undefined {
  const outputs = input.ordinaryOutputs;
  if (outputs === undefined) return undefined;
  if (
    outputs.length !== input.events.length
    || outputs.some((output, index) =>
      output.objectId !== input.events[index]?.objectId
    )
  ) throw new TypeError(
    "Protected Stenographer ordinary outputs disagree with event objects",
  );
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!;
    const event = input.events[index]!;
    const record = decodeDurableRecordEnvelope({
      recordRef: event.eventId,
      lifecycle: "current",
      structuralHeight: 0,
      processingGeneration: input.rebuildGeneration + 1,
      payloadBytes: output.plaintext,
    });
    assertStenographerRecordPayloadBinding(record, {
      eventId: event.eventId,
      roomId: input.roomId,
      namespaceId: input.namespaceId,
      kind: event.kind,
      status: "active",
      sourceMessageIds: event.sourceMessageIds,
      extractorVersion: event.extractorVersion,
      publicationGeneration: input.rebuildGeneration + 1,
    });
    if (!equalBytes(encodeDurableRecordEnvelope(record), output.plaintext)) {
      throw new TypeError(
        "Protected Stenographer ordinary output is not canonical",
      );
    }
  }
  return outputs;
}

/**
 * Product-transaction half of native protected observation attachment.
 * The caller has already authenticated every processor output object. This
 * is the sole owner of Record rows, representation mapping, successor edges,
 * canonical Record receipts, and the content-free Journal projection.
 */
export async function attachProtectedStenographerRecordsWithinTransaction(
  transaction: ConversationProductPostgresExecutor,
  input: Readonly<{
    roomId: string;
    namespaceId: string;
    rebuildGeneration: number;
    events: readonly ProtectedStenographerRecordAttachmentEvent[];
    statusUpdates: readonly ProtectedStenographerRecordStatusUpdate[];
    semanticCommitments?: RecordSemanticCommitmentPort;
    ordinaryOutputs?: readonly ProtectedStenographerOrdinaryOutput[];
  }>,
): Promise<ProtectedStenographerRecordAttachmentResult> {
  // Validate the entire borrowed output set before any product write so a bad
  // sibling cannot leave a partially attached batch in the caller's tx.
  const ordinaryOutputs = validateOrdinaryOutputs(input);
  const semanticTransaction: RecordProductPostgresExecutor = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly import("./product-postgres").RecordProductPostgresScalar[],
    ) {
      return transaction.query<Row>(
        statement,
        parameters as readonly ConversationProductPostgresScalar[] | undefined,
      );
    },
  };
  const semanticCommitments = input.semanticCommitments;
  if (input.statusUpdates.length > 0) {
    const targets = await transaction.query(
      `SELECT id::text AS id, status, projection_kind, record_id
         FROM room_events
        WHERE room_id = $1
          AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [
        input.roomId,
        `{${input.statusUpdates.map((update) => update.eventId).join(",")}}`,
      ],
    );
    const active = new Map(
      targets.map((target) => [target["id"], target["status"]]),
    );
    if (
      active.size !== input.statusUpdates.length
      || input.statusUpdates.some((update) =>
        active.get(update.eventId) !== update.fromStatus
      )
      || targets.some((target) =>
        target["projection_kind"] !== "native"
        || target["record_id"] !== target["id"]
      )
    ) return { status: "mapping_conflict" };
  }
  const eventIds = input.events.map((event) => event.eventId);
  const objectIds = input.events.map((event) => event.objectId);
  const mappingRows = await transaction.query(
    `SELECT event.id::text AS id
       FROM room_events AS event
      WHERE event.id = ANY($1::uuid[])
      UNION ALL
     SELECT representation.record_id
       FROM reflection_record_payload_representations AS representation
      WHERE representation.record_id = ANY($3::text[])
         OR representation.crypto_object_id = ANY($2::text[])`,
    [
      `{${eventIds.join(",")}}`,
      `{${objectIds.join(",")}}`,
      `{${eventIds.join(",")}}`,
    ],
  );
  if (mappingRows.length > 0) return { status: "mapping_conflict" };

  for (const update of input.statusUpdates) {
    const rows = await executeTypedRecordProductQuery(semanticTransaction,
      recordProductTypedDb.update(roomEvents)
        .set({ status: update.toStatus })
        .where(and(
          eq(roomEvents.id, update.eventId),
          eq(roomEvents.roomId, input.roomId),
          eq(roomEvents.status, update.fromStatus),
        ))
        .returning({ id: roomEvents.id }));
    if (rows.length !== 1) return { status: "mapping_conflict" };
    const lifecycle = await executeTypedRecordProductQuery(semanticTransaction,
      recordProductTypedDb.update(reflectionRecords)
        .set({
          lifecycle: update.toStatus,
          processingGeneration: sql`${reflectionRecords.processingGeneration} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(reflectionRecords.recordId, update.eventId),
          eq(reflectionRecords.lifecycle, "current"),
          eq(reflectionRecords.disposition, "available"),
        ))
        .returning({
          record_id: reflectionRecords.recordId,
          processing_generation: reflectionRecords.processingGeneration,
        }));
    if (lifecycle.length !== 1) return { status: "mapping_conflict" };
    if (semanticCommitments !== undefined) {
      const generation = lifecycle[0]?.["processing_generation"];
      const numericGeneration = typeof generation === "bigint"
        ? Number(generation)
        : generation;
      if (typeof numericGeneration !== "number" || !Number.isSafeInteger(numericGeneration)) {
        throw new TypeError("Protected Stenographer lifecycle generation is invalid");
      }
      await admitSemanticWorkWithinTransaction(semanticTransaction, {
        recordRef: update.eventId,
        changeReason: "revised",
        admissionCommitment: semanticCommitments.enqueue({
          logicalObjectRef: update.eventId,
          generation: numericGeneration,
          recordRef: update.eventId,
          changeReason: "revised",
        }),
        now: new Date(),
      });
    }
  }

  for (const [eventIndex, event] of input.events.entries()) {
    if (event.requestCommitment.byteLength !== 32) {
      throw new TypeError("Protected Stenographer Record commitment is invalid");
    }
    const createdAt = new Date(event.createdAt);
    await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
      .insert(reflectionRecords)
      .values({
        recordId: event.eventId,
        lifecycle: "current",
        structuralHeight: 0,
        producerPolicyVersion: event.extractorVersion,
        processingGeneration: input.rebuildGeneration + 1,
        payloadVersion: 1,
        disposition: "available",
        createdAt,
        updatedAt: createdAt,
      }));
    if (semanticCommitments !== undefined) {
      await indexSemanticSourceDependenciesWithinTransaction(semanticTransaction, {
        recordRef: event.eventId,
        sourceDependencyCommitments: event.sourceMessageIds.map((messageId) =>
          semanticCommitments.sourceDependency({
            sourceKind: "message",
            logicalSourceRef: `message:${messageId}`,
          })
        ),
      });
      await admitSemanticWorkWithinTransaction(semanticTransaction, {
        recordRef: event.eventId,
        changeReason: "created",
        admissionCommitment: semanticCommitments.enqueue({
          logicalObjectRef: event.eventId,
          generation: input.rebuildGeneration + 1,
          recordRef: event.eventId,
          changeReason: "created",
        }),
        now: createdAt,
      });
    }
    await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentations)
      .values({
        recordId: event.eventId,
        representation: "protected",
        representationGeneration: 1,
        payloadVersion: 1,
        plaintextPayloadBytes: null,
        cryptoObjectId: event.objectId,
        createdAt,
      }));
    await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentationHeads)
      .values({
        recordId: event.eventId,
        representation: "protected",
        currentRepresentationGeneration: 1,
        updatedAt: createdAt,
      }));
    const ordinaryOutput = ordinaryOutputs?.[eventIndex];
    if (ordinaryOutput !== undefined) {
      await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
        .insert(reflectionRecordPayloadRepresentations)
        .values({
          recordId: event.eventId,
          representation: "ordinary",
          representationGeneration: 1,
          payloadVersion: 1,
          plaintextPayloadBytes: ordinaryOutput.plaintext,
          cryptoObjectId: null,
          createdAt,
        }));
      await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
        .insert(reflectionRecordPayloadRepresentationHeads)
        .values({
          recordId: event.eventId,
          representation: "ordinary",
          currentRepresentationGeneration: 1,
          updatedAt: createdAt,
        }));
      // The authenticated Shadow sibling needs its own publication coordinate
      // so ordinary consumers can resolve it after an encryption-mode change.
      await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
        .insert(reflectionRecordPublications)
        .values({
          publicationId: `journal:${event.sourceBatchId}:${event.batchLocalOrdinal}:ordinary`,
          recordId: event.eventId,
          representation: "ordinary",
          representationGeneration: 1,
          payloadVersion: 1,
          requestCommitment: event.requestCommitment,
          publicationBindingRef: `journal:namespace:${input.namespaceId}:ordinary:v1`,
          cryptoObjectId: null,
          state: "complete",
          attemptCount: 0,
          productAttachedAt: createdAt,
          completedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        }));
    }
    const predecessor = event.supersedesEventId ?? event.resolvesEventId;
    if (predecessor !== null) {
      await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
        .insert(reflectionRecordSuccessors)
        .values({
          predecessorRecordId: predecessor,
          successorRecordId: event.eventId,
          relation: event.supersedesEventId === null ? "resolves" : "supersedes",
          createdAt,
        }));
    }
    // This per-Record receipt is the canonical native object owner. The
    // pre-existing Journal receipt remains only a batch reconciliation gate.
    await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
      .insert(reflectionRecordPublications)
      .values({
        publicationId: `journal:${event.sourceBatchId}:${event.batchLocalOrdinal}`,
        recordId: event.eventId,
        representation: "protected",
        representationGeneration: 1,
        payloadVersion: 1,
        requestCommitment: event.requestCommitment,
        publicationBindingRef: `journal:namespace:${input.namespaceId}:protected:v1`,
        cryptoObjectId: event.objectId,
        state: "complete",
        attemptCount: 0,
        cryptoCompletedAt: createdAt,
        productAttachedAt: createdAt,
        completedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }));
    const rows = await executeTypedRecordProductQuery(semanticTransaction,
      recordProductTypedDb.insert(roomEvents)
        .values({
          id: event.eventId,
          roomId: input.roomId,
          sequence: event.sequence,
          kind: event.kind,
          statement: null,
          status: "active",
          supersedesEventId: event.supersedesEventId,
          resolvesEventId: event.resolvesEventId,
          sourceMessageIds: [...event.sourceMessageIds],
          sourceBatchId: event.sourceBatchId,
          batchLocalOrdinal: event.batchLocalOrdinal,
          extractorVersion: event.extractorVersion,
          projectionKind: "native",
          recordId: event.eventId,
          cryptoObjectId: null,
          createdAt,
          nativeAttachedAt: createdAt,
        })
        .returning({ id: roomEvents.id, record_id: roomEvents.recordId }));
    if (
      rows.length !== 1
      || rows[0]?.["id"] !== event.eventId
      || rows[0]?.["record_id"] !== event.eventId
    ) return { status: "mapping_conflict" };
    // Native observation attachment has already verified the closed Stenographer
    // payload contract: height zero, no children, and this exact source Namespace.
    const authority = await installInitialAuthorityClosureWithinTransaction(semanticTransaction, {
      recordRef: event.eventId, closureGeneration: 1, terminalAuthorityLeafHandles: [input.namespaceId],
    });
    if (authority === "conflict") return {status: "mapping_conflict"};
    await executeTypedRecordProductQuery(semanticTransaction, recordProductTypedDb
      .insert(roomJournalRecordCutover)
      .values({
        singletonKey: 1,
        cutoverVersion: 1,
        firstNativeRecordId: event.eventId,
        activatedAt: createdAt,
        createdAt,
      })
      .onConflictDoNothing({ target: roomJournalRecordCutover.singletonKey }));
  }
  return { status: "attached" };
}
