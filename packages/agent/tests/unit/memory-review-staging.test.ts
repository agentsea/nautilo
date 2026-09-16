import { describe, expect, test } from "bun:test";
import { createMemoryReviewStaging, memoryReviewFingerprint, type MemoryReviewStagingPorts } from "../../src/memory/memory-review-staging";
import type { MemoryDetail } from "../../src/store/memory-store";

const embedding = (vector: readonly number[] = [1, 0], canonicalModel = "model-a") => ({
  vector,
  provider: "openai" as const,
  canonicalModel,
  dimensions: vector.length,
  contractVersion: 1 as const,
});

function row(id = "existing", tier = 1): MemoryDetail {
  return { id, type: "fact", content: "Old fact", tier, importance: 0.6, createdAt: new Date(0), updatedAt: new Date(0), demotedAt: null, demotedFrom: null, namespaceIds: ["room"] };
}
function ordinaryRow(value: MemoryDetail): MemoryDetail & { type: string; content: string } {
  if (value.type === null || value.content === null) throw new Error("seeded ordinary fixture missing payload");
  return { ...value, type: value.type, content: value.content };
}
function ports(overrides: Partial<MemoryReviewStagingPorts> = {}): MemoryReviewStagingPorts {
  return { read: async () => row(), search: async () => [], findSaveTarget: async () => null, embed: async () => embedding(), dedupThreshold: 0.9, ...overrides };
}
describe("ordinary Memory review staging", () => {
  test("stages save, duplicate save, replace, demote and promote with read-your-writes without canonical writes", async () => {
    let reads = 0;
    const staging = createMemoryReviewStaging("work", ports({ read: async () => { reads += 1; return null; } }));
    await staging.mutate({ action: "save", content: "Fact" });
    const first = staging.prepared().operations[0]!;
    await staging.mutate({ action: "save", content: "Equivalent fact" });
    await staging.mutate({ action: "replace", memory_id: first.memoryId, content: "Revised fact" });
    await staging.mutate({ action: "remove", memory_id: first.memoryId });
    expect((await staging.search("fact", 10, false))[0]?.tier).toBe(2);
    await staging.mutate({ action: "promote", memory_id: first.memoryId });
    const found = (await staging.search("fact", 10, false))[0]!;
    expect(found.content).toBe("Revised fact");
    expect(found.tier).toBe(1);
    expect(reads).toBe(0);
    expect(staging.prepared().operations.map((operation) => operation.memoryId)).toEqual(Array.from({ length: 5 }, () => first.memoryId));
    expect(staging.prepared().operations[1]?.expectedDedupId).toBe(first.memoryId);
    expect(staging.prepared().snapshots).toEqual([]);
    expect(staging.prepared().operations.map((operation) => operation.operationId)).toEqual([0, 1, 2, 3, 4].map((index) => `work:mutation:${index}`));
  });
  test("freezes original revision once and overlays semantic search results", async () => {
    const original = ordinaryRow(row());
    const staging = createMemoryReviewStaging("work", ports({ search: async () => [{ ...original, score: 1 }] }));
    await staging.mutate({ action: "replace", memory_id: original.id, content: "New fact" });
    await staging.mutate({ action: "remove", memory_id: original.id });
    expect(staging.prepared().snapshots).toEqual([{ memoryId: original.id, fingerprint: memoryReviewFingerprint(original) }]);
    expect((await staging.search("fact", 10, false))[0]?.content).toBe("New fact");
    await staging.mutate({ action: "remove", memory_id: original.id });
    expect(await staging.search("fact", 10, false)).toEqual([]);
    expect((await staging.search("fact", 10, true))[0]?.tier).toBe(3);
  });
  test("uses canonical existing dedup target and prepares embedding", async () => {
    const staging = createMemoryReviewStaging("work", ports({ findSaveTarget: async () => ({ id: "existing", score: 1 }) }));
    await staging.mutate({ action: "save", content: "Fact" });
    expect(staging.prepared().operations[0]).toMatchObject({ memoryId: "existing", expectedDedupId: "existing", embedding: embedding() });
    expect(staging.prepared().snapshots).toHaveLength(1);
  });
  test("retains exact embedding provenance and excludes overlay vectors from another cohort", async () => {
    const embeddings = [embedding([1, 0], "model-a"), embedding([1, 0], "model-b")];
    const staging = createMemoryReviewStaging("work", ports({
      embed: async () => embeddings.shift()!,
    }));
    await staging.mutate({ action: "save", content: "First fact" });
    const first = staging.prepared().operations[0]!;
    await staging.mutate({ action: "save", content: "Second fact" });
    const second = staging.prepared().operations[1]!;
    expect(first.embedding).toEqual(embedding([1, 0], "model-a"));
    expect(second.embedding).toEqual(embedding([1, 0], "model-b"));
    expect(second.expectedDedupId).toBeNull();
    expect(second.memoryId).not.toBe(first.memoryId);
  });
  test("denies unavailable or seeded mutation targets and invalid tier transitions", async () => {
    const denied = createMemoryReviewStaging("work", ports({ read: async () => null }));
    expect(await denied.mutate({ action: "replace", memory_id: "seed", content: "Fact" }).catch((error: unknown) => error)).toMatchObject({ code: "memory_unavailable" });
    const archived = createMemoryReviewStaging("work", ports({ read: async () => row("existing", 3) }));
    expect(await archived.mutate({ action: "promote", memory_id: "existing" }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_proposal" });
    expect(archived.prepared().operations).toEqual([]);
  });
  test("embedding failure cannot leave a partial mutation", async () => {
    const staging = createMemoryReviewStaging("work", ports({ embed: async () => { throw new Error("private provider body"); } }));
    expect(await staging.mutate({ action: "save", content: "Fact" }).catch((error: unknown) => error)).toMatchObject({ code: "embedding_failed", message: "embedding_failed" });
    expect(staging.prepared().operations).toEqual([]);
  });
  test("rejects missing content and missing target", async () => {
    const staging = createMemoryReviewStaging("work", ports());
    expect(await staging.mutate({ action: "save" }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_proposal" });
    expect(await staging.mutate({ action: "remove" }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_proposal" });
  });
  test("replacing the nearest candidate does not hide the next canonical dedup target", async () => {
    const staging = createMemoryReviewStaging("work", ports({
      read: async (id) => row(id),
      embed: async (content) => embedding(content === "Changed direction" ? [0, 1] : [1, 0]),
      findSaveTarget: async (_content, _type, _embedding, excluded) => {
        expect(excluded).toContain("nearest");
        return { id: "next-nearest", score: 0.95 };
      },
    }));
    await staging.mutate({ action: "replace", memory_id: "nearest", content: "Changed direction" });
    await staging.mutate({ action: "save", content: "Another fact" });
    expect(staging.prepared().operations[1]?.expectedDedupId).toBe("next-nearest");
  });
  test("tier-only and unchanged replacements keep the canonical dedup vector", async () => {
    for (const mutation of [
      { action: "promote", memory_id: "existing" },
      { action: "replace", memory_id: "existing", content: "Old fact" },
      { action: "remove", memory_id: "existing" },
    ] as const) {
      let embeddings = 0;
      const staging = createMemoryReviewStaging("work", ports({
        read: async () => row("existing", mutation.action === "promote" ? 2 : 1),
        embed: async () => { embeddings++; return embedding(); },
        findSaveTarget: async (_content, _type, _embedding, excluded) => excluded.includes("existing") ? null : { id: "existing", score: 1 },
      }));
      await staging.mutate(mutation);
      expect(embeddings).toBe(0);
      await staging.mutate({ action: "save", content: "Old fact" });
      expect(embeddings).toBe(1);
      expect(staging.prepared().operations[1]).toMatchObject({ memoryId: "existing", expectedDedupId: "existing" });
    }
  });
  test("archive transitions preserve Namespace and scope dedup eligibility", async () => {
    for (const dedupIncludesArchive of [false, true]) {
      let embeddings = 0;
      const staging = createMemoryReviewStaging("work", ports({
        dedupIncludesArchive,
        read: async () => row("existing", 2),
        embed: async () => { embeddings++; return embedding(); },
        findSaveTarget: async (_content, _type, _embedding, excluded) => excluded.includes("existing") ? null : { id: "existing", score: 1 },
      }));
      await staging.mutate({ action: "remove", memory_id: "existing" });
      await staging.mutate({ action: "save", content: "Old fact" });
      expect(embeddings).toBe(1);
      expect(staging.prepared().operations[1]?.expectedDedupId).toBe(dedupIncludesArchive ? "existing" : null);
    }
  });
  test("exact replacement preserves canonical no-reembedding behavior", async () => {
    const staging = createMemoryReviewStaging("work", ports({ embed: async () => { throw new Error("must not embed unchanged content"); } }));
    await staging.mutate({ action: "replace", memory_id: "existing", content: "Old fact" });
    expect(staging.prepared().operations[0]?.embedding).toBeUndefined();
  });

});
