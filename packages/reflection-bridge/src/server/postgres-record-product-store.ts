import type {
  DirectRecordDispositionMutation,
  DirectRecordDispositionResult,
  DurableRecordLifecycleMutation,
  DurableRecordLifecycleMutationResult,
  DurableRecordPublication,
  DurableRecordPublicationResult,
  DurableRecordStructuralRejection,
  SuccessorEdge,
} from "@nautilo/reflection/durable";
import { assertLifecycleTransition } from "@nautilo/reflection/durable";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordDependencies,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecordSearchProjections,
  reflectionRecords,
  reflectionRecordSuccessors,
  sql,
} from "@nautilo/db";

import type {
  RecordProductPublicationReservation,
  RecordProductStorePort,
  RecordProductVisibleRow,
  RecordRepositoryFailureCode,
  ProtectedRecordFailureDisposition,
  ProtectedRecordRetirement,
} from "./contracts";
import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";
import type { RecordSemanticPublicationPort } from "./postgres-semantic-work-store";
import { installInitialAuthorityClosureWithinTransaction } from "./postgres-authority-store";
import { encodeDurableRecordEnvelope } from "./record-mapping";

const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_FAILURE = "40P01";
const MAX_TRANSACTION_ATTEMPTS = 3;

export type RecordOrdinarySiblingAttachment = Readonly<{
  protectedPublicationId: string;
  protectedRequestCommitment: Uint8Array;
  ordinaryPublication: DurableRecordPublication;
  ordinaryPayloadBytes: Uint8Array;
  ordinaryRequestCommitment: Uint8Array;
}>;

export type RecordOrdinarySiblingAttachmentResult =
  | "attached"
  | "replayed"
  | "blocked"
  | "conflict";

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === SERIALIZATION_FAILURE || error.code === DEADLOCK_FAILURE);
}

function rowString(row: RecordProductPostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Invalid Record product row");
  return value;
}

function rowInteger(row: RecordProductPostgresRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Record product counter");
  }
  return value;
}

