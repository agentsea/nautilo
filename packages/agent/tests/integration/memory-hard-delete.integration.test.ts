/**
 * D234 — hard-delete orphan-aware guard under Path C RLS (live Postgres).
 *
 * Hermetic to Postgres only — does NOT require OPENAI_API_KEY. Memory rows are
 * seeded directly (embedding is nullable and irrelevant to delete); namespace
 * access is granted via the room + room-member chain the RLS policy checks,
 * mirroring memory-store-rls-path-c.integration.test.ts.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectAgentDb,
  createDirectDb,
  ensureDatabase,
  eq,
  memories,
  memoryNamespaces,
  namespaces,
  roomMembers,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  attachMemoryToNamespace,
  hardDeleteMemory,
  setMemoryAuditSink,
} from "../../src/store/memory-store";
import type { MemoryAuditSinkInput } from "../../src/store/memory-write-access";

let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let userId: string;
let actorId: string;
let agentId: string;
let nsA: string;
let nsB: string;
let roomAId: string;
let roomBId: string;
const auditRows: MemoryAuditSinkInput[] = [];

/**
 * Create a namespace + a room bound to it + a membership for the test actor,
 * which is what the Path C RLS policy checks to authorize the agent role.
 */
async function makeAccessibleNamespace(ts: string, tag: string): Promise<string> {
  const [ns] = await supDb
    .insert(namespaces)
    .values({ scope: "private", label: `D234 ${tag} ${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  const [room] = await supDb
    .insert(rooms)
    .values({
      namespaceId: ns.id,
      ownerId: userId,
      type: "private",
      label: `D234 ${tag} ${ts}`,
      graphThreadId: `d234-${tag}-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room insert failed");
  await supDb.insert(roomMembers).values({ roomId: room.id, actorId });
  if (tag === "A") roomAId = room.id;
  else roomBId = room.id;
  return ns.id;
}

/**
 * Seed a memory row directly (superuser, bypasses RLS) then attach it to a
 * namespace via the product helper (runs as the agent role — authorized by the
 * room membership above). No embedding / OpenAI needed for delete tests.
 */
async function seedMemory(content: string, namespaceId: string): Promise<{ id: string }> {
  const [row] = await supDb
    .insert(memories)
    .values({ type: "fact", content })
    .returning({ id: memories.id });
  if (!row) throw new Error("seed memory insert failed");
  await attachMemoryToNamespace(row.id, namespaceId, { userId, agentId });
  return { id: row.id };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  supDb = createDirectDb(1);
  agentDb = createDirectAgentDb(1);

  const ts = Date.now().toString(36);
  const [user] = await supDb
    .insert(users)
    .values({
      name: "d234-hard-del",
      email: `d234-hard-del-${ts}@test.local`,
      handle: `d234hd${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  userId = user.id;

  const [actor] = await supDb
    .insert(actors)
    .values({ ownerId: userId, displayName: "d234-hard-del", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor insert failed");
  actorId = actor.id;

  const [agent] = await supDb
    .insert(agents)
    .values({ handle: `d234-hard-del-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent insert failed");
  agentId = agent.id;

  nsA = await makeAccessibleNamespace(ts, "A");
  nsB = await makeAccessibleNamespace(ts, "B");

  setMemoryAuditSink((evt) => auditRows.push(evt));
});

afterAll(async () => {
  setMemoryAuditSink(null);
  try {
    if (supDb && userId) {
      await supDb.execute(sql`DELETE FROM memories WHERE id IN (
        SELECT memory_id FROM memory_namespaces WHERE namespace_id IN (${nsA}, ${nsB})
      )`);
      await supDb.delete(roomMembers).where(eq(roomMembers.actorId, actorId));
      await supDb.delete(rooms).where(eq(rooms.id, roomAId));
      await supDb.delete(rooms).where(eq(rooms.id, roomBId));
      await supDb.delete(namespaces).where(eq(namespaces.id, nsA));
      await supDb.delete(namespaces).where(eq(namespaces.id, nsB));
      await supDb.delete(agents).where(eq(agents.id, agentId));
      await supDb.delete(actors).where(eq(actors.id, actorId));
      await supDb.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await agentDb?.end();
    await supDb?.end();
  }
});

describe("hardDeleteMemory", () => {
  test("blocks when memory is attached to >=2 namespaces without confirmShared", async () => {
    const saved = await seedMemory(`shared memory ${Date.now()}`, nsA);
    await attachMemoryToNamespace(saved.id, nsB, { userId, agentId });

    const blocked = await hardDeleteMemory(saved.id, nsA, [nsA, nsB], { userId, agentId });
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") {
      expect(blocked.namespaceCount).toBeGreaterThanOrEqual(2);
    }

    const still = await supDb.select({ id: memories.id }).from(memories).where(eq(memories.id, saved.id));
    expect(still.length).toBe(1);
  });

  test("detach-only succeeds with confirmShared when multi-namespace", async () => {
    const saved = await seedMemory(`detach memory ${Date.now()}`, nsA);
    await attachMemoryToNamespace(saved.id, nsB, { userId, agentId });

    const result = await hardDeleteMemory(
      saved.id,
      nsA,
      [nsA, nsB],
      { userId, agentId },
      { confirmShared: true },
    );
    expect(result.status).toBe("detached_only");

    const nsRows = await supDb
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, saved.id));
    expect(nsRows.map((r) => r.namespaceId)).toEqual([nsB]);
  });

  test("emits memory.delete audit row on successful hard delete", async () => {
    auditRows.length = 0;
    const saved = await seedMemory(`orphan memory ${Date.now()}`, nsA);

    const result = await hardDeleteMemory(saved.id, nsA, [nsA], { userId, agentId });
    expect(result.status).toBe("deleted");
    expect(
      auditRows.some((r) => r.kind === "memory.delete" && r.mode === "hard" && r.outcome === "success"),
    ).toBe(true);
  });
});
