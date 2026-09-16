import {
  assertChangedRecordSupport,
  assertDurableRecordPageRequest,
  type HierarchyStructuralRecord,
  type DurableRecordEnvelope,
  type DirectRecordDispositionMutation,
  type DirectRecordDispositionResult,
  type DurableRecordLifecycleMutation,
  type DurableRecordLifecycleMutationResult,
  type DurableRecordPageRequest,
  type DurableRecordPageResult,
  type DurableRecordPublication,
  type DurableRecordPublicationResult,
  type DurableRecordReadRequest,
  type DurableRecordReadResult,
  type RecordRef,
  type SuccessorEdge,
} from "@nautilo/reflection/durable";

import { decodeDurableRecordEnvelope, encodeDurableRecordEnvelope } from "./record-mapping";
import { RecordRepositoryError } from "./contracts";
import type {
  ProtectedRecordPublicationPort,
  RecordProductStorePort,
  RecordRepositoryPort,
  RecordRepositorySelection,
  RecordRequestCommitmentPort,
} from "./contracts";

function assertSelection(selection: RecordRepositorySelection): void {
  if (
    (selection.selectedRepresentation !== "ordinary"
      && selection.selectedRepresentation !== "protected")
    || !Number.isSafeInteger(selection.migrationGeneration)
    || selection.migrationGeneration < 1
  ) {
    throw new TypeError("Record repository selection is invalid");
  }
}

function structural(record: DurableRecordEnvelope): HierarchyStructuralRecord {
  return {
    recordRef: record.recordRef,
    lifecycle: record.lifecycle,
    structuralHeight: record.structuralHeight,
    statement: record.semantic.statement,
    anchorRefs: record.semantic.anchors.map((anchor) => anchor.anchorRef),
    sourceRefs: record.semantic.sourceDependencies.map((source) => source.logicalSourceRef),
    childRecordRefs: record.semantic.childRecordRefs,
  };
}

export interface DualModeRecordRepositoryOptions {
  readonly selection: RecordRepositorySelection;
  readonly product: RecordProductStorePort;
  readonly commitment: RecordRequestCommitmentPort;
  readonly protectedPublication?: ProtectedRecordPublicationPort;
}

/** One logical repository; server migration state selects representation only. */
export class DualModeRecordRepository implements RecordRepositoryPort {
  readonly #selection: RecordRepositorySelection;
  readonly #product: RecordProductStorePort;
  readonly #commitment: RecordRequestCommitmentPort;
  readonly #protected: ProtectedRecordPublicationPort | undefined;

  constructor(options: DualModeRecordRepositoryOptions) {
    assertSelection(options.selection);
    if (
      options.selection.selectedRepresentation === "protected"
      && options.protectedPublication === undefined
    ) {
      throw new TypeError("Protected Record selection requires a crypto publication port");
    }
    this.#selection = Object.freeze({ ...options.selection });
    this.#product = options.product;
    this.#commitment = options.commitment;
    this.#protected = options.protectedPublication;
  }

  async publish(
    publication: DurableRecordPublication,
  ): Promise<DurableRecordPublicationResult> {
    return this.#guard(() => this.#publish(publication));
  }

  async transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult> {
    return this.#guard(() => this.#product.transitionLifecycle(input));
  }

