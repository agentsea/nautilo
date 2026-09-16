import { describe, expect, test } from "bun:test";
import type { EmbeddingWithProvenanceV1 } from "@nautilo/types";
import { memoryEmbeddingValues } from "../../src/utils/memory-embedding";

const embedding: EmbeddingWithProvenanceV1 = {
  vector: Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0),
  provider: "venice", canonicalModel: "text-embedding-qwen3-8b",
  dimensions: 1536, contractVersion: 1,
};

describe("Memory embedding persistence boundary", () => {
  test("retains the producing model and caller-owned revision without sharing a mutable vector", () => {
    const values = memoryEmbeddingValues(embedding, 7);
    expect(values).toMatchObject({ embeddingProvider: "venice",
      embeddingModel: "text-embedding-qwen3-8b", embeddingDimensions: 1536,
      embeddingContractVersion: 1, embeddingRevision: 7 });
    expect(values.embedding).toEqual([...embedding.vector]);
    expect(values.embedding).not.toBe(embedding.vector);
  });
  test("rejects malformed vectors and incomplete provenance before a DB write", () => {
    for (const invalid of [
      { ...embedding, vector: [1, 0] },
      { ...embedding, dimensions: 3072 },
      { ...embedding, canonicalModel: " " },
      { ...embedding, vector: embedding.vector.map((x, i) => i === 0 ? NaN : x) },
    ]) expect(() => memoryEmbeddingValues(invalid, 0)).toThrow("Invalid Memory embedding provenance");
  });
});
