/**
 * M033 Phase 6 — agent-scope-store attachMemoryToScope under Path C RLS.
 *
 * Exercises attachMemoryToScope through the nautilo_agent role with trust
 * context, including visibility guards and idempotency.
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
  memoryNamespaces,
  memoryScopes,
  namespaces,
  roomMembers,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { attachMemoryToScope } from "../../src/store/agent-scope-store";

let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let userId: string;
let actorId: string;
let agentId: string;
let otherAgentId: string;
let namespaceId: string;
let roomId: string;
let scopeId: string;
let scopeName: string;
let memoryId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  supDb = createDirectDb(1);
  agentDb = createDirectAgentDb(1);

  const ts = Date.now().toString(36);
  const [user] = await supDb
    .insert(users)
    .values({
      name: "m033-agent-scope-rls",
      email: `m033-agent-scope-${ts}@test.local`,
      handle: `m033as${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create user");
  userId = user.id;

  const [actor] = await supDb
    .insert(actors)
    .values({ ownerId: userId, displayName: "m033-agent-scope-rls", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create actor");
  actorId = actor.id;

  const [agent] = await supDb
    .insert(agents)
    .values({ handle: `m033-agent-scope-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create agent");
  agentId = agent.id;

  const [otherAgent] = await supDb
    .insert(agents)
    .values({ handle: `m033-other-agent-${ts}` })
    .returning({ id: agents.id });
  if (!otherAgent) throw new Error("Failed to create other agent");
  otherAgentId = otherAgent.id;

  const [ns] = await supDb
    .insert(namespaces)
    .values({ scope: "private", label: `M033 agent scope ${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("Failed to create namespace");
  namespaceId = ns.id;

  const [room] = await supDb
    .insert(rooms)
    .values({
      namespaceId,
      ownerId: userId,
      type: "private",
      label: `M033 agent scope ${ts}`,
      graphThreadId: `m033-agent-scope-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Failed to create room");
  roomId = room.id;

  await supDb.insert(roomMembers).values({ roomId, actorId });

  scopeName = `m033-attach-scope-${ts}`;
  const [scope] = await supDb
    .insert(agentScopes)
    .values({
      parentAgentId: agentId,
      speakerUserId: userId,
      name: scopeName,
    })
    .returning({ id: agentScopes.id });
  if (!scope) throw new Error("Failed to create agent scope");
  scopeId = scope.id;

  const [memory] = await supDb
    .insert(memories)
    .values({
      type: "fact",
      content: `M033 attach seed memory ${ts}`,
    })
    .returning({ id: memories.id });
  if (!memory) throw new Error("Failed to create memory");
  memoryId = memory.id;

  await supDb.insert(memoryNamespaces).values({
    memoryId,
    namespaceId,
  });
});

afterAll(async () => {
  try {
    if (supDb && userId) {
      await supDb.execute(sql`DELETE FROM memory_scopes WHERE scope_id = ${scopeId}`);
      await supDb.execute(sql`DELETE FROM memory_namespaces WHERE memory_id = ${memoryId}`);
      await supDb.delete(memories).where(eq(memories.id, memoryId));
      await supDb.delete(agentScopes).where(eq(agentScopes.id, scopeId));
      await supDb.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await supDb.delete(rooms).where(eq(rooms.id, roomId));
      await supDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await supDb.delete(actors).where(eq(actors.id, actorId));
      await supDb.delete(agents).where(eq(agents.id, otherAgentId));
      await supDb.delete(agents).where(eq(agents.id, agentId));
      await supDb.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await agentDb?.end();
    await supDb?.end();
  }
});

describe("agent-scope-store Path C RLS (M033 Phase 6)", () => {
  test("attachMemoryToScope attaches memory to scope", async () => {
    const result = await attachMemoryToScope(memoryId, scopeId, {
      agentId,
      speakerUserId: userId,
      readableNamespaceIds: [namespaceId],
    });

    expect(result).toEqual({ status: "attached", scopeName });

    const junction = await supDb
      .select({ memoryId: memoryScopes.memoryId, origin: memoryScopes.origin })
      .from(memoryScopes)
      .where(eq(memoryScopes.scopeId, scopeId));
    expect(junction.some((r) => r.memoryId === memoryId && r.origin === "seed")).toBe(true);
  });

  test("attachMemoryToScope is idempotent on second call", async () => {
    const result = await attachMemoryToScope(memoryId, scopeId, {
      agentId,
      speakerUserId: userId,
      readableNamespaceIds: [namespaceId],
    });

    expect(result).toEqual({ status: "already_attached", scopeName });
  });

  test("attachMemoryToScope rejects wrong agentId with scope_not_found", async () => {
    // M127 — Namespace is the only content-scope axis; memories no longer
    // carry agent_id and the Path C policy no longer narrows by
    // app.current_agent_id. So with a readable namespace the MEMORY is
    // visible regardless of agentId. What a wrong agentId still cannot see
    // is the SCOPE (agent_scopes remain parent_agent_id-scoped), so
    // attachMemoryToScope now fails at the scope lookup → `scope_not_found`
    // (pre-M127 the agent-narrowed memory lookup failed first →
    // `memory_not_found`).
    const result = await attachMemoryToScope(memoryId, scopeId, {
      agentId: otherAgentId,
      speakerUserId: userId,
      readableNamespaceIds: [namespaceId],
    });

    expect(result).toEqual({ error: "scope_not_found" });
  });

  test("attachMemoryToScope rejects empty readableNamespaceIds with memory_not_visible", async () => {
    const result = await attachMemoryToScope(memoryId, scopeId, {
      agentId,
      speakerUserId: userId,
      readableNamespaceIds: [],
    });

    expect(result).toEqual({ error: "memory_not_visible" });
  });

  test("agent_scopes rows are invisible without trust context (zero-rows regression)", async () => {
    const withoutTrust = await agentDb
      .select({ id: agentScopes.id })
      .from(agentScopes)
      .where(eq(agentScopes.id, scopeId));
    expect(withoutTrust).toHaveLength(0);
  });
});
