/**
 * M076 — cascadeMemoriesOnNamespaceDelete (live Postgres).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  memories,
  memoryNamespaces,
  eq,
  sql,
  and,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { cascadeMemoriesOnNamespaceDelete } from "../../src/memory-cascade";

let db: ReturnType<typeof createDirectDb>;

let ownerId: string;
let mainAgentId: string;
let ghostAgentId: string;
let humanActorId: string;
let mainAgentActorId: string;
let partnerHumanActorId: string;

let privateNsId: string;
let familyNsId: string;

let privateRoomId: string;
let familyRoomId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [user] = await db
    .insert(users)
    .values({
      name: "m076-cascade",
      email: `m076c-${ts}@test.local`,
      handle: `m076c${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user");
  ownerId = user.id;

  const [human] = await db
    .insert(actors)
    .values({ ownerId, displayName: "Owner", kind: "user" })
    .returning({ id: actors.id });
  if (!human) throw new Error("human");
  humanActorId = human.id;

  const [partner] = await db
    .insert(actors)
    .values({ ownerId, displayName: "Partner", kind: "user" })
    .returning({ id: actors.id });
  if (!partner) throw new Error("partner");
  partnerHumanActorId = partner.id;

  const [mainAg] = await db
    .insert(agents)
    .values({ handle: `m076-main-${ts}` })
    .returning({ id: agents.id });
  if (!mainAg) throw new Error("main agent");
  mainAgentId = mainAg.id;

  const [ghostAg] = await db
    .insert(agents)
    .values({ handle: `m076-ghost-${ts}` })
    .returning({ id: agents.id });
  if (!ghostAg) throw new Error("ghost agent");
  ghostAgentId = ghostAg.id;

  const [mainAct] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Main mir",
      kind: "agent",
      agentId: mainAgentId,
    })
    .returning({ id: actors.id });
  if (!mainAct) throw new Error("main actor");
  mainAgentActorId = mainAct.id;

  await db.insert(actors).values({
    ownerId,
    displayName: "Ghost mir",
    kind: "agent",
    agentId: ghostAgentId,
  });

  const [nsP] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m076-priv-${ts}` })
    .returning({ id: namespaces.id });
  const [nsF] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `m076-fam-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsP || !nsF) throw new Error("ns");
  privateNsId = nsP.id;
  familyNsId = nsF.id;

  privateRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privateRoomId,
    ownerId,
    type: "private",
    label: "private 1:1",
    graphThreadId: `room:${privateRoomId}`,
    namespaceId: privateNsId,
    humanActorIds: [humanActorId],
  });
  await db.insert(roomMembers).values([
    { roomId: privateRoomId, actorId: humanActorId, roomRole: "member" },
    { roomId: privateRoomId, actorId: mainAgentActorId, roomRole: "member" },
  ]);

  familyRoomId = randomUUID();
  const humanSorted = [humanActorId, partnerHumanActorId].sort();
  await db.insert(rooms).values({
    id: familyRoomId,
    ownerId,
    type: "shared",
    label: "family",
    graphThreadId: `room:${familyRoomId}`,
    namespaceId: familyNsId,
    humanActorIds: humanSorted,
  });
  await db.insert(roomMembers).values([
    { roomId: familyRoomId, actorId: humanActorId, roomRole: "member" },
    { roomId: familyRoomId, actorId: partnerHumanActorId, roomRole: "member" },
    { roomId: familyRoomId, actorId: mainAgentActorId, roomRole: "member" },
  ]);
});

afterAll(async () => {
  if (!db) return;
  // M127: memories no longer carry agent_id — Namespace is the only
  // scope axis. Clean up any memory still attached to THIS test's
  // namespaces via the memory_namespaces junction (the junction→
  // namespaces FK is RESTRICT, so a leftover edge would otherwise block
  // the namespace deletes below; deleting the memory cascades the edge).
  await db.execute(
    sql`DELETE FROM memories WHERE id IN (
      SELECT memory_id FROM memory_namespaces
       WHERE namespace_id IN (${privateNsId}::uuid, ${familyNsId}::uuid)
    )`,
  );
  await db.delete(roomMembers).where(eq(roomMembers.roomId, privateRoomId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, familyRoomId));
  await db.delete(rooms).where(eq(rooms.id, privateRoomId));
  await db.delete(rooms).where(eq(rooms.id, familyRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, privateNsId));
  await db.delete(namespaces).where(eq(namespaces.id, familyNsId));

  const ghostAct = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, ghostAgentId), eq(actors.kind, "agent")));
  for (const r of ghostAct) {
    await db.delete(actors).where(eq(actors.id, r.id));
  }
  await db.delete(agents).where(eq(agents.id, ghostAgentId));

  await db.delete(actors).where(eq(actors.id, mainAgentActorId));
  await db.delete(actors).where(eq(actors.id, partnerHumanActorId));
  await db.delete(actors).where(eq(actors.id, humanActorId));
  await db.delete(agents).where(eq(agents.id, mainAgentId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.end();
});

describe("cascadeMemoriesOnNamespaceDelete (integration)", () => {
  test("multi-attached memory survives when detaching one namespace edge", async () => {
    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-ma-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");
    await db.insert(memoryNamespaces).values([
      { memoryId: mem.id, namespaceId: privateNsId },
      { memoryId: mem.id, namespaceId: familyNsId },
    ]);

    const sum = await cascadeMemoriesOnNamespaceDelete(familyNsId);
    expect(sum).toEqual({ detached: 1, fellBackTo: 0, deleted: 0 });

    const edges = await db
      .select({ ns: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, mem.id));
    expect(edges.map((e) => e.ns).sort()).toEqual([privateNsId].sort());

    await db.delete(memories).where(eq(memories.id, mem.id));
  });

  test("solo private edge deletes memory when cascading that namespace (no re-home)", async () => {
    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-solo-p-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: mem.id,
      namespaceId: privateNsId,
    });

    const sum = await cascadeMemoriesOnNamespaceDelete(privateNsId);
    expect(sum).toEqual({ detached: 1, fellBackTo: 0, deleted: 1 });

    const remaining = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, mem.id))
      .limit(1);
    expect(remaining.length).toBe(0);
  });

  test("solo family edge deletes memory when it was the only namespace (M081)", async () => {
    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-solo-fam-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: mem.id,
      namespaceId: familyNsId,
    });

    const sum = await cascadeMemoriesOnNamespaceDelete(familyNsId);
    expect(sum).toEqual({ detached: 1, fellBackTo: 0, deleted: 1 });

    const remaining = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, mem.id))
      .limit(1);
    expect(remaining.length).toBe(0);
  });

  test("mixed batch on one namespace processes multi-attach vs solo-edge deletes (M081)", async () => {
    const [m1] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-mix1-${Date.now()}`,
      })
      .returning({ id: memories.id });
    const [m2] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-mix2-${Date.now()}`,
      })
      .returning({ id: memories.id });
    const [m3] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-mix3-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!m1 || !m2 || !m3) throw new Error("mem");

    await db.insert(memoryNamespaces).values([
      { memoryId: m1.id, namespaceId: privateNsId },
      { memoryId: m1.id, namespaceId: familyNsId },
      { memoryId: m2.id, namespaceId: familyNsId },
      { memoryId: m3.id, namespaceId: familyNsId },
    ]);

    const sum = await cascadeMemoriesOnNamespaceDelete(familyNsId);
    expect(sum).toEqual({ detached: 3, fellBackTo: 0, deleted: 2 });

    const e1 = await db
      .select({ ns: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, m1.id));
    expect(e1.map((x) => x.ns)).toEqual([privateNsId]);

    const m2row = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, m2.id))
      .limit(1);
    expect(m2row.length).toBe(0);

    const m3row = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, m3.id))
      .limit(1);
    expect(m3row.length).toBe(0);

    await db.delete(memories).where(eq(memories.id, m1.id));
  });

  test("injected fault after detach rolls back — junction edge preserved", async () => {
    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m076-fault-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: mem.id,
      namespaceId: familyNsId,
    });

    let threw = false;
    try {
      await cascadeMemoriesOnNamespaceDelete(familyNsId, {
        testFaultAfterDetachForMemoryId: mem.id,
      });
    } catch (e) {
      threw =
        e instanceof Error && /injected cascade fault/i.test(e.message);
    }
    expect(threw).toBe(true);

    const edges = await db
      .select({ ns: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, mem.id));
    expect(edges.map((e) => e.ns)).toEqual([familyNsId]);

    await db.delete(memoryNamespaces).where(eq(memoryNamespaces.memoryId, mem.id));
    await db.delete(memories).where(eq(memories.id, mem.id));
  });
});