  async #publish(
    publication: DurableRecordPublication,
  ): Promise<DurableRecordPublicationResult> {
    if (publication.predecessor !== undefined) {
      const predecessor = await this.read({
        recordRef: publication.predecessor.recordRef,
        readBindingRef: publication.publicationBindingRef,
      });
      if (predecessor.status !== "available") {
        return {
          status: "rejected",
          recordRef: publication.record.recordRef,
          reason: predecessor.reason === "unauthorized"
            ? "publication_binding_invalid"
            : "structural_conflict",
        };
      }
      try {
        assertChangedRecordSupport(
          structural(predecessor.record),
          structural(publication.record),
        );
      } catch {
        return {
          status: "rejected",
          recordRef: publication.record.recordRef,
          reason: "structural_conflict",
        };
      }
    }
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = encodeDurableRecordEnvelope(publication.record);
    } catch {
      return {
        status: "rejected",
        recordRef: publication.record.recordRef,
        reason: "invalid_publication",
      };
    }
    const requestCommitment = this.#commitment.commit(payloadBytes, publication);
    if (requestCommitment.byteLength !== 32) {
      throw new TypeError("Record request commitment must be 32 bytes");
    }
    if (this.#selection.selectedRepresentation === "ordinary") {
      return this.#product.publishOrdinary({
        publication,
        payloadBytes,
        requestCommitment,
      });
    }

    const crypto = this.#protected!;
    const reservation = await this.#product.reserveProtected({
      publication,
      requestCommitment,
    });
    if (reservation.status === "conflict") {
      return { status: "rejected", recordRef: publication.record.recordRef, reason: "idempotency_conflict" };
    }
    if (reservation.status === "blocked" || reservation.status === "purged") {
      return { status: "rejected", recordRef: publication.record.recordRef, reason: reservation.status };
    }
    if (reservation.status === "replayed" && reservation.state === "complete") {
      return { status: "replayed", record: publication.record };
    }

    let objectId = reservation.status === "replayed"
      ? reservation.cryptoObjectId
      : undefined;
    if (objectId !== undefined) {
      const verified = await crypto.verify({
        objectId,
        recordId: publication.record.recordRef,
        representationGeneration: 1,
      });
      if (verified !== "complete") {
        await this.#product.failProtected({
          idempotencyKey: publication.idempotencyKey,
          recordId: publication.record.recordRef,
          failureCode: verified === "absent"
            ? "crypto_absent"
            : verified === "incomplete"
              ? "crypto_incomplete"
              : "crypto_mismatch",
          terminal: verified === "mismatch",
        });
        return {
          status: "rejected",
          recordRef: publication.record.recordRef,
          reason: "publication_binding_invalid",
        };
      }
    }
    if (objectId === undefined) {
      const published = await crypto.publish({
        recordId: publication.record.recordRef,
        representationGeneration: 1,
        payloadBytes,
        publicationBindingRef: publication.publicationBindingRef,
      });
      if (published.status === "unavailable") {
        await this.#product.failProtected({
          idempotencyKey: publication.idempotencyKey,
          recordId: publication.record.recordRef,
          failureCode: published.reason,
          terminal: published.reason === "crypto_mismatch",
        });
        return {
          status: "rejected",
          recordRef: publication.record.recordRef,
          reason: "publication_binding_invalid",
        };
      }
      objectId = published.objectId;
      const marked = await this.#product.markProtectedCryptoComplete({
        idempotencyKey: publication.idempotencyKey,
        recordId: publication.record.recordRef,
        cryptoObjectId: objectId,
      });
      if (marked === "blocked" || marked === "conflict") {
        await crypto.retire(objectId);
        return {
          status: "rejected",
          recordRef: publication.record.recordRef,
          reason: marked === "blocked" ? "blocked" : "structural_conflict",
        };
      }
    }

    const attached = await this.#product.attachProtected({
      publication,
      cryptoObjectId: objectId,
      requestCommitment,
    });
    if (attached === "blocked" || attached === "conflict") {
      await crypto.retire(objectId);
      return {
        status: "rejected",
        recordRef: publication.record.recordRef,
        reason: attached === "blocked" ? "blocked" : "structural_conflict",
      };
    }
    const completed = await this.#product.completeProtected({
      idempotencyKey: publication.idempotencyKey,
      recordId: publication.record.recordRef,
    });
    if (completed === "blocked" || completed === "conflict") {
      return {
        status: "rejected",
        recordRef: publication.record.recordRef,
        reason: completed === "blocked" ? "blocked" : "structural_conflict",
      };
    }
    return {
      status: reservation.status === "replayed" ? "replayed" : "published",
      record: publication.record,
    };
  }

  async read(input: DurableRecordReadRequest): Promise<DurableRecordReadResult> {
    return this.#guard(() => this.#read(input));
  }

  /**
   * Resolve a completed publication receipt through the selected
   * representation, then perform the ordinary authority-bound Record read.
   * The receipt is only an idempotency coordinate; it never grants access.
   */
  async readCompletedPublication(input: Readonly<{
    idempotencyKey: string;
    readBindingRef: string;
  }>): Promise<
    | { readonly status: "available"; readonly record: DurableRecordEnvelope }
    | {
        readonly status: "unavailable";
        readonly reason:
          | "not_found"
          | "incomplete"
          | "unauthorized"
          | "integrity_failure"
          | "blocked"
          | "purged";
      }
  > {
    return this.#guard(async () => {
      const completed = await this.#product.readCompletedPublicationRecordId({
        idempotencyKey: input.idempotencyKey,
      });
      if (completed.status === "unavailable") {
        return { status: "unavailable", reason: completed.reason };
      }
      const opened = await this.#read({
        recordRef: completed.recordId,
        readBindingRef: input.readBindingRef,
      });
      return opened.status === "available"
        ? opened
        : {
            status: "unavailable",
            reason: opened.reason === "selected_representation_missing"
              || opened.reason === "not_found"
              ? "integrity_failure"
              : opened.reason,
          };
    });
  }

  async #read(input: DurableRecordReadRequest): Promise<DurableRecordReadResult> {
    const selected = this.#selection.selectedRepresentation;
    const result = await this.#product.readVisible({
      recordId: input.recordRef,
      representation: selected,
    });
    if (result.status === "unavailable") {
      return { status: "unavailable", recordRef: input.recordRef, reason: result.reason };
    }
    let payloadBytes: Uint8Array;
    if (selected === "ordinary") {
      if (result.row.payloadBytes === undefined) {
        return { status: "unavailable", recordRef: input.recordRef, reason: "integrity_failure" };
      }
      payloadBytes = result.row.payloadBytes;
    } else {
      if (result.row.cryptoObjectId === undefined) {
        return { status: "unavailable", recordRef: input.recordRef, reason: "integrity_failure" };
      }
      const opened = await this.#protected!.open({
        objectId: result.row.cryptoObjectId,
        recordId: input.recordRef,
        representationGeneration: result.row.representationGeneration,
        readBindingRef: input.readBindingRef,
      });
      if (opened.status === "unavailable") {
        return {
          status: "unavailable",
          recordRef: input.recordRef,
          reason: opened.reason === "not_found" ? "integrity_failure" : opened.reason,
        };
      }
      payloadBytes = opened.payloadBytes;
    }
    try {
      const record = decodeDurableRecordEnvelope({
        recordRef: result.row.recordId,
        lifecycle: result.row.lifecycle,
        structuralHeight: result.row.structuralHeight,
        processingGeneration: result.row.processingGeneration,
        payloadBytes,
      });
      if (record.semantic.producer.policyVersion !== result.row.producerPolicyVersion) {
        return { status: "unavailable", recordRef: input.recordRef, reason: "integrity_failure" };
      }
      return {
        status: "available",
        record,
      };
    } catch {
      return { status: "unavailable", recordRef: input.recordRef, reason: "integrity_failure" };
    }
  }

  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult> {
    return this.#guard(() => this.#product.block(input));
  }

  async purge(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult> {
    return this.#guard(async () => {
      const result = await this.#product.purge(input);
      if (result.status !== "purged") return result;
      if (this.#protected !== undefined) {
        for (const retirement of result.protectedRetirements ?? []) {
          await this.#protected.retire(retirement.cryptoObjectId);
          const completed = await this.#product.completeProtectedRetirement(retirement);
          if (completed === "conflict") {
            throw new RecordRepositoryError("mapping_conflict");
          }
        }
      }
      return {
        status: "purged",
        recordRef: result.recordRef,
        replayed: result.replayed,
      };
    });
  }

  readDependencies(input: DurableRecordPageRequest): Promise<DurableRecordPageResult<RecordRef>> {
    assertDurableRecordPageRequest(input);
    return this.#guard(() => this.#readStringPage(input, "dependencies"));
  }

  readParents(input: DurableRecordPageRequest): Promise<DurableRecordPageResult<RecordRef>> {
    assertDurableRecordPageRequest(input);
    return this.#guard(() => this.#readStringPage(input, "parents"));
  }

  readSuccessors(input: DurableRecordPageRequest): Promise<DurableRecordPageResult<SuccessorEdge>> {
    assertDurableRecordPageRequest(input);
    return this.#guard(() => this.#readEdgePage(input, "successors"));
  }

  readPredecessors(input: DurableRecordPageRequest): Promise<DurableRecordPageResult<SuccessorEdge>> {
    assertDurableRecordPageRequest(input);
    return this.#guard(() => this.#readEdgePage(input, "predecessors"));
  }

  async #readStringPage(
    input: DurableRecordPageRequest,
    direction: "dependencies" | "parents",
  ): Promise<DurableRecordPageResult<RecordRef>> {
    assertDurableRecordPageRequest(input);
    const visible = await this.#product.readVisible({
      recordId: input.recordRef,
      representation: this.#selection.selectedRepresentation,
    });
    if (visible.status === "unavailable") {
      return { status: "unavailable", recordRef: input.recordRef, reason: visible.reason };
    }
    const page = await this.#product.readGraphPage({
      recordId: input.recordRef,
      direction,
      limit: input.limit,
      ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    });
    return { status: "available", page: { items: page.items as readonly string[], ...(page.continuation === undefined ? {} : { continuation: page.continuation }) } };
  }

  async #readEdgePage(
    input: DurableRecordPageRequest,
    direction: "successors" | "predecessors",
  ): Promise<DurableRecordPageResult<SuccessorEdge>> {
    assertDurableRecordPageRequest(input);
    const visible = await this.#product.readVisible({
      recordId: input.recordRef,
      representation: this.#selection.selectedRepresentation,
    });
    if (visible.status === "unavailable") {
      return { status: "unavailable", recordRef: input.recordRef, reason: visible.reason };
    }
    const page = await this.#product.readGraphPage({
      recordId: input.recordRef,
      direction,
      limit: input.limit,
      ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    });
    return { status: "available", page: { items: page.items as readonly SuccessorEdge[], ...(page.continuation === undefined ? {} : { continuation: page.continuation }) } };
  }

  async #guard<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RecordRepositoryError) throw error;
      throw new RecordRepositoryError("storage_transient");
    }
  }
}