function rowBytes(row: RecordProductPostgresRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new TypeError("Invalid Record product bytes");
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function lifecycle(value: string): RecordProductVisibleRow["lifecycle"] {
  if (!["current", "stale", "superseded", "resolved", "sunset"].includes(value)) {
    throw new TypeError("Invalid Record lifecycle row");
  }
  return value as RecordProductVisibleRow["lifecycle"];
}

/** Dormant product-role PostgreSQL persistence. Owns no pool or crypto handle. */
export class PostgresRecordProductStore implements RecordProductStorePort {
  constructor(
    private readonly handle: RecordProductPostgresHandle,
    private readonly semanticWork?: RecordSemanticPublicationPort,
  ) {
    assertVerifiedRecordProductPostgresHandle(handle);
  }

  async readCompletedPublicationRecordId(input: Readonly<{
    idempotencyKey: string;
  }>): Promise<
    | { readonly status: "available"; readonly recordId: string }
    | {
        readonly status: "unavailable";
        readonly reason: "not_found" | "incomplete" | "blocked" | "purged";
      }
  > {
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordPublications.recordId,
        state: reflectionRecordPublications.state,
        disposition: reflectionRecords.disposition,
      })
        .from(reflectionRecordPublications)
        .leftJoin(reflectionRecords, eq(
          reflectionRecords.recordId,
          reflectionRecordPublications.recordId,
        ))
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey))
        .limit(1));
    if (rows.length === 0) return { status: "unavailable", reason: "not_found" };
    const row = rows[0]!;
    if (row["disposition"] === "blocked" || row["disposition"] === "purged") {
      return { status: "unavailable", reason: row["disposition"] };
    }
    if (row["state"] !== "complete") {
      return { status: "unavailable", reason: "incomplete" };
    }
    return { status: "available", recordId: rowString(row, "record_id") };
  }

  publishOrdinary(input: Readonly<{ publication: DurableRecordPublication; payloadBytes: Uint8Array; requestCommitment: Uint8Array }>): Promise<DurableRecordPublicationResult> {
    return this.#serializable((tx) =>
      this.publishOrdinaryWithinTransaction(tx, input)
    );
  }

  /** Bridge-internal composition seam for one larger verified product tx. */
  async publishOrdinaryWithinTransaction(
    tx: RecordProductPostgresExecutor,
    input: Readonly<{
      publication: DurableRecordPublication;
      payloadBytes: Uint8Array;
      requestCommitment: Uint8Array;
    }>,
  ): Promise<DurableRecordPublicationResult> {
    const replay = await this.#publicationReplay(
      tx,
      input.publication,
      input.requestCommitment,
      "ordinary",
    );
    if (replay !== null) return replay;
    const structuralRejection = await this.#validateGraph(tx, input.publication);
    if (structuralRejection !== null) {
      return {
        status: "rejected",
        recordRef: input.publication.record.recordRef,
        reason: "structural_conflict",
        structuralReason: structuralRejection,
      };
    }
    await this.#insertGraph(tx, input.publication);
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentations)
      .values({
        recordId: input.publication.record.recordRef,
        representation: "ordinary",
        representationGeneration: 1,
        payloadVersion: 1,
        plaintextPayloadBytes: input.payloadBytes,
      }));
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentationHeads)
      .values({
        recordId: input.publication.record.recordRef,
        representation: "ordinary",
        currentRepresentationGeneration: 1,
      }));
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPublications)
      .values({
        publicationId: input.publication.idempotencyKey,
        recordId: input.publication.record.recordRef,
        representation: "ordinary",
        representationGeneration: 1,
        payloadVersion: 1,
        requestCommitment: input.requestCommitment,
        publicationBindingRef: input.publication.publicationBindingRef,
        originPublicationBindingRef: input.publication.originPublicationBindingRef,
        state: "complete",
        productAttachedAt: sql`now()`,
        completedAt: sql`now()`,
      }));
    return { status: "published", record: input.publication.record };
  }

  attachOrdinarySibling(
    input: RecordOrdinarySiblingAttachment,
  ): Promise<RecordOrdinarySiblingAttachmentResult> {
    return this.#serializable((tx) =>
      this.attachOrdinarySiblingWithinTransaction(tx, input)
    );
  }

  /**
   * Attach an ordinary Shadow sibling to one already authenticated protected
   * publication. The protected attachment owns the graph and semantic work;
   * this seam owns only the additional immutable representation, head, and
   * replay receipt inside the caller's held product transaction.
   */
  async attachOrdinarySiblingWithinTransaction(
    tx: RecordProductPostgresExecutor,
    input: RecordOrdinarySiblingAttachment,
  ): Promise<RecordOrdinarySiblingAttachmentResult> {
    const publication = input.ordinaryPublication;
    const recordId = publication.record.recordRef;
    const canonical = encodeDurableRecordEnvelope(publication.record);
    try {
      if (!sameBytes(canonical, input.ordinaryPayloadBytes)) return "conflict";
    } finally {
      canonical.fill(0);
    }
    if (
      input.protectedRequestCommitment.byteLength !== 32
      || input.ordinaryRequestCommitment.byteLength !== 32
      || input.protectedPublicationId === publication.idempotencyKey
    ) return "conflict";

    await this.#lock(tx, [
      recordId,
      input.protectedPublicationId,
      publication.idempotencyKey,
    ]);
    const protectedRows = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        record_id: reflectionRecordPublications.recordId,
        representation: reflectionRecordPublications.representation,
        representation_generation: reflectionRecordPublications.representationGeneration,
        payload_version: reflectionRecordPublications.payloadVersion,
        request_commitment: reflectionRecordPublications.requestCommitment,
        publication_binding_ref: reflectionRecordPublications.publicationBindingRef,
        origin_publication_binding_ref: reflectionRecordPublications.originPublicationBindingRef,
        state: reflectionRecordPublications.state,
        replay_structural_height: reflectionRecordPublications.replayStructuralHeight,
        replay_processing_generation: reflectionRecordPublications.replayProcessingGeneration,
        replay_predecessor_record_id: reflectionRecordPublications.replayPredecessorRecordId,
        replay_predecessor_relation: reflectionRecordPublications.replayPredecessorRelation,
        disposition: reflectionRecords.disposition,
        current_representation_generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
      }).from(reflectionRecordPublications)
        .innerJoin(reflectionRecords, eq(reflectionRecords.recordId, reflectionRecordPublications.recordId))
        .innerJoin(reflectionRecordPayloadRepresentationHeads, and(
          eq(reflectionRecordPayloadRepresentationHeads.recordId, reflectionRecordPublications.recordId),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
        ))
        .where(eq(reflectionRecordPublications.publicationId, input.protectedPublicationId))
        .for("update"));
    if (protectedRows.length !== 1) return "conflict";
    const protectedRow = protectedRows[0]!;
    const disposition = rowString(protectedRow, "disposition");
    if (disposition === "blocked" || disposition === "purged") return "blocked";
    const predecessor = publication.predecessor;
    if (
      rowString(protectedRow, "record_id") !== recordId
      || rowString(protectedRow, "representation") !== "protected"
      || rowInteger(protectedRow, "representation_generation") !== 1
      || rowInteger(protectedRow, "current_representation_generation") !== 1
      || rowInteger(protectedRow, "payload_version") !== 1
      || !sameBytes(rowBytes(protectedRow, "request_commitment"), input.protectedRequestCommitment)
      || protectedRow["origin_publication_binding_ref"] !== (publication.originPublicationBindingRef ?? null)
      || !["product_attached", "complete"].includes(rowString(protectedRow, "state"))
      || rowInteger(protectedRow, "replay_structural_height") !== publication.record.structuralHeight
      || rowInteger(protectedRow, "replay_processing_generation") !== publication.record.processingGeneration
      || protectedRow["replay_predecessor_record_id"] !== (predecessor?.recordRef ?? null)
      || protectedRow["replay_predecessor_relation"] !== (predecessor?.relation ?? null)
    ) return "conflict";

    const ordinaryRepresentations = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        representation_generation: reflectionRecordPayloadRepresentations.representationGeneration,
        payload_version: reflectionRecordPayloadRepresentations.payloadVersion,
        plaintext_payload_bytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
        crypto_object_id: reflectionRecordPayloadRepresentations.cryptoObjectId,
      }).from(reflectionRecordPayloadRepresentations).where(and(
        eq(reflectionRecordPayloadRepresentations.recordId, recordId),
        eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
      )).orderBy(asc(reflectionRecordPayloadRepresentations.representationGeneration)).for("update"));
    const ordinaryHeads = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        current_representation_generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
      }).from(reflectionRecordPayloadRepresentationHeads).where(and(
        eq(reflectionRecordPayloadRepresentationHeads.recordId, recordId),
        eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
      )).for("update"));
    const ordinaryPublications = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        publication_id: reflectionRecordPublications.publicationId,
        record_id: reflectionRecordPublications.recordId,
        representation: reflectionRecordPublications.representation,
        representation_generation: reflectionRecordPublications.representationGeneration,
        payload_version: reflectionRecordPublications.payloadVersion,
        request_commitment: reflectionRecordPublications.requestCommitment,
        publication_binding_ref: reflectionRecordPublications.publicationBindingRef,
        origin_publication_binding_ref: reflectionRecordPublications.originPublicationBindingRef,
        crypto_object_id: reflectionRecordPublications.cryptoObjectId,
        reserved_crypto_object_id: reflectionRecordPublications.reservedCryptoObjectId,
        state: reflectionRecordPublications.state,
      }).from(reflectionRecordPublications).where(or(
        eq(reflectionRecordPublications.publicationId, publication.idempotencyKey),
        and(eq(reflectionRecordPublications.recordId, recordId), eq(reflectionRecordPublications.representation, "ordinary")),
      )).orderBy(asc(reflectionRecordPublications.publicationId)).for("update"));
    const anyOrdinaryState = ordinaryRepresentations.length > 0
      || ordinaryHeads.length > 0
      || ordinaryPublications.length > 0;
    if (anyOrdinaryState) {
      if (
        ordinaryRepresentations.length !== 1
        || ordinaryHeads.length !== 1
        || ordinaryPublications.length !== 1
      ) return "conflict";
      const representation = ordinaryRepresentations[0]!;
      const head = ordinaryHeads[0]!;
      const receipt = ordinaryPublications[0]!;
      return rowInteger(representation, "representation_generation") === 1
        && rowInteger(representation, "payload_version") === 1
        && sameBytes(rowBytes(representation, "plaintext_payload_bytes"), input.ordinaryPayloadBytes)
        && representation["crypto_object_id"] === null
        && rowInteger(head, "current_representation_generation") === 1
        && rowString(receipt, "publication_id") === publication.idempotencyKey
        && rowString(receipt, "record_id") === recordId
        && rowString(receipt, "representation") === "ordinary"
        && rowInteger(receipt, "representation_generation") === 1
        && rowInteger(receipt, "payload_version") === 1
        && sameBytes(rowBytes(receipt, "request_commitment"), input.ordinaryRequestCommitment)
        && rowString(receipt, "publication_binding_ref") === publication.publicationBindingRef
        && receipt["origin_publication_binding_ref"] === (publication.originPublicationBindingRef ?? null)
        && receipt["crypto_object_id"] === null
        && receipt["reserved_crypto_object_id"] === null
        && rowString(receipt, "state") === "complete"
        ? "replayed"
        : "conflict";
    }

    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentations)
      .values({
        recordId,
        representation: "ordinary",
        representationGeneration: 1,
        payloadVersion: 1,
        plaintextPayloadBytes: input.ordinaryPayloadBytes,
      }));
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPayloadRepresentationHeads)
      .values({
        recordId,
        representation: "ordinary",
        currentRepresentationGeneration: 1,
      }));
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordPublications)
      .values({
        publicationId: publication.idempotencyKey,
        recordId,
        representation: "ordinary",
        representationGeneration: 1,
        payloadVersion: 1,
        requestCommitment: input.ordinaryRequestCommitment,
        publicationBindingRef: publication.publicationBindingRef,
        originPublicationBindingRef: publication.originPublicationBindingRef,
        state: "complete",
        productAttachedAt: sql`now()`,
        completedAt: sql`now()`,
      }));
    return "attached";
  }

  transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult> {
    return this.#serializable(async (tx) => {
      if (
        !Number.isSafeInteger(input.expectedProcessingGeneration)
        || input.expectedProcessingGeneration < 1
      ) return { status: "conflict", recordRef: input.recordRef, replayed: false };
      try {
        assertLifecycleTransition(input.from, input.to, {
          successorAttached: false,
        });
      } catch {
        return { status: "conflict", recordRef: input.recordRef, replayed: false };
      }
      const childRows = input.to === "current"
        ? await executeTypedRecordProductQuery(tx, recordProductTypedDb
            .select({ child_record_id: reflectionRecordDependencies.childRecordId })
            .from(reflectionRecordDependencies)
            .where(eq(
              reflectionRecordDependencies.parentRecordId,
              input.recordRef,
            ))
            .orderBy(asc(reflectionRecordDependencies.childRecordId)))
        : [];
      const childRecordRefs = childRows.map((row) => row.child_record_id);
      await this.#lock(tx, [input.recordRef, ...childRecordRefs]);
      const rows = await tx.query(
        `SELECT lifecycle, processing_generation, disposition
           FROM reflection_records
          WHERE record_id = $1
          FOR UPDATE`,
        [input.recordRef],
      );
      if (rows.length === 0) {
        return { status: "not_found", recordRef: input.recordRef, replayed: false };
      }
      const row = rows[0]!;
      const disposition = rowString(row, "disposition");
      if (disposition === "blocked" || disposition === "purged") {
        return { status: disposition, recordRef: input.recordRef, replayed: false };
      }
      const processingGeneration = rowInteger(row, "processing_generation");
      const current = lifecycle(rowString(row, "lifecycle"));
      if (
        current === input.to
        && processingGeneration === input.expectedProcessingGeneration + 1
      ) {
        return {
          status: "transitioned",
          recordRef: input.recordRef,
          lifecycle: input.to,
          replayed: true,
        };
      }
      if (
        processingGeneration !== input.expectedProcessingGeneration
        || current !== input.from
      ) {
        return { status: "conflict", recordRef: input.recordRef, replayed: false };
      }
      if (input.to === "current" && childRecordRefs.length > 0) {
        const competingParents = await tx.query(
          `SELECT 1 AS found
             FROM reflection_record_dependencies AS dependency
             JOIN reflection_records AS parent
               ON parent.record_id = dependency.parent_record_id
            WHERE dependency.child_record_id = ANY($1::text[])
              AND parent.record_id <> $2
              AND parent.lifecycle = 'current'
              AND parent.disposition = 'available'
            LIMIT 1`,
          [childRecordRefs, input.recordRef],
        );
        if (competingParents.length > 0) {
          return { status: "conflict", recordRef: input.recordRef, replayed: false };
        }
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecords)
        .set({
          lifecycle: input.to,
          processingGeneration: sql`${reflectionRecords.processingGeneration} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(reflectionRecords.recordId, input.recordRef)));
      await this.semanticWork?.recordChangedWithinTransaction(tx, {
        recordRef: input.recordRef,
        changeRef:
          `lifecycle:${input.from}:${input.to}:v${input.expectedProcessingGeneration + 1}`,
      });
      return {
        status: "transitioned",
        recordRef: input.recordRef,
        lifecycle: input.to,
        replayed: false,
      };
    });
  }

  reserveProtected(input: Readonly<{ publication: DurableRecordPublication; requestCommitment: Uint8Array }>): Promise<RecordProductPublicationReservation> {
    return this.#serializable(async (tx) => {
      await this.#lock(tx, [input.publication.idempotencyKey, input.publication.record.recordRef]);
      const rows = await tx.query(`SELECT record_id, representation, request_commitment, state, crypto_object_id, failure_code FROM reflection_record_publications WHERE publication_id = $1 FOR UPDATE`, [input.publication.idempotencyKey]);
      if (rows.length > 0) {
        const row = rows[0]!;
        const dispositionRows = await executeTypedRecordProductQuery(tx,
          recordProductTypedDb.select({ disposition: reflectionRecords.disposition })
            .from(reflectionRecords)
            .where(eq(reflectionRecords.recordId, input.publication.record.recordRef)));
        if (dispositionRows.length === 1) {
          const disposition = rowString(dispositionRows[0]!, "disposition");
          if (disposition === "blocked" || disposition === "purged") return { status: disposition, recordId: input.publication.record.recordRef };
        }
        if (rowString(row, "record_id") !== input.publication.record.recordRef || rowString(row, "representation") !== "protected" || !sameBytes(rowBytes(row, "request_commitment"), input.requestCommitment)) return { status: "conflict", recordId: input.publication.record.recordRef };
        const state = rowString(row, "state");
        if (state === "blocked" || state === "quarantined" || state === "retry_exhausted") {
          return {
            status: row["failure_code"] === "purged" ? "purged" : "blocked",
            recordId: input.publication.record.recordRef,
          };
        }
        return { status: "replayed", recordId: input.publication.record.recordRef, state: state as "reserved" | "crypto_complete" | "product_attached" | "complete", ...(typeof row["crypto_object_id"] === "string" ? { cryptoObjectId: row["crypto_object_id"] } : {}) };
      }
      const coordinateRows = await tx.query(
        `SELECT publication_id
           FROM reflection_record_publications
          WHERE record_id = $1
            AND representation = 'protected'
            AND representation_generation = 1
          FOR UPDATE`,
        [input.publication.record.recordRef],
      );
      if (coordinateRows.length > 0) {
        return { status: "conflict", recordId: input.publication.record.recordRef };
      }
      const recordRows = await tx.query(`SELECT disposition FROM reflection_records WHERE record_id = $1 FOR UPDATE`, [input.publication.record.recordRef]);
      if (recordRows.length > 0) {
        const disposition = rowString(recordRows[0]!, "disposition");
        if (disposition === "blocked" || disposition === "purged") return { status: disposition, recordId: input.publication.record.recordRef };
        return { status: "conflict", recordId: input.publication.record.recordRef };
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordPublications)
        .values({
          publicationId: input.publication.idempotencyKey,
          recordId: input.publication.record.recordRef,
          representation: "protected",
          representationGeneration: 1,
          payloadVersion: 1,
          requestCommitment: input.requestCommitment,
          publicationBindingRef: input.publication.publicationBindingRef,
          originPublicationBindingRef: input.publication.originPublicationBindingRef,
          replayStructuralHeight: input.publication.record.structuralHeight,
          replayProcessingGeneration: input.publication.record.processingGeneration,
          replayPredecessorRecordId: input.publication.predecessor?.recordRef,
          replayPredecessorRelation: input.publication.predecessor?.relation,
          state: "reserved",
          nextAttemptAt: sql`now()`,
        }));
      return { status: "reserved", recordId: input.publication.record.recordRef };
    });
  }

  bindProtectedOutput(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
  }>): Promise<"updated" | "replayed" | "blocked" | "conflict"> {
    return this.#serializable(async (tx) => {
      const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .select({
          record_id: reflectionRecordPublications.recordId,
          representation: reflectionRecordPublications.representation,
          request_commitment: reflectionRecordPublications.requestCommitment,
          state: reflectionRecordPublications.state,
          crypto_object_id: reflectionRecordPublications.cryptoObjectId,
          reserved_crypto_object_id: reflectionRecordPublications.reservedCryptoObjectId,
        })
        .from(reflectionRecordPublications)
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey))
        .for("update"));
      if (
        rows.length !== 1
        || rowString(rows[0]!, "record_id") !== input.recordId
        || rowString(rows[0]!, "representation") !== "protected"
        || !sameBytes(rowBytes(rows[0]!, "request_commitment"), input.requestCommitment)
      ) return "conflict";
      const row = rows[0]!;
      const state = rowString(row, "state");
      if (["blocked", "quarantined", "retry_exhausted"].includes(state)) {
        return "blocked";
      }
      if (
        (typeof row["reserved_crypto_object_id"] === "string"
          && row["reserved_crypto_object_id"] !== input.cryptoObjectId)
        || (typeof row["crypto_object_id"] === "string"
          && row["crypto_object_id"] !== input.cryptoObjectId)
      ) return "conflict";
      if (row["reserved_crypto_object_id"] === input.cryptoObjectId) {
        return "replayed";
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({ reservedCryptoObjectId: input.cryptoObjectId })
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey)));
      return "updated";
    });
  }

  markProtectedCryptoComplete(input: Readonly<{ idempotencyKey: string; recordId: string; cryptoObjectId: string; leaseToken?: string }>): Promise<"updated" | "replayed" | "blocked" | "conflict"> {
    return this.#serializable(async (tx) => {
      const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .select({
          state: reflectionRecordPublications.state,
          record_id: reflectionRecordPublications.recordId,
          crypto_object_id: reflectionRecordPublications.cryptoObjectId,
          reserved_crypto_object_id: reflectionRecordPublications.reservedCryptoObjectId,
          lease_token: reflectionRecordPublications.leaseToken,
          lease_live: sql<boolean>`${reflectionRecordPublications.leaseExpiresAt} > now()`.as("lease_live"),
        })
        .from(reflectionRecordPublications)
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey))
        .for("update"));
      if (rows.length !== 1 || rowString(rows[0]!, "record_id") !== input.recordId) return "conflict";
      const row = rows[0]!;
      const state = rowString(row, "state");
      if (["blocked", "quarantined", "retry_exhausted"].includes(state)) return "blocked";
      if (
        input.leaseToken !== undefined
        && (row["lease_token"] !== input.leaseToken || row["lease_live"] !== true)
      ) return "conflict";
      if (typeof row["crypto_object_id"] === "string" && row["crypto_object_id"] !== input.cryptoObjectId) return "conflict";
      if (typeof row["reserved_crypto_object_id"] === "string" && row["reserved_crypto_object_id"] !== input.cryptoObjectId) return "conflict";
      if (state !== "reserved") return "replayed";
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({
          cryptoObjectId: input.cryptoObjectId,
          state: "crypto_complete",
          cryptoCompletedAt: sql`now()`,
          nextAttemptAt: sql`now()`,
          ...(input.leaseToken === undefined
            ? { leaseToken: null, leaseExpiresAt: null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey)));
      return "updated";
    });
  }

  attachProtected(input: Readonly<{
    publication: DurableRecordPublication;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
    leaseToken?: string;
  }>): Promise<"attached" | "replayed" | "blocked" | "conflict"> {
    return this.#serializable(async (tx) => {
      const rows = await tx.query(`SELECT state, record_id, crypto_object_id, request_commitment, lease_token FROM reflection_record_publications WHERE publication_id = $1 FOR UPDATE`, [input.publication.idempotencyKey]);
      if (
        rows.length !== 1
        || rowString(rows[0]!, "record_id") !== input.publication.record.recordRef
        || rows[0]!["crypto_object_id"] !== input.cryptoObjectId
        || !sameBytes(rowBytes(rows[0]!, "request_commitment"), input.requestCommitment)
        || (
          input.leaseToken !== undefined
          && rows[0]!["lease_token"] !== input.leaseToken
        )
      ) return "conflict";
      const state = rowString(rows[0]!, "state");
      if (["blocked", "quarantined", "retry_exhausted"].includes(state)) return "blocked";
      if (state === "product_attached" || state === "complete") return "replayed";
      if (
        state !== "crypto_complete"
        || (await this.#validateGraph(tx, input.publication)) !== null
      ) return "conflict";
      await this.#insertGraph(tx, input.publication);
      // The verified publication carries the canonical closure, including
      // uncited model exposure. Install it while attachment is still atomic;
      // encrypted dependencies cannot be reconstructed by metadata bootstrap.
      // The authority owner reconciles this dirty closure against current
      // source authority before any reader may use the new Record.
      const authority = await installInitialAuthorityClosureWithinTransaction(tx, {
        recordRef: input.publication.record.recordRef,
        closureGeneration: 1,
        terminalAuthorityLeafHandles: input.publication.record.semantic.terminalAuthorityLeafHandles,
      });
      if (authority === "conflict") throw new Error("Protected Record initial authority closure conflicts");
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordPayloadRepresentations)
        .values({
          recordId: input.publication.record.recordRef,
          representation: "protected",
          representationGeneration: 1,
          payloadVersion: 1,
          cryptoObjectId: input.cryptoObjectId,
        }));
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordPayloadRepresentationHeads)
        .values({
          recordId: input.publication.record.recordRef,
          representation: "protected",
          currentRepresentationGeneration: 1,
        }));
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({
          state: "product_attached",
          productAttachedAt: sql`now()`,
          nextAttemptAt: sql`now()`,
          ...(input.leaseToken === undefined
            ? { leaseToken: null, leaseExpiresAt: null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(
          reflectionRecordPublications.publicationId,
          input.publication.idempotencyKey,
        )));
      return "attached";
    });
  }

  completeProtected(input: Readonly<{ idempotencyKey: string; recordId: string; leaseToken?: string }>): Promise<"complete" | "replayed" | "blocked" | "conflict"> {
    return this.#serializable(async (tx) => {
      const rows = await tx.query(`SELECT state, record_id, lease_token FROM reflection_record_publications WHERE publication_id = $1 FOR UPDATE`, [input.idempotencyKey]);
      if (rows.length !== 1 || rowString(rows[0]!, "record_id") !== input.recordId) return "conflict";
      const state = rowString(rows[0]!, "state");
      if (["blocked", "quarantined", "retry_exhausted"].includes(state)) return "blocked";
      if (state === "complete") return "replayed";
      if (state !== "product_attached") return "conflict";
      if (input.leaseToken !== undefined && rows[0]!["lease_token"] !== input.leaseToken) return "conflict";
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({
          state: "complete",
          completedAt: sql`now()`,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(reflectionRecordPublications.publicationId, input.idempotencyKey)));
      return "complete";
    });
  }

  failProtected(input: Readonly<{ idempotencyKey: string; recordId: string; failureCode: RecordRepositoryFailureCode; terminal: boolean; leaseToken?: string }>): Promise<ProtectedRecordFailureDisposition> {
    return this.handle.transaction(async (tx) => {
      const preservesAttempt = !input.terminal
        && input.failureCode === "authorization_unavailable";
      const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({
          attemptCount: preservesAttempt
            ? reflectionRecordPublications.attemptCount
            : sql`least(${reflectionRecordPublications.attemptCount} + 1, 8)`,
          state: sql`CASE
            WHEN ${input.terminal} THEN 'quarantined'
            WHEN ${!preservesAttempt}
              AND ${reflectionRecordPublications.attemptCount} + 1 >= 8
              THEN 'retry_exhausted'
            ELSE ${reflectionRecordPublications.state}
          END`,
          failureCode: sql`CASE
            WHEN ${input.terminal} THEN ${input.failureCode}
            WHEN ${!preservesAttempt}
              AND ${reflectionRecordPublications.attemptCount} + 1 >= 8
              THEN 'retry_exhausted'
            ELSE null
          END`,
          nextAttemptAt: sql`CASE
            WHEN ${input.terminal}
              OR (${!preservesAttempt}
                AND ${reflectionRecordPublications.attemptCount} + 1 >= 8)
              THEN null
            ELSE now() + interval '15 seconds'
          END`,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(reflectionRecordPublications.publicationId, input.idempotencyKey),
          eq(reflectionRecordPublications.recordId, input.recordId),
          inArray(reflectionRecordPublications.state, [
            "reserved",
            "crypto_complete",
            "product_attached",
          ]),
          input.leaseToken === undefined
            ? undefined
            : eq(reflectionRecordPublications.leaseToken, input.leaseToken),
        ))
        .returning({ state: reflectionRecordPublications.state }));
      if (rows.length !== 1) return "ignored";
      const state = rowString(rows[0]!, "state");
      return state === "quarantined"
        ? "quarantined"
        : state === "retry_exhausted"
          ? "retry_exhausted"
          : "scheduled";
    }, { isolationLevel: "read committed" });
  }

  async readVisible(input: Readonly<{ recordId: string; representation: "ordinary" | "protected" }>): Promise<{ status: "available"; row: RecordProductVisibleRow } | { status: "unavailable"; reason: "not_found" | "selected_representation_missing" | "blocked" | "purged" }> {
    const protectedPublicationComplete = sql`exists (
      select 1 from ${reflectionRecordPublications}
      where ${reflectionRecordPublications.recordId} = ${reflectionRecords.recordId}
        and ${reflectionRecordPublications.representation} = ${input.representation}
        and ${reflectionRecordPublications.representationGeneration}
          = ${reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration}
        and ${reflectionRecordPublications.state} = 'complete'
    )`;
    const protectedAuthorityComplete = sql`exists (
      select 1 from ${reflectionRecordAuthorityReconciliations}
      where ${reflectionRecordAuthorityReconciliations.recordId} = ${reflectionRecords.recordId}
        and ${reflectionRecordAuthorityReconciliations.targetRepresentationGeneration}
          = ${reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration}
        and ${reflectionRecordAuthorityReconciliations.targetCryptoObjectId}
          = ${reflectionRecordPayloadRepresentations.cryptoObjectId}
        and ${reflectionRecordAuthorityReconciliations.state} = 'complete'
    )`;
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecords.recordId,
        lifecycle: reflectionRecords.lifecycle,
        structural_height: reflectionRecords.structuralHeight,
        processing_generation: reflectionRecords.processingGeneration,
        producer_policy_version: reflectionRecords.producerPolicyVersion,
        disposition: reflectionRecords.disposition,
        current_representation_generation:
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        plaintext_payload_bytes:
          reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
        crypto_object_id: reflectionRecordPayloadRepresentations.cryptoObjectId,
      })
        .from(reflectionRecords)
        .leftJoin(reflectionRecordPayloadRepresentationHeads, and(
          eq(
            reflectionRecordPayloadRepresentationHeads.recordId,
            reflectionRecords.recordId,
          ),
          eq(
            reflectionRecordPayloadRepresentationHeads.representation,
            input.representation,
          ),
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
          eq(reflectionRecords.recordId, input.recordId),
          input.representation === "ordinary"
            ? undefined
            : or(protectedPublicationComplete, protectedAuthorityComplete),
        ))
        .limit(1));
    if (rows.length === 0) {
      const state = await executeTypedRecordProductQuery(this.handle,
        recordProductTypedDb.select({ disposition: reflectionRecords.disposition })
          .from(reflectionRecords)
          .where(eq(reflectionRecords.recordId, input.recordId)));
      if (state.length === 0) return { status: "unavailable", reason: "not_found" };
      const disposition = rowString(state[0]!, "disposition");
      return { status: "unavailable", reason: disposition === "blocked" || disposition === "purged" ? disposition : "selected_representation_missing" };
    }
    const row = rows[0]!;
    const disposition = rowString(row, "disposition");
    if (disposition === "blocked" || disposition === "purged") return { status: "unavailable", reason: disposition };
    if (row["current_representation_generation"] === null) return { status: "unavailable", reason: "selected_representation_missing" };
    return { status: "available", row: { recordId: rowString(row, "record_id"), lifecycle: lifecycle(rowString(row, "lifecycle")), structuralHeight: rowInteger(row, "structural_height"), processingGeneration: rowInteger(row, "processing_generation"), producerPolicyVersion: rowString(row, "producer_policy_version"), representation: input.representation, representationGeneration: rowInteger(row, "current_representation_generation"), ...(row["plaintext_payload_bytes"] instanceof Uint8Array ? { payloadBytes: row["plaintext_payload_bytes"] } : {}), ...(typeof row["crypto_object_id"] === "string" ? { cryptoObjectId: row["crypto_object_id"] } : {}) } };
  }

  async readGraphPage(input: Readonly<{ recordId: string; direction: "dependencies" | "parents" | "successors" | "predecessors"; limit: number; continuation?: string }>): Promise<Readonly<{ items: readonly string[] | readonly SuccessorEdge[]; continuation?: string }>> {
    const offset = input.continuation === undefined ? 0 : Number(input.continuation);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid Record continuation");
    const pageSize = input.limit + 1;
    const isSuccessorEdge = input.direction === "successors"
      || input.direction === "predecessors";
    const rows = input.direction === "dependencies"
      ? await executeTypedRecordProductQuery(this.handle,
        recordProductTypedDb.select({
          value: sql`${reflectionRecordDependencies.childRecordId}`
            .as("value"),
        }).from(reflectionRecordDependencies).where(eq(
          reflectionRecordDependencies.parentRecordId,
          input.recordId,
        )).orderBy(asc(reflectionRecordDependencies.childRecordId))
          .limit(pageSize).offset(offset))
      : input.direction === "parents"
        ? await executeTypedRecordProductQuery(this.handle,
          recordProductTypedDb.select({
            value: sql`${reflectionRecordDependencies.parentRecordId}`
              .as("value"),
          }).from(reflectionRecordDependencies).where(eq(
            reflectionRecordDependencies.childRecordId,
            input.recordId,
          )).orderBy(asc(reflectionRecordDependencies.parentRecordId))
            .limit(pageSize).offset(offset))
        : await executeTypedRecordProductQuery(this.handle,
          recordProductTypedDb.select({
            predecessor_record_id: reflectionRecordSuccessors.predecessorRecordId,
            successor_record_id: reflectionRecordSuccessors.successorRecordId,
            relation: reflectionRecordSuccessors.relation,
          }).from(reflectionRecordSuccessors).where(eq(
            input.direction === "successors"
              ? reflectionRecordSuccessors.predecessorRecordId
              : reflectionRecordSuccessors.successorRecordId,
            input.recordId,
          )).orderBy(asc(
            input.direction === "successors"
              ? reflectionRecordSuccessors.successorRecordId
              : reflectionRecordSuccessors.predecessorRecordId,
          )).limit(pageSize).offset(offset));
    const selected = rows.slice(0, input.limit);
    const items = isSuccessorEdge
      ? selected.map((row) => ({ predecessorRecordRef: rowString(row, "predecessor_record_id"), successorRecordRef: rowString(row, "successor_record_id"), relation: rowString(row, "relation") as "supersedes" | "resolves" }))
      : selected.map((row) => rowString(row, "value"));
    return { items, ...(rows.length > input.limit ? { continuation: String(offset + input.limit) } : {}) };
  }

  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult> { return this.#dispose(input, "blocked"); }

  async purge(input: DirectRecordDispositionMutation): Promise<
    DirectRecordDispositionResult & {
      protectedRetirements?: readonly ProtectedRecordRetirement[];
    }
  > {
    const result = await this.#dispose(input, "purged");
    if (result.status !== "purged") return result;

    // Ordinary bytes can disappear immediately. Protected mappings remain the
    // durable retirement queue until the crypto object is verifiably retired.
    await this.handle.transaction(async (tx) => {
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .delete(reflectionRecordPayloadRepresentationHeads)
        .where(and(
          eq(reflectionRecordPayloadRepresentationHeads.recordId, input.recordRef),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
        )));
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .delete(reflectionRecordPayloadRepresentations)
        .where(and(
          eq(reflectionRecordPayloadRepresentations.recordId, input.recordRef),
          eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
        )));
    }, { isolationLevel: "serializable" });
    const retirements = await this.#protectedRetirementsForRecord(input.recordRef);
    return {
      ...result,
      ...(retirements.length === 0
        ? {}
        : { protectedRetirements: retirements }),
    };
  }

  claimDueProtected(
    limit: number,
    options?: Readonly<{ requireReservedOutput?: boolean }>,
  ): Promise<readonly import("./contracts").ClaimedProtectedRecordPublication[]> {
    return this.handle.transaction(async (tx) => {
      const reservedOutputPredicate = options?.requireReservedOutput === true
        ? "AND reserved_crypto_object_id IS NOT NULL"
        : "";
      const rows = await tx.query(
        `WITH candidates AS (
           SELECT publication_id
             FROM reflection_record_publications
            WHERE representation = 'protected'
              AND state IN ('reserved', 'crypto_complete', 'product_attached')
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              AND (lease_expires_at IS NULL OR lease_expires_at <= now())
              ${reservedOutputPredicate}
            ORDER BY created_at, publication_id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE reflection_record_publications AS publication
            SET lease_token = gen_random_uuid(),
                lease_expires_at = now() + interval '2 minutes',
                updated_at = now()
           FROM candidates
          WHERE publication.publication_id = candidates.publication_id
        RETURNING publication.publication_id, publication.record_id,
                  publication.state, publication.crypto_object_id,
                  publication.reserved_crypto_object_id,
                  publication.lease_token, publication.publication_binding_ref,
                  publication.origin_publication_binding_ref,
                  publication.request_commitment,
                  publication.replay_structural_height,
                  publication.replay_processing_generation,
                  publication.replay_predecessor_record_id,
                  publication.replay_predecessor_relation`,
        [limit],
      );
      return rows.map((row) => {
        const structuralHeight = row["replay_structural_height"];
        const processingGeneration = row["replay_processing_generation"];
        const predecessorRecordId = row["replay_predecessor_record_id"];
        const predecessorRelation = row["replay_predecessor_relation"];
        const predecessorValid = (
          predecessorRecordId === null && predecessorRelation === null
        ) || (
          typeof predecessorRecordId === "string"
          && (predecessorRelation === "supersedes" || predecessorRelation === "resolves")
        );
        const replayAvailable = (
          (typeof structuralHeight === "number" || typeof structuralHeight === "bigint")
          && Number.isSafeInteger(Number(structuralHeight))
          && Number(structuralHeight) >= 0
          && (typeof processingGeneration === "number" || typeof processingGeneration === "bigint")
          && Number.isSafeInteger(Number(processingGeneration))
          && Number(processingGeneration) >= 1
          && predecessorValid
        );
        return {
          idempotencyKey: rowString(row, "publication_id"),
          recordId: rowString(row, "record_id"),
          state: rowString(row, "state") as "reserved" | "crypto_complete" | "product_attached",
          leaseToken: rowString(row, "lease_token"),
          ...(typeof row["crypto_object_id"] === "string"
            ? { cryptoObjectId: row["crypto_object_id"] }
            : {}),
          ...(typeof row["reserved_crypto_object_id"] === "string"
            ? { reservedCryptoObjectId: row["reserved_crypto_object_id"] }
            : {}),
          ...(replayAvailable
            ? {
                replay: {
                  publicationBindingRef: rowString(row, "publication_binding_ref"),
                  ...(typeof row["origin_publication_binding_ref"] === "string"
                    ? { originPublicationBindingRef: row["origin_publication_binding_ref"] }
                    : {}),
                  requestCommitment: rowBytes(row, "request_commitment").slice(),
                  structuralHeight: Number(structuralHeight),
                  processingGeneration: Number(processingGeneration),
                  ...(typeof predecessorRecordId === "string"
                    ? {
                        predecessor: {
                          recordRef: predecessorRecordId,
                          relation: predecessorRelation as "supersedes" | "resolves",
                        },
                      }
                    : {}),
                },
              }
            : {}),
        };
      });
    }, { isolationLevel: "read committed" });
  }

  async listDueProtectedRetirements(
    limit: number,
  ): Promise<readonly ProtectedRecordRetirement[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Protected Record retirement limit must be 1..256");
    }
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        publication_id: reflectionRecordPublications.publicationId,
        record_id: reflectionRecordPublications.recordId,
        representation_generation: reflectionRecordPublications.representationGeneration,
        crypto_object_id: reflectionRecordPublications.cryptoObjectId,
      })
        .from(reflectionRecordPublications)
        .leftJoin(reflectionRecords, eq(
          reflectionRecords.recordId,
          reflectionRecordPublications.recordId,
        ))
        .leftJoin(reflectionRecordPayloadRepresentations, and(
          eq(
            reflectionRecordPayloadRepresentations.recordId,
            reflectionRecordPublications.recordId,
          ),
          eq(reflectionRecordPayloadRepresentations.representation, "protected"),
          eq(
            reflectionRecordPayloadRepresentations.representationGeneration,
            reflectionRecordPublications.representationGeneration,
          ),
          eq(
            reflectionRecordPayloadRepresentations.cryptoObjectId,
            reflectionRecordPublications.cryptoObjectId,
          ),
        ))
        .where(and(
          eq(reflectionRecordPublications.representation, "protected"),
          isNotNull(reflectionRecordPublications.cryptoObjectId),
          isNull(reflectionRecordPublications.cryptoRetiredAt),
          or(
            eq(reflectionRecords.disposition, "purged"),
            and(
              inArray(reflectionRecordPublications.state, [
                "blocked",
                "quarantined",
                "retry_exhausted",
              ]),
              isNull(reflectionRecordPayloadRepresentations.recordId),
            ),
          ),
        ))
        .orderBy(
          asc(reflectionRecordPublications.createdAt),
          asc(reflectionRecordPublications.publicationId),
        )
        .limit(limit));
    return rows.map((row) => this.#retirementFromRow(row));
  }

  completeProtectedRetirement(
    input: ProtectedRecordRetirement,
  ): Promise<"completed" | "replayed" | "conflict"> {
    return this.#serializable(async (tx) => {
      await this.#lock(tx, [input.idempotencyKey, input.recordId]);
      const rows = await tx.query(
        `SELECT publication.record_id,
                publication.representation_generation,
                publication.crypto_object_id,
                publication.crypto_retired_at,
                record.disposition
           FROM reflection_record_publications AS publication
           LEFT JOIN reflection_records AS record
             ON record.record_id = publication.record_id
          WHERE publication.publication_id = $1
          FOR UPDATE OF publication`,
        [input.idempotencyKey],
      );
      if (rows.length !== 1) return "conflict";
      const row = rows[0]!;
      if (
        rowString(row, "record_id") !== input.recordId
        || rowInteger(row, "representation_generation")
          !== input.representationGeneration
        || row["crypto_object_id"] !== input.cryptoObjectId
      ) return "conflict";
      if (row["crypto_retired_at"] instanceof Date) return "replayed";

      const representationRows = await tx.query(
        `SELECT 1 AS found
           FROM reflection_record_payload_representations
          WHERE record_id = $1
            AND representation = 'protected'
            AND representation_generation = $2
            AND crypto_object_id = $3
          FOR UPDATE`,
        [input.recordId, input.representationGeneration, input.cryptoObjectId],
      );
      if (representationRows.length > 0) {
        if (row["disposition"] !== "purged") return "conflict";
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .delete(reflectionRecordPayloadRepresentationHeads)
          .where(and(
            eq(reflectionRecordPayloadRepresentationHeads.recordId, input.recordId),
            eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
            eq(
              reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
              input.representationGeneration,
            ),
          )));
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .delete(reflectionRecordPayloadRepresentations)
          .where(and(
            eq(reflectionRecordPayloadRepresentations.recordId, input.recordId),
            eq(reflectionRecordPayloadRepresentations.representation, "protected"),
            eq(
              reflectionRecordPayloadRepresentations.representationGeneration,
              input.representationGeneration,
            ),
            eq(
              reflectionRecordPayloadRepresentations.cryptoObjectId,
              input.cryptoObjectId,
            ),
          )));
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({ cryptoRetiredAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(
          reflectionRecordPublications.publicationId,
          input.idempotencyKey,
        )));
      return "completed";
    });
  }

  async #protectedRetirementsForRecord(
    recordId: string,
  ): Promise<readonly ProtectedRecordRetirement[]> {
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        publication_id: reflectionRecordPublications.publicationId,
        record_id: reflectionRecordPublications.recordId,
        representation_generation: reflectionRecordPublications.representationGeneration,
        crypto_object_id: reflectionRecordPublications.cryptoObjectId,
      })
        .from(reflectionRecordPublications)
        .where(and(
          eq(reflectionRecordPublications.recordId, recordId),
          eq(reflectionRecordPublications.representation, "protected"),
          isNotNull(reflectionRecordPublications.cryptoObjectId),
          isNull(reflectionRecordPublications.cryptoRetiredAt),
        ))
        .orderBy(
          asc(reflectionRecordPublications.representationGeneration),
          asc(reflectionRecordPublications.publicationId),
        ));
    return rows.map((row) => this.#retirementFromRow(row));
  }

  #retirementFromRow(row: RecordProductPostgresRow): ProtectedRecordRetirement {
    return {
      idempotencyKey: rowString(row, "publication_id"),
      recordId: rowString(row, "record_id"),
      representationGeneration: rowInteger(row, "representation_generation"),
      cryptoObjectId: rowString(row, "crypto_object_id"),
    };
  }

  async #dispose(input: DirectRecordDispositionMutation, target: "blocked" | "purged"): Promise<DirectRecordDispositionResult> {
    return this.#serializable(async (tx) => {
      await this.#lock(tx, [input.recordRef]);
      const rows = await tx.query(
        `SELECT disposition, processing_generation
           FROM reflection_records
          WHERE record_id = $1
          FOR UPDATE`,
        [input.recordRef],
      );
      const receipts = await tx.query(`SELECT publication_id FROM reflection_record_publications WHERE record_id = $1 FOR UPDATE`, [input.recordRef]);
      if (rows.length === 0 && receipts.length === 0) return { status: "not_found", recordRef: input.recordRef, replayed: false };
      const replayed = rows.length > 0 && rowString(rows[0]!, "disposition") === target;
      if (rows.length > 0) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecords)
          .set({ disposition: target, updatedAt: sql`now()` })
          .where(eq(reflectionRecords.recordId, input.recordRef)));
        if (!replayed) {
          await this.semanticWork?.recordChangedWithinTransaction(tx, {
            recordRef: input.recordRef,
            changeRef:
              `disposition:${target}:v${rowInteger(rows[0]!, "processing_generation")}`,
          });
        }
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordPublications)
        .set({
          state: "blocked",
          failureCode: target,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(reflectionRecordPublications.recordId, input.recordRef),
          ne(reflectionRecordPublications.state, "complete"),
        )));
      // The embedding is a rebuildable plaintext exception, not canonical
      // Record history. Purge must make it disappear in the same product
      // transaction that advances the direct Record disposition so no search
      // can observe a purged Record through an orphaned projection.
      if (target === "purged") {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .delete(reflectionRecordSearchProjections)
          .where(eq(reflectionRecordSearchProjections.recordId, input.recordRef)));
      }
      return { status: target, recordRef: input.recordRef, replayed };
    });
  }

  async #publicationReplay(tx: RecordProductPostgresExecutor, publication: DurableRecordPublication, commitment: Uint8Array, representation: "ordinary" | "protected"): Promise<DurableRecordPublicationResult | null> {
    await this.#lock(tx, [publication.idempotencyKey, publication.record.recordRef]);
    const rows = await tx.query(`SELECT record_id, representation, request_commitment, state FROM reflection_record_publications WHERE publication_id = $1 FOR UPDATE`, [publication.idempotencyKey]);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (rowString(row, "record_id") !== publication.record.recordRef || rowString(row, "representation") !== representation || !sameBytes(rowBytes(row, "request_commitment"), commitment)) return { status: "rejected", recordRef: publication.record.recordRef, reason: "idempotency_conflict" };
    if (rowString(row, "state") !== "complete") {
      return {
        status: "rejected",
        recordRef: publication.record.recordRef,
        reason: "structural_conflict",
        structuralReason: "publication_incomplete",
      };
    }
    const dispositionRows = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({ disposition: reflectionRecords.disposition })
        .from(reflectionRecords)
        .where(eq(reflectionRecords.recordId, publication.record.recordRef)));
    if (dispositionRows.length === 1) {
      const disposition = rowString(dispositionRows[0]!, "disposition");
      if (disposition === "blocked" || disposition === "purged") {
        return { status: "rejected", recordRef: publication.record.recordRef, reason: disposition };
      }
    }
    return { status: "replayed", record: publication.record };
  }

  async #validateGraph(
    tx: RecordProductPostgresExecutor,
    publication: DurableRecordPublication,
  ): Promise<DurableRecordStructuralRejection | null> {
    const record = publication.record;
    const lockIds = [record.recordRef, ...record.semantic.childRecordRefs, ...(publication.predecessor === undefined ? [] : [publication.predecessor.recordRef])].sort();
    await this.#lock(tx, lockIds);
    const existing = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({ record_id: reflectionRecords.recordId })
        .from(reflectionRecords)
        .where(eq(reflectionRecords.recordId, record.recordRef)));
    if (existing.length > 0) return "record_already_exists";
    if (
      record.lifecycle !== "current"
      || new Set(record.semantic.childRecordRefs).size
        !== record.semantic.childRecordRefs.length
      || record.semantic.childRecordRefs.includes(record.recordRef)
    ) return "invalid_record_shape";
    const children = record.semantic.childRecordRefs.length === 0 ? [] : await tx.query(`SELECT record_id, structural_height, disposition FROM reflection_records WHERE record_id = ANY($1::text[]) ORDER BY record_id FOR SHARE`, [record.semantic.childRecordRefs]);
    if (
      children.length !== record.semantic.childRecordRefs.length
      || children.some((row) => rowString(row, "disposition") !== "available")
    ) return "child_unavailable";
    if (record.semantic.childRecordRefs.length > 0) {
      // Every publication that can parent a Record holds the same advisory
      // child lock before inspecting this current-graph projection. A
      // successor may replace its own predecessor as the unique parent in the
      // same transaction; no other current parent is legal. Historical edges
      // remain immutable and are deliberately ignored here.
      const currentParents = await tx.query(
        `SELECT dependency.child_record_id,
                array_agg(parent.record_id ORDER BY parent.record_id)
                  AS current_parent_ids
           FROM reflection_record_dependencies AS dependency
           JOIN reflection_records AS parent
             ON parent.record_id = dependency.parent_record_id
          WHERE dependency.child_record_id = ANY($1::text[])
            AND parent.disposition = 'available'
            AND parent.lifecycle = 'current'
          GROUP BY dependency.child_record_id
          ORDER BY dependency.child_record_id`,
        [record.semantic.childRecordRefs],
      );
      const replaceableParent = publication.predecessor?.recordRef;
      for (const row of currentParents) {
        const rawParentIds = row["current_parent_ids"];
        if (
          !Array.isArray(rawParentIds)
          || rawParentIds.some((value) => typeof value !== "string")
          || rawParentIds.length !== 1
          || rawParentIds[0] !== replaceableParent
        ) return "child_parent_changed";
      }
    }
    const expectedHeight = children.length === 0 ? 0 : 1 + Math.max(...children.map((row) => rowInteger(row, "structural_height")));
    if (record.structuralHeight !== expectedHeight) return "height_mismatch";
    if (record.semantic.childRecordRefs.length > 1) {
      const ancestors = await tx.query(`WITH RECURSIVE walk(root_id, node_id) AS (SELECT parent_record_id, child_record_id FROM reflection_record_dependencies WHERE parent_record_id = ANY($1::text[]) UNION SELECT walk.root_id, edge.child_record_id FROM walk JOIN reflection_record_dependencies edge ON edge.parent_record_id = walk.node_id) SELECT 1 AS found FROM walk WHERE node_id = ANY($1::text[]) AND root_id <> node_id LIMIT 1`, [record.semantic.childRecordRefs]);
      if (ancestors.length > 0) return "ancestor_cycle";
    }
    if (publication.predecessor !== undefined) {
      const predecessor = await tx.query(`SELECT lifecycle, disposition FROM reflection_records WHERE record_id = $1 FOR UPDATE`, [publication.predecessor.recordRef]);
      if (predecessor.length !== 1 || !["current", "stale"].includes(rowString(predecessor[0]!, "lifecycle")) || rowString(predecessor[0]!, "disposition") !== "available") return "predecessor_changed";
      const priorEdge = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({ found: sql<number>`1`.as("found") })
          .from(reflectionRecordSuccessors)
          .where(or(
            eq(
              reflectionRecordSuccessors.predecessorRecordId,
              publication.predecessor.recordRef,
            ),
            eq(reflectionRecordSuccessors.successorRecordId, record.recordRef),
          ))
          .limit(1));
      if (priorEdge.length > 0) return "successor_changed";
    }
    return null;
  }

  async #insertGraph(tx: RecordProductPostgresExecutor, publication: DurableRecordPublication): Promise<void> {
    const record = publication.record;
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecords)
      .values({
        recordId: record.recordRef,
        lifecycle: record.lifecycle,
        structuralHeight: record.structuralHeight,
        producerPolicyVersion: record.semantic.producer.policyVersion,
        processingGeneration: record.processingGeneration,
        payloadVersion: 1,
        disposition: "available",
      }));
    if (record.semantic.childRecordRefs.length > 0) {
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordDependencies)
        .values(record.semantic.childRecordRefs.map((childRecordId) => ({
          parentRecordId: record.recordRef,
          childRecordId,
        }))));
    }
    if (publication.predecessor !== undefined) {
      const terminal = publication.predecessor.relation === "supersedes" ? "superseded" : "resolved";
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecords)
        .set({
          lifecycle: terminal,
          processingGeneration: sql`${reflectionRecords.processingGeneration} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(
          reflectionRecords.recordId,
          publication.predecessor.recordRef,
        )));
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordSuccessors)
        .values({
          predecessorRecordId: publication.predecessor.recordRef,
          successorRecordId: record.recordRef,
          relation: publication.predecessor.relation,
        }));
    }
    await this.semanticWork?.attachPublicationWithinTransaction(tx, publication);
  }

  async #lock(tx: RecordProductPostgresExecutor, ids: readonly string[]): Promise<void> {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(lock_id, 0))
         FROM (
           SELECT DISTINCT lock_id
             FROM unnest($1::text[]) AS lock_id
            ORDER BY lock_id
         ) AS ordered_locks`,
      [[...new Set(ids)]],
    );
  }

  async #serializable<Result>(callback: (tx: RecordProductPostgresExecutor) => Promise<Result>): Promise<Result> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try { return await this.handle.transaction(callback, { isolationLevel: "serializable" }); }
      catch (error) { if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error; }
    }
    throw new Error("Unreachable Record transaction state");
  }
}
