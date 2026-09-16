/**
 * D168 P2.6 — memory-store product path under Path C RLS.
 *
 * Exercises the real store functions through the nautilo_agent role. This
 * catches the INSERT lifecycle bug where `memories` was created before the
 * `memory_namespaces` junction row existed.
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
import { saveMemory, searchMemory } from "../../src/store/memory-store";

const hasOpenAiApiKey = Boolean(process.env["OPENAI_API_KEY"]?.trim());
if (!hasOpenAiApiKey) {
  console.warn("Skipping memory-store RLS integration test: OPENAI_API_KEY not set");
}

let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let userId: string;
let actorId: string;
let agentId: string;
let namespaceId: string;
let roomId: string;

beforeAll(async () => {
  if (!hasOpenAiApiKey) return;
  bootstrapTestDbInstance();
  await ensureDatabase();
  supDb = createDirectDb(1);
  agentDb = createDirectAgentDb(1);

  const ts = Date.now().toString(36);
  const [user] = await supDb
    .insert(users)
    .values({
      name: "d168-memory-rls",
      email: `d168-memory-rls-${ts}@test.local`,
      handle: `d168mem${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create user");
  userId = user.id;

  const [actor] = await supDb
    .insert(actors)
    .values({ ownerId: userId, displayName: "d168-memory-rls", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create actor");
  actorId = actor.id;

  const [agent] = await supDb
    .insert(agents)
    .values({ handle: `d168-memory-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create agent");
  agentId = agent.id;

  const [ns] = await supDb
    .insert(namespaces)
    .values({ scope: "private", label: `D168 memory ${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("Failed to create namespace");
  namespaceId = ns.id;

  const [room] = await supDb
    .insert(rooms)
    .values({
      namespaceId,
      ownerId: userId,
      type: "private",
      label: `D168 memory ${ts}`,
      graphThreadId: `d168-memory-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Failed to create room");
  roomId = room.id;

  await supDb.insert(roomMembers).values({ roomId, actorId });
});

afterAll(async () => {
  if (!hasOpenAiApiKey) return;
  try {
    if (supDb && userId) {
      // M127: memories.agent_id is gone — clean up by the namespace
      // junction (and delete memories before the namespace, since the
      // junction→namespaces FK is RESTRICT).
      await supDb.execute(sql`DELETE FROM memories WHERE id IN (
        SELECT memory_id FROM memory_namespaces WHERE namespace_id = ${namespaceId}
      )`);
      await supDb.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await supDb.delete(rooms).where(eq(rooms.id, roomId));
      await supDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await supDb.delete(agents).where(eq(agents.id, agentId));
      await supDb.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await agentDb?.end();
    await supDb?.end();
  }
});

describe.skipIf(!hasOpenAiApiKey)("memory-store Path C RLS (D168 P2.6)", () => {
  test("saveMemory creates memory + namespace junction under trust context", async () => {
    const marker = `D168 memory RLS ${Date.now()}`;
    const saved = await saveMemory({
      userId,
      agentId,
      type: "fact",
      content: marker,
      namespaceId,
    });

    expect(saved.action).toBe("created");

    const junction = await supDb
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, saved.id));
    expect(junction.map((r) => r.namespaceId)).toContain(namespaceId);

    const withoutTrust = await agentDb
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(withoutTrust).toHaveLength(0);

    const found = await searchMemory({
      userId,
      agentId,
      query: marker,
      namespaceIds: [namespaceId],
    });
    expect(found.some((m) => m.id === saved.id && m.content === marker)).toBe(true);
  });
});
