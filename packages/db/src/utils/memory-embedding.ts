import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import type { EmbeddingWithProvenanceV1 } from "@nautilo/types";
import { memories } from "../schema/memories";

/** Persist a newly produced vector with its actual provenance in one write.
 * Revision advancement remains with the owning Memory mutation protocol.
 */
export function memoryEmbeddingValues(embedding: EmbeddingWithProvenanceV1, revision: number | SQL) {
  // These are the existing memories vector/coherence constraints, not a
  // provider capability guess or a configurable truncation policy.
  if (embedding.dimensions !== 1536 || embedding.vector.length !== embedding.dimensions
    || !embedding.vector.every(Number.isFinite) || embedding.contractVersion !== 1
    || !["openai", "openrouter", "venice"].includes(embedding.provider)
    || !embedding.canonicalModel.trim()) {
    throw new TypeError("Invalid Memory embedding provenance");
  }
  return {
    embedding: [...embedding.vector],
    embeddingRevision: revision,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.canonicalModel,
    embeddingDimensions: embedding.dimensions,
    embeddingContractVersion: embedding.contractVersion,
  };
}

/** Legacy/unknown, stale and different-model vectors cannot share a distance space. */
export function memoryEmbeddingCompatibilityCondition(embedding: EmbeddingWithProvenanceV1) {
  return and(
    isNotNull(memories.embedding),
    eq(memories.embeddingProvider, embedding.provider),
    eq(memories.embeddingModel, embedding.canonicalModel),
    eq(memories.embeddingDimensions, embedding.dimensions),
    eq(memories.embeddingContractVersion, embedding.contractVersion),
    eq(memories.embeddingRevision, memories.contentRevision),
  );
}
