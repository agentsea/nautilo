/**
 * M033 Phase 6 — scope-memory-store product path under Path C RLS.
 *
 * Exercises saveScopeMemory, replaceScopeMemory, demote/promote, and
 * searchScopeMemory through the nautilo_agent role with trust context.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agentScopes,
  agents,
  createDirectAgentDb,
  createDirectDb,
  ensureDatabase,
  eq,
  memories,
  memoryScopes,
  namespaces,
  roomMembers,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  archiveScopeMemory,
  demoteScopeMemory,
  promoteScopeMemory,
  replaceScopeMemory,
  saveScopeMemory,
  searchScopeMemory,
} from "../../src/store/scope-memory-store";

const hasOpenAiApiKey = Boolean(process.env["OPENAI_API_KEY"]?.trim());
if (!hasOpenAiApiKey) {
  console.warn("Skipping scope-memory-store RLS integration test: OPENAI_API_KEY not set");
}

let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let userId: string;
let actorId: string;
let agentId: string;
let namespaceId: string;
let roomId: string;
let scopeId: string;

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
      name: "m033-scope-memory-rls",
      email: `m033-scope-mem-${ts}@test.local`,
      handle: `m033sm${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create user");
  userId = user.id;

  const [actor] = await supDb
    .insert(actors)
    .values({ ownerId: userId, displayName: "m033-scope-memory-rls", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create actor");
  actorId = actor.id;

  const [agent] = await supDb
    .insert(agents)
    .values({ handle: `m033-scope-mem-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create agent");
  agentId = agent.id;

  const [ns] = await supDb
    .insert(namespaces)
    .values({ scope: "private", label: `M033 scope memory ${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("Failed to create namespace");
  namespaceId = ns.id;

  const [room] = await supDb
    .insert(rooms)
    .values({
      namespaceId,
      ownerId: userId,
      type: "private",
      label: `M033 scope memory ${ts}`,
      graphThreadId: `m033-scope-mem-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Failed to create room");
  roomId = room.id;

  await supDb.insert(roomMembers).values({ roomId, actorId });

  const [scope] = await supDb
    .insert(agentScopes)
    .values({
      parentAgentId: agentId,
      speakerUserId: userId,
      name: `m033-scope-${ts}`,
    })
    .returning({ id: agentScopes.id });
  if (!scope) throw new Error("Failed to create agent scope");
  scopeId = scope.id;
});

afterAll(async () => {
  if (!hasOpenAiApiKey) return;
  try {
    if (supDb && userId) {
      await supDb.execute(sql`DELETE FROM memory_scopes WHERE scope_id = ${scopeId}`);
      // M127: memories.agent_id is gone — clean up by the namespace
      // junction (delete memories before the namespace; junction→
      // namespaces FK is RESTRICT).
      await supDb.execute(sql`DELETE FROM memories WHERE id IN (
        SELECT memory_id FROM memory_namespaces WHERE namespace_id = ${namespaceId}
      )`);
      await supDb.delete(agentScopes).where(eq(agentScopes.id, scopeId));
      await supDb.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await supDb.delete(rooms).where(eq(rooms.id, roomId));
      await supDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await supDb.delete(actors).where(eq(actors.id, actorId));
      await supDb.delete(agents).where(eq(agents.id, agentId));
      await supDb.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await agentDb?.end();
    await supDb?.end();
  }
});

describe.skipIf(!hasOpenAiApiKey)("scope-memory-store Path C RLS (M033 Phase 6)", () => {
  test("saveScopeMemory creates memory + scope junction; searchScopeMemory finds it", async () => {
    const marker = `M033 scope memory RLS ${Date.now()}`;
    const saved = await saveScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      type: "fact",
      content: marker,
    });

    expect(saved.action).toBe("created");

    const junction = await supDb
      .select({ scopeId: memoryScopes.scopeId, origin: memoryScopes.origin })
      .from(memoryScopes)
      .where(eq(memoryScopes.memoryId, saved.id));
    expect(junction.some((r) => r.scopeId === scopeId && r.origin === "scope")).toBe(true);

    const withoutTrust = await agentDb
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(withoutTrust).toHaveLength(0);

    const found = await searchScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      query: marker,
    });
    expect(found.some((m) => m.id === saved.id && m.content === marker)).toBe(true);
  });

  test("replaceScopeMemory updates content visible in searchScopeMemory", async () => {
    const initial = `M033 replace before ${Date.now()}`;
    const saved = await saveScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      type: "fact",
      content: initial,
    });

    const updated = `M033 replace after ${Date.now()}`;
    await replaceScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      memoryId: saved.id,
      content: updated,
    });

    const found = await searchScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      query: updated,
    });
    expect(found.some((m) => m.id === saved.id && m.content === updated)).toBe(true);
  });

  test("demoteScopeMemory then promoteScopeMemory transitions tier", async () => {
    const marker = `M033 tier transition ${Date.now()}`;
    const saved = await saveScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      type: "fact",
      content: marker,
    });

    const [beforeDemote] = await supDb
      .select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(beforeDemote?.tier).toBe(1);

    await demoteScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      memoryId: saved.id,
    });

    const [afterDemote] = await supDb
      .select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(afterDemote?.tier).toBe(2);

    await promoteScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      memoryId: saved.id,
    });

    const [afterPromote] = await supDb
      .select({ tier: memories.tier })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(afterPromote?.tier).toBe(1);

    const found = await searchScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      query: marker,
    });
    expect(found.some((m) => m.id === saved.id && m.tier === 1)).toBe(true);
  });

  test("archiveScopeMemory moves a tier-1 scope memory directly to tier 3", async () => {
    const saved = await saveScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      type: "fact",
      content: `D442 scope archive ${Date.now()}`,
    });

    await archiveScopeMemory({
      speakerUserId: userId,
      agentId,
      scopeId,
      memoryId: saved.id,
    });

    const [archived] = await supDb
      .select({ tier: memories.tier, demotedFrom: memories.demotedFrom })
      .from(memories)
      .where(eq(memories.id, saved.id));
    expect(archived).toMatchObject({ tier: 3, demotedFrom: 1 });
  });
});
