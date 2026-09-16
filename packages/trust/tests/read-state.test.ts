/**
 * D124 — read-state helpers (live Postgres).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

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
  sessions,
  sessionMessages,
  sessionMessageRecipientState,
  eq,
  and,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { getMessageReadState, markDelivered, markRead } from "../src/read-state";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

async function createUser(name: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      name,
      email: `${name}-${ts}@rs.test`,
      handle: `${name}${ts}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  return u.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor");
  return a.id;
}

describe("D124 read-state helpers", () => {
  test("markDelivered 1:1 sets scalar once; second call is idempotent", async () => {
    const u1 = await createUser("rs11a");
    const u2 = await createUser("rs11b");
    const a1 = await createHumanActor(u1, "A");
    const a2 = await createHumanActor(u2, "B");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `ns-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u1,
        type: "private",
        label: "dm-ish",
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [a1, a2],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: a1, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: room.id, actorId: a2, roomRole: "member" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: u1,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "hi" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markDelivered(msg.id, u2);
    await markDelivered(msg.id, u2);
    const [row] = await db
      .select({ deliveredAt: sessionMessages.deliveredAt })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, msg.id));
    expect(row?.deliveredAt).toBeTruthy();

    const st = await getMessageReadState(msg.id, u2);
    expect(st.shape).toBe("1:1");
    expect(st.selfDelivered).toBe(true);
    expect(st.deliveredCount).toBeGreaterThanOrEqual(1);

    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, a1));
    await db.delete(actors).where(eq(actors.id, a2));
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  });

  test("markDelivered group path uses junction", async () => {
    const u1 = await createUser("rsg1");
    const u2 = await createUser("rsg2");
    const u3 = await createUser("rsg3");
    const a1 = await createHumanActor(u1, "G1");
    const a2 = await createHumanActor(u2, "G2");
    const a3 = await createHumanActor(u3, "G3");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `nsg-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u1,
        type: "group",
        kind: "group",
        label: "grp",
        graphThreadId: `gtg-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [a1, a2, a3],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    for (const [aid, role] of [
      [a1, "admin"],
      [a2, "member"],
      [a3, "member"],
    ] as const) {
      await db.insert(roomMembers).values({ roomId: room.id, actorId: aid, roomRole: role });
    }
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag2-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: u1,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "all" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markDelivered(msg.id, u2);
    const [jr] = await db
      .select()
      .from(sessionMessageRecipientState)
      .where(
        and(
          eq(sessionMessageRecipientState.messageId, msg.id),
          eq(sessionMessageRecipientState.recipientId, u2),
        ),
      );
    expect(jr?.deliveredAt).toBeTruthy();

    const agg = await getMessageReadState(msg.id, u2);
    expect(agg.shape).toBe("group");
    expect(agg.selfDelivered).toBe(true);

    await db
      .delete(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msg.id));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    for (const aid of [a1, a2, a3]) {
      await db.delete(actors).where(eq(actors.id, aid));
    }
    for (const uid of [u1, u2, u3]) {
      await db.delete(users).where(eq(users.id, uid));
    }
  });

  test("markRead + getMessageReadState counts", async () => {
    const u1 = await createUser("rsr1");
    const u2 = await createUser("rsr2");
    const a1 = await createHumanActor(u1, "R1");
    const a2 = await createHumanActor(u2, "R2");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `nsr-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u1,
        type: "private",
        label: "pr",
        graphThreadId: `gtr-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [a1, a2],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: a1, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: room.id, actorId: a2, roomRole: "member" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag3-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: u1,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "x" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");
    await markDelivered(msg.id, u1);
    await markRead(msg.id, u1);
    const st = await getMessageReadState(msg.id, u1);
    expect(st.selfRead).toBe(true);
    expect(st.readCount).toBeGreaterThanOrEqual(1);

    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, a1));
    await db.delete(actors).where(eq(actors.id, a2));
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  });
});

/**
 * M158 (D-3 / MR4 + Phase 1c / MR7) — threshold lowered from n<3 to n<2, so
 * 2-human DMs now route through the per-recipient junction, and the group
 * branch of `getMessageReadState` excludes the message author from
 * `recipientCount`.
 *
 * These are LIVE-POSTGRES integration tests (they hit a real DB via
 * `createDirectDb`). They are NOT part of `test:unit` — run them only against a
 * scratch instance with a running Postgres.
 */
