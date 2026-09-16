/** Real agent-role/RLS queries with deterministic embeddings; no provider calls.
 * Run in its own Bun process because the embedding transport is mocked.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EmbeddingWithProvenanceV1 } from "@nautilo/types";
import {
  actors, agents, agentScopes, createDirectDb, eq, inArray, memories,
  memoryEmbeddingValues, memoryNamespaces, memoryScopes, namespaces,
  roomMembers, rooms, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

const produced: EmbeddingWithProvenanceV1 = {
  vector: Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0),
  provider: "venice", canonicalModel: "text-embedding-qwen3-8b", dimensions: 1536, contractVersion: 1,
};
let embeddingCalls = 0;
mock.module("../../src/store/embeddings", () => ({
  embedTextWithProvenance: async () => { embeddingCalls += 1; return produced; },
}));
const ordinary = await import("../../src/store/memory-store");
const scoped = await import("../../src/store/scope-memory-store");
let db: ReturnType<typeof createDirectDb>;
const userId = randomUUID(), actorId = randomUUID(), agentId = randomUUID();
const namespaceId = randomUUID(), roomId = randomUUID(), scopeId = randomUUID();
const ownedMemoryIds = new Set<string>();
const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);
  await db.insert(users).values({ id: userId, name: "Embedding QA", handle: `embqa${suffix}`, email: `embqa-${suffix}@test.local` });
  await db.insert(actors).values({ id: actorId, kind: "user", ownerId: userId, displayName: "Embedding QA" });
  await db.insert(agents).values({ id: agentId, handle: `embqa-${suffix}` });
  await db.insert(namespaces).values({ id: namespaceId, scope: "private", label: `Embedding QA ${suffix}` });
  await db.insert(rooms).values({ id: roomId, namespaceId, ownerId: userId, type: "private", label: `Embedding QA ${suffix}`, graphThreadId: `embqa-${suffix}` });
  await db.insert(roomMembers).values({ roomId, actorId });
  await db.insert(agentScopes).values({ id: scopeId, parentAgentId: agentId, speakerUserId: userId, name: `embqa-${suffix}` });
});

afterAll(async () => {
  try {
    if (ownedMemoryIds.size) await db.delete(memories).where(inArray(memories.id, [...ownedMemoryIds]));
    await db.delete(agentScopes).where(eq(agentScopes.id, scopeId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    await db.delete(actors).where(eq(actors.id, actorId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(users).where(eq(users.id, userId));
  } finally { await db?.end(); mock.restore(); }
});

async function insertFixture(content: string, provenance: "unknown" | "other-model" | "other-provider" | "stale" | "current", origin: "scope" | "seed" = "scope") {
  const id = randomUUID();
  ownedMemoryIds.add(id);
  const embedding = provenance === "other-model" ? { ...produced, canonicalModel: "old-embedding-model" }
    : provenance === "other-provider" ? { ...produced, provider: "openrouter" as const } : produced;
  await db.insert(memories).values({ id, content, type: "fact", tier: 1,
    ...(provenance === "unknown" ? { embedding: [...produced.vector] }
      : { ...memoryEmbeddingValues(embedding, 0), contentRevision: provenance === "stale" ? 1 : 0 }),
  });
  await db.insert(memoryNamespaces).values({ memoryId: id, namespaceId });
  await db.insert(memoryScopes).values({ memoryId: id, scopeId, origin });
  return id;
}

async function assertProvenance(id: string, revision = 0) {
  const [row] = await db.select().from(memories).where(eq(memories.id, id));
  expect(row).toMatchObject({ embeddingProvider: produced.provider, embeddingModel: produced.canonicalModel,
    embeddingDimensions: 1536, embeddingContractVersion: 1, embeddingRevision: revision, contentRevision: revision });
  expect(row?.embedding).toEqual([...produced.vector]);
}

const trust = { userId, agentId };
const scopeTrust = { speakerUserId: userId, agentId, scopeId };

describe("Memory embedding cohorts", () => {
  test("ordinary and scope ranking exclude unknown, other-model/provider and stale identical vectors; lexical access remains", async () => {
    const incompatible = await Promise.all(["unknown", "other-model", "other-provider", "stale"].map((kind) =>
      insertFixture(`synthetic incompatible ${kind}`, kind as "unknown" | "other-model" | "other-provider" | "stale")));
    const current = await insertFixture("synthetic current", "current");
    const ordinaryResults = await ordinary.searchMemory({ ...trust, namespaceIds: [namespaceId], query: "synthetic", mode: "vector" });
    const scopeResults = await scoped.searchScopeMemory({ ...scopeTrust, query: "synthetic", mode: "vector" });
    expect(ordinaryResults.map((r) => r.id)).toEqual([current]);
    expect(scopeResults.map((r) => r.id)).toEqual([current]);
    expect((await ordinary.searchMemory({ ...trust, namespaceIds: [namespaceId], query: "synthetic incompatible", mode: "text" })).map((r) => r.id).sort()).toEqual([...incompatible].sort());
    expect((await scoped.searchScopeMemory({ ...scopeTrust, query: "synthetic incompatible", mode: "text" })).map((r) => r.id).sort()).toEqual([...incompatible].sort());
    await db.delete(memories).where(eq(memories.id, current));
  });

  test("incompatible vectors never deduplicate a save, while same-cohort saves still update", async () => {
    const saved = await ordinary.saveMemory({ ...trust, namespaceId, type: "fact", content: "synthetic new ordinary" });
    ownedMemoryIds.add(saved.id);
    expect(saved.action).toBe("created"); await assertProvenance(saved.id);
    const updated = await ordinary.saveMemory({ ...trust, namespaceId, type: "fact", content: "synthetic ordinary replacement" });
    expect(updated).toMatchObject({ id: saved.id, action: "updated" }); await assertProvenance(saved.id);
    await db.delete(memories).where(eq(memories.id, saved.id));
    const scopeSaved = await scoped.saveScopeMemory({ ...scopeTrust, type: "fact", content: "synthetic new scope" });
    ownedMemoryIds.add(scopeSaved.id);
    expect(scopeSaved.action).toBe("created"); await assertProvenance(scopeSaved.id);
    const scopeUpdated = await scoped.saveScopeMemory({ ...scopeTrust, type: "fact", content: "synthetic scope replacement" });
    expect(scopeUpdated).toMatchObject({ id: scopeSaved.id, action: "updated" }); await assertProvenance(scopeSaved.id);
  });

  test("replace and patch stamp new provenance at the existing revision; unchanged replacement never relabels old vectors", async () => {
    const id = await insertFixture("synthetic old content", "unknown");
    const calls = embeddingCalls;
    await ordinary.replaceMemory(id, "synthetic old content", [namespaceId], trust);
    expect(embeddingCalls).toBe(calls);
    expect((await db.select().from(memories).where(eq(memories.id, id)))[0]?.embeddingProvider).toBeNull();
    await db.update(memories).set({ contentRevision: 7 }).where(eq(memories.id, id));
    await ordinary.replaceMemory(id, "synthetic replaced", [namespaceId], trust); await assertProvenance(id, 7);
    await ordinary.updateMemory(id, { content: "synthetic patched" }, [namespaceId], trust); await assertProvenance(id, 7);
    const scopeIdToEdit = await insertFixture("synthetic scope old", "unknown");
    await scoped.replaceScopeMemory({ ...scopeTrust, memoryId: scopeIdToEdit, content: "synthetic scope replaced" });
    await assertProvenance(scopeIdToEdit);
    await scoped.updateScopeMemory({ ...scopeTrust, memoryId: scopeIdToEdit, content: "synthetic scope patched" });
    await assertProvenance(scopeIdToEdit);
  });
});
