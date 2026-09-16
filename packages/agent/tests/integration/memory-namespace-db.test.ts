/**
 * Integration tests for memory namespace enforcement.
 * Requires: OPENAI_API_KEY (embeddings), running Postgres + Neon proxy.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  eq,
  sql,
  count,
  users,
  actors,
  namespaces,
  rooms,
  roomMembers,
  agents,
  memoryNamespaces,
  memories,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  saveMemory as saveMemoryRaw,
  searchMemory as searchMemoryRaw,
  getPromptBrief as getPromptBriefRaw,
  selectPromptBriefMemories,
  stagePromptBriefMemories,
  commitPromptBriefMemoryOverflow,
  attachMemoryToNamespace as attachMemoryToNamespaceRaw,
  replaceMemory as replaceMemoryRaw,
  demoteMemory as demoteMemoryRaw,
  archiveMemory as archiveMemoryRaw,
  type SaveMemoryOptions,
  type SearchMemoryOptions,
} from "../../src/store/memory-store";

const hasOpenAiApiKey = Boolean(process.env["OPENAI_API_KEY"]?.trim());
if (!hasOpenAiApiKey) {
  console.warn("Skipping memory namespace integration tests: OPENAI_API_KEY not set");
}


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let privateNsId: string;
let sharedNsId: string;
let testAgentId: string;
// M127: second agent co-hosting the same Namespace as `testAgentId`.
// Used by the multi-agent shared-NS visibility cases below.
let testAgentBId: string;
let actorId: string;
let privateRoomId: string;
let sharedRoomId: string;

function trust() {
  return { userId: ownerId, agentId: testAgentId };
}

function saveMemory(opts: Omit<SaveMemoryOptions, "userId">) {
  return saveMemoryRaw({ ...opts, userId: ownerId });
}

function searchMemory(opts: Omit<SearchMemoryOptions, "userId">) {
  return searchMemoryRaw({ ...opts, userId: ownerId });
}

function getPromptBrief(namespaceIds: string[], agentId?: string) {
  return getPromptBriefRaw(namespaceIds, agentId, ownerId);
}

function attachMemoryToNamespace(memoryId: string, namespaceId: string) {
  return attachMemoryToNamespaceRaw(memoryId, namespaceId, trust());
}

function replaceMemory(memoryId: string, newContent: string, mutableNamespaceIds?: string[]) {
  return replaceMemoryRaw(memoryId, newContent, mutableNamespaceIds, trust());
}

function demoteMemory(memoryId: string, mutableNamespaceIds?: string[]) {
  return demoteMemoryRaw(memoryId, mutableNamespaceIds, trust());
}

function archiveMemory(memoryId: string, mutableNamespaceIds?: string[]) {
  return archiveMemoryRaw(memoryId, mutableNamespaceIds, trust());
}

beforeAll(async () => {
  if (!hasOpenAiApiKey) return;
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({ name: "mem-ns-integ", email: `mem-ns-integ-${Date.now()}@test.local` })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  ownerId = user.id;

  const [actor] = await db
    .insert(actors)
    .values({ ownerId, displayName: "mem-ns-integ", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create test actor");
  actorId = actor.id;

  // M044: namespaces.owner_id column is gone — these rows stand
  // alone as scope/label descriptors; Rooms would normally own them
  // but this integration test isolates the memory-store / namespace
  // filter path from the full Room/resolver machinery.
  const [privateNs] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "Private" })
    .returning({ id: namespaces.id });
  if (!privateNs) throw new Error("Failed to create private namespace");
  privateNsId = privateNs.id;

  const [sharedNs] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: "Home" })
    .returning({ id: namespaces.id });
  if (!sharedNs) throw new Error("Failed to create shared namespace");
  sharedNsId = sharedNs.id;

  // M042A: create a test agent for the new required agentId on saveMemory.
  // M045: `agents.owner_id` was dropped — insert payload is handle +
  // displayName only.
  const [agent] = await db
    .insert(agents)
    .values({ handle: `memtest-${Date.now()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create test agent");
  testAgentId = agent.id;

  // M127: a peer agent co-hosting the same Namespace as testAgentId.
  // Post-M127, content scope is Namespace-only, so two agents in the
  // same Room (= same Namespace) share the same Memory rows.
  const [agentB] = await db
    .insert(agents)
    .values({ handle: `memtest-b-${Date.now()}` })
    .returning({ id: agents.id });
  if (!agentB) throw new Error("Failed to create peer test agent");
  testAgentBId = agentB.id;

  const roomTs = Date.now();
  const [privateRoom] = await db
    .insert(rooms)
    .values({
      namespaceId: privateNsId,
      ownerId,
      type: "private",
      label: "Private",
      graphThreadId: `mem-ns-private-${roomTs}`,
    })
    .returning({ id: rooms.id });
  if (!privateRoom) throw new Error("Failed to create private room");
  privateRoomId = privateRoom.id;

  const [sharedRoom] = await db
    .insert(rooms)
    .values({
      namespaceId: sharedNsId,
      ownerId,
      type: "shared",
      label: "Shared",
      graphThreadId: `mem-ns-shared-${roomTs}`,
    })
    .returning({ id: rooms.id });
  if (!sharedRoom) throw new Error("Failed to create shared room");
  sharedRoomId = sharedRoom.id;

  await db.insert(roomMembers).values([
    { roomId: privateRoomId, actorId },
    { roomId: sharedRoomId, actorId },
  ]);
});

afterAll(async () => {
  if (!hasOpenAiApiKey) return;
  if (db && ownerId) {
    // M127: memories.agent_id is gone. Reap memories by walking the
    // memory_namespaces junction for the namespaces we created.
    await db.execute(sql`
      DELETE FROM memories
       WHERE id IN (
         SELECT memory_id FROM memory_namespaces
          WHERE namespace_id = ANY(ARRAY[${privateNsId}::uuid, ${sharedNsId}::uuid])
       )
    `);
    // Reap any orphan memory rows this test fixture inserted without
    // junction edges (backward-compat `saveMemory` without namespaceId
    // case). Match on the timestamp prefix our content strings carry.
    // M045: `DELETE FROM users` no longer cascades to `agents` (the
    // `agents.owner_id` FK was dropped). Canonical ownership is M:N
    // via the `agent_ownership` Group; user delete cleans up the
    // group + membership rows, which leaves the agent row orphaned
    // unless we delete it explicitly.
    if (testAgentId) {
      await db.execute(sql`DELETE FROM agents WHERE id = ${testAgentId}`);
    }
    if (testAgentBId) {
      await db.execute(sql`DELETE FROM agents WHERE id = ${testAgentBId}`);
    }
    if (privateRoomId || sharedRoomId) {
      await db
        .delete(roomMembers)
        .where(sql`${roomMembers.roomId} = ANY(ARRAY[${privateRoomId}::uuid, ${sharedRoomId}::uuid])`);
      await db.delete(rooms).where(sql`${rooms.id} = ANY(ARRAY[${privateRoomId}::uuid, ${sharedRoomId}::uuid])`);
    }
    await db.delete(namespaces).where(sql`${namespaces.id} = ANY(ARRAY[${privateNsId}::uuid, ${sharedNsId}::uuid])`);
    await db.delete(users).where(eq(users.id, ownerId));
  }
  if (db) {
    await db.end();
  }
});

describe.skipIf(!hasOpenAiApiKey)("memory namespace enforcement (integration)", () => {
  test("saveMemory inserts memory_namespaces row when namespaceId provided", async () => {
    const result = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `ns-test-private-${Date.now()}`,
      namespaceId: privateNsId,
    });

    expect(result.id).toBeTruthy();
    expect(result.action).toBe("created");

    const [row] = await db.execute<{ namespace_id: string }>(
      sql`SELECT namespace_id FROM memory_namespaces WHERE memory_id = ${result.id}`,
    );
    expect(row?.namespace_id).toBe(privateNsId);
  });

  test("saveMemory works without namespace_id (backward compat)", async () => {
    const result = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `ns-test-no-ns-${Date.now()}`,
    });

    expect(result.id).toBeTruthy();
    expect(result.action).toBe("created");
  });

  test("searchMemory filters by namespaceIds", async () => {
    const ts = Date.now();

    await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `private-search-test-${ts}`,
      namespaceId: privateNsId,
    });

    await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `shared-search-test-${ts}`,
      namespaceId: sharedNsId,
    });

    const privateOnly = await searchMemory({
      agentId: testAgentId,
      query: `search-test-${ts}`,
      namespaceIds: [privateNsId],
    });

    const hasPrivate = privateOnly.some((m) => m.content.includes("private-search-test"));
    const hasShared = privateOnly.some((m) => m.content.includes("shared-search-test"));
    expect(hasPrivate).toBe(true);
    expect(hasShared).toBe(false);
  });

  test("searchMemory with empty or omitted namespaceIds returns no rows (M081)", async () => {
    const ts = Date.now();

    await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `all-ns-test-${ts}`,
      namespaceId: privateNsId,
    });

    const emptyResults = await searchMemory({
      agentId: testAgentId,
      query: `all-ns-test-${ts}`,
      namespaceIds: [],
    });
    expect(emptyResults.length).toBe(0);

    const omittedResults = await searchMemory({
      agentId: testAgentId,
      query: `all-ns-test-${ts}`,
    });
    expect(omittedResults.length).toBe(0);
  });

  test("getPromptBrief filters by namespaceIds", async () => {
    const ts = Date.now();

    await saveMemory({
      agentId: testAgentId,
      type: "identity",
      content: `brief-private-${ts}`,
      importance: 1.0,
      namespaceId: privateNsId,
    });

    await saveMemory({
      agentId: testAgentId,
      type: "identity",
      content: `brief-shared-${ts}`,
      importance: 1.0,
      namespaceId: sharedNsId,
    });

    const briefPrivateOnly = await getPromptBrief([privateNsId], testAgentId);
    expect(briefPrivateOnly).toContain(`brief-private-${ts}`);
    expect(briefPrivateOnly).not.toContain(`brief-shared-${ts}`);

    const briefAll = await getPromptBrief([privateNsId, sharedNsId], testAgentId);
    expect(briefAll).toContain(`brief-private-${ts}`);
    expect(briefAll).toContain(`brief-shared-${ts}`);
  });

  test("structured prompt-brief selection preserves overflow demotion", async () => {
    const [overflow] = await db.insert(memories).values({
      type: "fact",
      content: "x".repeat(8_100),
      importance: 1,
    }).returning({ id: memories.id });
    const [selected] = await db.insert(memories).values({
      type: "fact",
      content: `brief-after-overflow-${Date.now()}`,
      importance: 0.9,
    }).returning({ id: memories.id });
    if (overflow === undefined || selected === undefined) {
      throw new Error("Failed to create prompt-brief fixtures");
    }
    await db.insert(memoryNamespaces).values([
      { memoryId: overflow.id, namespaceId: privateNsId },
      { memoryId: selected.id, namespaceId: privateNsId },
    ]);

    const brief = await selectPromptBriefMemories(
      [privateNsId],
      testAgentId,
      ownerId,
    );

    expect(brief.some((memory) => memory.id === selected.id)).toBe(true);
    expect(brief.some((memory) => memory.id === overflow.id)).toBe(false);
    const [storedOverflow] = await db.select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, overflow.id));
    expect(storedOverflow?.tier).toBe(2);
  });

  test("protected prompt-brief staging defers overflow demotion until commit", async () => {
    const [overflow] = await db.insert(memories).values({
      type: "fact",
      content: "y".repeat(8_100),
      importance: 1,
    }).returning({ id: memories.id });
    const [selected] = await db.insert(memories).values({
      type: "fact",
      content: `protected-brief-after-overflow-${Date.now()}`,
      importance: 0.9,
    }).returning({ id: memories.id });
    if (overflow === undefined || selected === undefined) {
      throw new Error("Failed to create protected prompt-brief fixtures");
    }
    await db.insert(memoryNamespaces).values([
      { memoryId: overflow.id, namespaceId: privateNsId },
      { memoryId: selected.id, namespaceId: privateNsId },
    ]);

    const staged = await stagePromptBriefMemories(
      [privateNsId],
      testAgentId,
      ownerId,
    );
    expect(staged.memories.some((memory) => memory.id === selected.id))
      .toBe(true);
    expect(staged.overflowIds).toContain(overflow.id);
    const [beforeCommit] = await db.select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, overflow.id));
    expect(beforeCommit?.tier).toBe(1);

    await commitPromptBriefMemoryOverflow(
      staged.overflowIds,
      testAgentId,
      ownerId,
    );
    const [afterCommit] = await db.select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, overflow.id));
    expect(afterCommit?.tier).toBe(2);
  });

  test("searchMemory returns each memory once when readable spans multiple namespaces (DISTINCT)", async () => {
    const ts = Date.now();
    const content = `distinct-multi-ns-${ts}`;

    const result = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });

    await attachMemoryToNamespace(result.id, sharedNsId);

    const merged = await searchMemory({
      agentId: testAgentId,
      query: `distinct-multi-ns-${ts}`,
      namespaceIds: [privateNsId, sharedNsId],
    });

    expect(merged.filter((m) => m.id === result.id)).toHaveLength(1);
  });

  test("dedup across namespaces creates two rows (writable-scoped dedup)", async () => {
    const ts = Date.now();
    const content = `dedup-cross-ns-${ts}`;

    const first = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });
    expect(first.action).toBe("created");

    const second = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: sharedNsId,
    });
    expect(second.action).toBe("created");
    expect(second.id).not.toBe(first.id);
  });

  test("dedup in same namespace updates row and keeps a single junction edge", async () => {
    const ts = Date.now();
    const content = `dedup-same-ns-${ts}`;
    const first = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });
    expect(first.action).toBe("created");

    const second = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });
    expect(second.action).toBe("updated");
    expect(second.id).toBe(first.id);

    const [row] = await db
      .select({ c: count() })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, first.id));
    expect(row?.c ?? 0).toBe(1);
  });

  test("replaceMemory succeeds when mutable namespace list overlaps either attached namespace", async () => {
    const ts = Date.now();
    const base = `replace-roundtrip-${ts}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: `${base}-v1`,
      namespaceId: privateNsId,
    });
    await attachMemoryToNamespace(saved.id, sharedNsId);

    await replaceMemory(saved.id, `${base}-v2`, [privateNsId]);
    let hits = await searchMemory({
      agentId: testAgentId,
      query: base,
      namespaceIds: [sharedNsId],
    });
    expect(hits.some((m) => m.id === saved.id && m.content.includes("-v2"))).toBe(true);

    await replaceMemory(saved.id, `${base}-v3`, [sharedNsId]);
    hits = await searchMemory({
      agentId: testAgentId,
      query: base,
      namespaceIds: [privateNsId],
    });
    expect(hits.some((m) => m.id === saved.id && m.content.includes("-v3"))).toBe(true);
  });

  test("M082: demoteMemory succeeds for shared-only memory when mutable list spans both namespaces", async () => {
    // Isolated natural-language nonce so vector dedup cannot merge with the next test's save (same namespace).
    const marker = `Ostrich postage warehouse cello ${randomBytes(24).toString("hex")}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: sharedNsId,
    });
    expect(saved.action).toBe("created");

    await demoteMemory(saved.id, [privateNsId, sharedNsId]);

    const rows = await db
      .select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, saved.id))
      .limit(1);
    expect(rows[0]?.tier).toBe(2);
  });

  test("D442: archiveMemory moves a tier-1 memory directly to tier 3", async () => {
    const marker = `Archive compass marimba ${randomBytes(24).toString("hex")}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: sharedNsId,
    });
    expect(saved.action).toBe("created");

    await archiveMemory(saved.id, [privateNsId, sharedNsId]);

    const rows = await db
      .select({ tier: memories.tier, demotedFrom: memories.demotedFrom })
      .from(memories)
      .where(eq(memories.id, saved.id))
      .limit(1);
    expect(rows[0]).toMatchObject({ tier: 3, demotedFrom: 1 });
  });

  test("M082: demoteMemory rejects shared-only memory when mutable list is only the private save target", async () => {
    const marker = `Glacier molecule stapler viola ${randomBytes(24).toString("hex")}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: sharedNsId,
    });
    expect(saved.action).toBe("created");

    let demoteErr: unknown;
    try {
      await demoteMemory(saved.id, [privateNsId]);
    } catch (e) {
      demoteErr = e;
    }
    expect(demoteErr).toBeTruthy();
    expect(demoteErr instanceof Error ? demoteErr.message : String(demoteErr)).toContain(
      "namespace you cannot write to",
    );
  });

  test("M082: saveMemory attaches new row only to the save-target namespace (R2)", async () => {
    const ts = Date.now();
    const markerNew = `m082-save-target-${ts}`;
    const created = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: markerNew,
      namespaceId: privateNsId,
    });
    expect(created.action).toBe("created");
    const [nsRow] = await db.execute<{ namespace_id: string }>(
      sql`SELECT namespace_id FROM memory_namespaces WHERE memory_id = ${created.id}`,
    );
    expect(nsRow?.namespace_id).toBe(privateNsId);
  });

  test("readable union: memory attached only to sharedNs still found when filtering both namespaces", async () => {
    const ts = Date.now();
    const marker = `union-read-${ts}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: sharedNsId,
    });
    const hits = await searchMemory({
      agentId: testAgentId,
      query: marker,
      namespaceIds: [privateNsId, sharedNsId],
    });
    expect(hits.filter((m) => m.id === saved.id)).toHaveLength(1);
  });

  test("M083: save → search → brief uses namespace junction only (no room_id on memory row)", async () => {
    const ts = Date.now();
    const marker = `m083-roundtrip-${ts}`;
    const saved = await saveMemory({
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: privateNsId,
    });
    const hits = await searchMemory({
      agentId: testAgentId,
      query: marker,
      namespaceIds: [privateNsId],
    });
    expect(hits.some((m) => m.id === saved.id)).toBe(true);
    const brief = await getPromptBrief([privateNsId], testAgentId);
    expect(brief).toContain(marker);
  });

  // -----------------------------------------------------------------
  // M127: Namespace-only content scope
  // -----------------------------------------------------------------
  // Two agents co-hosting one Namespace share its Memory rows. Pre-M127
  // these tests would have failed (each agent could only see its own
  // memories). Post-M127, Namespace membership IS the content boundary.

  test("M127: AgentB recalls AgentA's memory in shared Namespace", async () => {
    const ts = Date.now();
    const marker = `m127-shared-recall-${ts}`;

    const saved = await saveMemoryRaw({
      userId: ownerId,
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: privateNsId,
    });
    expect(saved.action).toBe("created");

    // AgentB queries the same Namespace — must see AgentA's memory.
    const hitsForB = await searchMemoryRaw({
      userId: ownerId,
      agentId: testAgentBId,
      query: marker,
      namespaceIds: [privateNsId],
    });
    expect(hitsForB.some((m) => m.id === saved.id)).toBe(true);
  });

  test("M127: getPromptBrief returns AgentA's memory for AgentB in shared Namespace", async () => {
    const ts = Date.now();
    const marker = `m127-shared-brief-${ts}`;

    await saveMemoryRaw({
      userId: ownerId,
      agentId: testAgentId,
      type: "identity",
      content: marker,
      importance: 1.0,
      namespaceId: privateNsId,
    });

    const briefForB = await getPromptBriefRaw([privateNsId], testAgentBId, ownerId);
    expect(briefForB).toContain(marker);
  });

  test("M127: AgentA's dedup matches near-duplicate authored by AgentB in same Namespace", async () => {
    // Same content, same namespace, different agent. Post-M127 dedup
    // is namespace-scoped only — AgentA's second save should match
    // AgentB's earlier row and return `updated`.
    const ts = Date.now();
    const content = `m127-cross-agent-dedup-${ts}`;

    const fromB = await saveMemoryRaw({
      userId: ownerId,
      agentId: testAgentBId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });
    expect(fromB.action).toBe("created");

    const fromA = await saveMemoryRaw({
      userId: ownerId,
      agentId: testAgentId,
      type: "fact",
      content,
      namespaceId: privateNsId,
    });
    expect(fromA.action).toBe("updated");
    expect(fromA.id).toBe(fromB.id);
  });

  test("M127: AgentB cannot see memory in a Namespace they don't read", async () => {
    // Negative case — Namespace membership is THE boundary. If a
    // namespace isn't in `readableNamespaceIds`, neither agent sees it,
    // regardless of who wrote it.
    const ts = Date.now();
    const marker = `m127-ns-boundary-${ts}`;

    const saved = await saveMemoryRaw({
      userId: ownerId,
      agentId: testAgentId,
      type: "fact",
      content: marker,
      namespaceId: privateNsId,
    });

    // Query against a DIFFERENT namespace — must return zero rows.
    const hits = await searchMemoryRaw({
      userId: ownerId,
      agentId: testAgentBId,
      query: marker,
      namespaceIds: [sharedNsId],
    });
    expect(hits.some((m) => m.id === saved.id)).toBe(false);
  });
});