describe("M158 read-state threshold + receipt math (live Postgres)", () => {
  test("2-human DM uses junction after threshold change", async () => {
    const uA = await createUser("m158dmA");
    const uB = await createUser("m158dmB");
    const aA = await createHumanActor(uA, "A");
    const aB = await createHumanActor(uB, "B");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `ns-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: uA,
        type: "private",
        label: "dm",
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [aA, aB],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: aA, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: room.id, actorId: aB, roomRole: "member" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: uA,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "from A" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markRead(msg.id, uB);

    const st = await getMessageReadState(msg.id, uB);
    expect(st.shape).toBe("group");

    // Junction path does not touch the scalar column: A's unread is NOT cleared.
    const [scalarRow] = await db
      .select({ readAt: sessionMessages.readAt })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, msg.id));
    expect(scalarRow?.readAt).toBeNull();

    // B has a read row; A (the author) does not.
    const [bRow] = await db
      .select({ readAt: sessionMessageRecipientState.readAt })
      .from(sessionMessageRecipientState)
      .where(
        and(
          eq(sessionMessageRecipientState.messageId, msg.id),
          eq(sessionMessageRecipientState.recipientId, uB),
        ),
      );
    expect(bRow?.readAt).toBeTruthy();
    const aRows = await db
      .select({ readAt: sessionMessageRecipientState.readAt })
      .from(sessionMessageRecipientState)
      .where(
        and(
          eq(sessionMessageRecipientState.messageId, msg.id),
          eq(sessionMessageRecipientState.recipientId, uA),
        ),
      );
    expect(aRows.length).toBe(0);

    await db
      .delete(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msg.id));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, aA));
    await db.delete(actors).where(eq(actors.id, aB));
    await db.delete(users).where(eq(users.id, uA));
    await db.delete(users).where(eq(users.id, uB));
  });

  test("2-human DM receipt math (MR7): recipientCount excludes author", async () => {
    const uA = await createUser("m158rmA");
    const uB = await createUser("m158rmB");
    const aA = await createHumanActor(uA, "A");
    const aB = await createHumanActor(uB, "B");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `ns-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: uA,
        type: "private",
        label: "dm",
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [aA, aB],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: aA, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: room.id, actorId: aB, roomRole: "member" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: uA,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "from A" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markRead(msg.id, uB);

    const st = await getMessageReadState(msg.id, uB);
    expect(st.shape).toBe("group");
    // Author A excluded → only B counts → fully read → "Read by all".
    expect(st.recipientCount).toBe(1);
    expect(st.readCount).toBe(1);

    await db
      .delete(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msg.id));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, aA));
    await db.delete(actors).where(eq(actors.id, aB));
    await db.delete(users).where(eq(users.id, uA));
    await db.delete(users).where(eq(users.id, uB));
  });

  test("3+-human group receipt math: author excluded, both readers counted", async () => {
    const uA = await createUser("m158gA");
    const uB = await createUser("m158gB");
    const uC = await createUser("m158gC");
    const aA = await createHumanActor(uA, "A");
    const aB = await createHumanActor(uB, "B");
    const aC = await createHumanActor(uC, "C");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `ns-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: uA,
        type: "group",
        kind: "group",
        label: "grp",
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [aA, aB, aC],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    for (const [aid, role] of [
      [aA, "admin"],
      [aB, "member"],
      [aC, "member"],
    ] as const) {
      await db.insert(roomMembers).values({ roomId: room.id, actorId: aid, roomRole: role });
    }
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: uA,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "from A" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markRead(msg.id, uB);
    await markRead(msg.id, uC);

    const st = await getMessageReadState(msg.id, uB);
    expect(st.shape).toBe("group");
    // 3 humans − author A = 2 recipients; both B and C read.
    expect(st.recipientCount).toBe(2);
    expect(st.readCount).toBe(2);

    await db
      .delete(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msg.id));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    for (const aid of [aA, aB, aC]) {
      await db.delete(actors).where(eq(actors.id, aid));
    }
    for (const uid of [uA, uB, uC]) {
      await db.delete(users).where(eq(users.id, uid));
    }
  });

  test("1-human room (user↔agent) uses scalar", async () => {
    const u1 = await createUser("m158s1");
    const a1 = await createHumanActor(u1, "U");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `ns-${randomUUID()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u1,
        type: "private",
        label: "ua",
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: ns.id,
        humanActorIds: [a1],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: a1, roomRole: "admin" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `ag-${randomUUID()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: u1,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "assistant", content: "from agent" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    await markRead(msg.id, u1);

    const st = await getMessageReadState(msg.id, u1);
    expect(st.shape).toBe("1:1");

    const [scalarRow] = await db
      .select({ readAt: sessionMessages.readAt })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, msg.id));
    expect(scalarRow?.readAt).toBeTruthy();

    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, a1));
    await db.delete(users).where(eq(users.id, u1));
  });
});
