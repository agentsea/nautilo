/**
 * M076 — findAgentOwnerPrivateRoom shape (live Postgres).
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
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { findAgentOwnerPrivateRoom } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let agentId: string;
let humanActorId: string;
let agentActorId: string;
let privateNsId: string;
let roomId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [user] = await db
    .insert(users)
    .values({
      name: "m076-find-private",
      email: `m076fp-${ts}@test.local`,
      handle: `m076fp${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user");
  ownerId = user.id;

  const [human] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Owner human",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!human) throw new Error("human actor");
  humanActorId = human.id;

  const [agent] = await db
    .insert(agents)
    .values({ handle: `m076-ag-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent");
  agentId = agent.id;

  const [agentAct] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Agent mirror",
      kind: "agent",
      agentId,
    })
    .returning({ id: actors.id });
  if (!agentAct) throw new Error("agent actor");
  agentActorId = agentAct.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m076-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");
  privateNsId = ns.id;

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "1:1 private",
    graphThreadId: `room:${roomId}`,
    namespaceId: privateNsId,
    humanActorIds: [humanActorId],
  });

  await db.insert(roomMembers).values([
    { roomId, actorId: humanActorId, roomRole: "member" },
    { roomId, actorId: agentActorId, roomRole: "member" },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));
  await db.delete(namespaces).where(eq(namespaces.id, privateNsId));
  await db.delete(actors).where(eq(actors.id, agentActorId));
  await db.delete(actors).where(eq(actors.id, humanActorId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.end();
});

describe("findAgentOwnerPrivateRoom (integration)", () => {
  test("returns the canonical 2-member human+agent room", async () => {
    const got = await findAgentOwnerPrivateRoom(ownerId, agentId);
    expect(got).not.toBeNull();
    expect(got!.roomId).toBe(roomId);
    expect(got!.namespaceId).toBe(privateNsId);
  });

  test("returns null when a third member joins the room", async () => {
    const [extraHuman] = await db
      .insert(actors)
      .values({
        ownerId,
        displayName: "extra",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!extraHuman) throw new Error("extra");
    await db.insert(roomMembers).values({
      roomId,
      actorId: extraHuman.id,
      roomRole: "member",
    });

    const got = await findAgentOwnerPrivateRoom(ownerId, agentId);
    expect(got).toBeNull();

    await db
      .delete(roomMembers)
      .where(eq(roomMembers.actorId, extraHuman.id));
    await db.delete(actors).where(eq(actors.id, extraHuman.id));
  });

  test("returns null when no agent mirror actor exists for the agent id", async () => {
    const [ghost] = await db
      .insert(agents)
      .values({ handle: `m076-ghost-${Date.now()}` })
      .returning({ id: agents.id });
    if (!ghost) throw new Error("ghost");
    const got = await findAgentOwnerPrivateRoom(ownerId, ghost.id);
    expect(got).toBeNull();
    await db.delete(agents).where(eq(agents.id, ghost.id));
  });

  test("returns canonical room when rooms.owner_id is not the memory owner (provisioned under another user)", async () => {
    const ts = Date.now().toString(36);
    const [alex] = await db
      .insert(users)
      .values({
        name: "m076-alex",
        email: `m076dan-${ts}@test.local`,
        handle: `m076dan${ts.slice(-6)}`,
      })
      .returning({ id: users.id });
    const [jordan] = await db
      .insert(users)
      .values({
        name: "m076-jordan",
        email: `m076jordan-${ts}@test.local`,
        handle: `m076al${ts.slice(-6)}`,
      })
      .returning({ id: users.id });
    if (!alex || !jordan) throw new Error("users");

    const [jordanHuman] = await db
      .insert(actors)
      .values({
        ownerId: jordan.id,
        displayName: "Jordan",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!jordanHuman) throw new Error("jordan actor");

    const [nsAlt] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `m076-alt-${ts}` })
      .returning({ id: namespaces.id });
    if (!nsAlt) throw new Error("ns");

    const altRoomId = randomUUID();
    await db.insert(rooms).values({
      id: altRoomId,
      ownerId: alex.id,
      type: "private",
      label: "Jordan+agent, Alex-owned row",
      graphThreadId: `room:${altRoomId}`,
      namespaceId: nsAlt.id,
      humanActorIds: [jordanHuman.id],
    });
    await db.insert(roomMembers).values([
      { roomId: altRoomId, actorId: jordanHuman.id, roomRole: "member" },
      { roomId: altRoomId, actorId: agentActorId, roomRole: "member" },
    ]);

    const got = await findAgentOwnerPrivateRoom(jordan.id, agentId);
    expect(got).not.toBeNull();
    expect(got!.roomId).toBe(altRoomId);
    expect(got!.namespaceId).toBe(nsAlt.id);

    await db.delete(roomMembers).where(eq(roomMembers.roomId, altRoomId));
    await db.delete(rooms).where(eq(rooms.id, altRoomId));
    await db.delete(namespaces).where(eq(namespaces.id, nsAlt.id));
    await db.delete(actors).where(eq(actors.id, jordanHuman.id));
    await db.delete(users).where(eq(users.id, alex.id));
    await db.delete(users).where(eq(users.id, jordan.id));
  });
});
