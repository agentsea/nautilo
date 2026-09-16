import {
  assertPortableRecordSearchIdentifier,
  assertPositiveSafeInteger,
  validateRecordSearchProjectionV1,
  type RecordEmbeddingPort,
  type RecordSearchProjectionMutationPort,
  type RecordSearchProjectionPublishRequest,
  type RecordSearchProjectionRemoveRequest,
  type RecordSearchProjectionReplaceRequest,
  type RecordSearchProjectionMutationResult,
} from "@nautilo/reflection/search";

import type { RecordRepositoryPort } from "./contracts";
import type { PostgresRecordSearchProjectionStore } from "./postgres-record-search-projection-store";

/** Opens the selected ordinary/protected representation before provider disclosure. */
export class DualModeRecordSearchProjectionPublisher
implements RecordSearchProjectionMutationPort {
  constructor(private readonly ports: Readonly<{
    repository: RecordRepositoryPort;
    embedding: RecordEmbeddingPort;
    projections: PostgresRecordSearchProjectionStore;
  }>) {}

  async publish(
    input: RecordSearchProjectionPublishRequest,
  ): Promise<RecordSearchProjectionMutationResult> {
    return this.#publish(input, undefined);
  }

  async replace(
    input: RecordSearchProjectionReplaceRequest,
  ): Promise<RecordSearchProjectionMutationResult> {
    return this.#publish(input, input.expectedProjectionGeneration);
  }

  async #publish(
    input: RecordSearchProjectionPublishRequest,
    expectedProjectionGeneration: number | undefined,
  ): Promise<RecordSearchProjectionMutationResult> {
    try {
      assertPortableRecordSearchIdentifier("Record projection reference", input.recordRef);
      assertPositiveSafeInteger(
        "Record processing generation",
        input.recordProcessingGeneration,
      );
      assertPositiveSafeInteger("projection generation", input.projectionGeneration);
      if (input.projectionVersion !== 1) throw new TypeError("invalid projection version");
    } catch {
      return { status: "rejected", reason: "invalid_projection" };
    }
    const opened = await this.ports.repository.read({
      recordRef: input.recordRef,
      readBindingRef: input.projectionBindingRef,
    });
    if (
      opened.status !== "available"
      || opened.record.processingGeneration !== input.recordProcessingGeneration
    ) return { status: "rejected", reason: "record_unavailable" };
    const embedded = await this.ports.embedding.embed({
      purpose: "record.statement_embedding",
      plaintext: opened.record.semantic.statement,
    });
    if (embedded.status !== "available") {
      return { status: "rejected", reason: "invalid_projection" };
    }
    const projection = {
      recordRef: input.recordRef,
      recordProcessingGeneration: input.recordProcessingGeneration,
      projectionVersion: input.projectionVersion,
      projectionGeneration: input.projectionGeneration,
      embedding: embedded.embedding,
    } as const;
    try {
      validateRecordSearchProjectionV1(projection);
    } catch {
      return { status: "rejected", reason: "invalid_projection" };
    }
    const result = expectedProjectionGeneration === undefined
      ? await this.ports.projections.publish(projection)
      : await this.ports.projections.replace({ expectedProjectionGeneration, projection });
    if (result === "published" || result === "replayed" || result === "replaced") {
      return { status: result, projectionGeneration: projection.projectionGeneration };
    }
    return {
      status: "rejected",
      reason: result === "record_unavailable"
        ? "record_unavailable"
        : result === "stale"
          ? "generation_conflict"
          : "conflict",
    };
  }

  async remove(input: RecordSearchProjectionRemoveRequest): Promise<
    | { readonly status: "removed" | "absent" }
    | { readonly status: "rejected"; readonly reason: "generation_conflict" | "record_unavailable" }
  > {
    const opened = await this.ports.repository.read({
      recordRef: input.recordRef,
      readBindingRef: input.projectionBindingRef,
    });
    if (opened.status !== "available") {
      return { status: "rejected", reason: "record_unavailable" };
    }
    const removed = await this.ports.projections.remove({
      recordRef: input.recordRef,
      ...(input.expectedProjectionGeneration === undefined
        ? {}
        : { expectedProjectionGeneration: input.expectedProjectionGeneration }),
    });
    return removed === "stale"
      ? { status: "rejected", reason: "generation_conflict" }
      : { status: removed === "removed" ? "removed" : "absent" };
  }
}
