import {
  assertRecordEmbeddingRequest,
  assertRecordEmbeddingProvenanceV1,
  canonicalizeRecordEmbeddingV1,
  type RecordEmbeddingPort,
  type RecordEmbeddingRequest,
  type RecordEmbeddingResult,
} from "@nautilo/reflection/search";
import type {
  ProtectedAgentMemoryEmbeddingPort,
} from "@nautilo/lattice-bridge";

function unavailable(
  reason: Extract<RecordEmbeddingResult, { status: "unavailable" }>["reason"],
): RecordEmbeddingResult {
  return Object.freeze({ status: "unavailable", reason });
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Adapt the already-authorized Wave-15 foreground embedding disclosure.
 * This adapter owns no provider client, model default, fallback, credentials,
 * retry, or logging surface.
 */
export function createWave15RecordEmbeddingAdapter(
  port: ProtectedAgentMemoryEmbeddingPort,
): RecordEmbeddingPort {
  if (typeof port?.embed !== "function") {
    throw new TypeError("Record embedding requires the Wave-15 embedding port");
  }
  return Object.freeze({
    async embed(input: RecordEmbeddingRequest): Promise<RecordEmbeddingResult> {
      try {
        assertRecordEmbeddingRequest(input);
      } catch {
        return unavailable("invalid_response");
      }
      if (aborted(input.signal)) return unavailable("cancelled");
      let result: Awaited<ReturnType<ProtectedAgentMemoryEmbeddingPort["embed"]>>;
      try {
        result = await port.embed({
          purpose: input.purpose === "record.statement_embedding"
            ? "memory.content_embedding"
            : "memory.query_embedding",
          plaintext: input.plaintext,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        return unavailable(
          aborted(input.signal) ? "cancelled" : "provider_unavailable",
        );
      }
      if (aborted(input.signal)) return unavailable("cancelled");
      if (result.status !== "success") return unavailable("provider_unavailable");
      try {
        const value = result.value;
        const provenance = Object.freeze({
          provider: value.provider,
          canonicalModel: value.canonicalModel,
          dimensions: value.dimensions,
          contractVersion: value.contractVersion as 1,
        });
        assertRecordEmbeddingProvenanceV1(provenance);
        return Object.freeze({
          status: "available" as const,
          embedding: Object.freeze({
            provenance,
            vector: canonicalizeRecordEmbeddingV1(value.vector),
          }),
        });
      } catch {
        return unavailable("invalid_response");
      }
    },
  });
}
