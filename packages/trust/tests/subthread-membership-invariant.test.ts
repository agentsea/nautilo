/**
 * D111 — Subthread membership invariants (live Postgres).
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
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  addRoomMember,
  createSubthreadRoom,
  removeRoomMember,
  MembershipOpError,
} from "../src/queries";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  await db.end();
});

describe("D111 subthread membership invariants", () => {
  test("createSubthreadRoom inherits parent namespace_id", async () => {
    const ts = Date.now().toString(36);
    const [owner] = await db
      .insert(users)
      .values({
        name: "st-ns",
        email: `st-ns-${ts}@test.local`,
      })
      .returning({ id: users.id });
    if (!owner) throw new Error("owner");
    const [human] = await db
      .insert(actors)
      .values({ ownerId: owner.id, displayName: "H", kind: "user" })
      .returning({ id: actors.id });
    if (!human) throw new Error("human");
    const [ag] = await db
      .insert(agents)
      .values({ handle: `st-ag-${ts}` })
      .returning({ id: agents.id });
    if (!ag) throw new Error("agent");
    const [agentAct] = await db
      .insert(actors)
      .values({
        ownerId: owner.id,
        displayName: "AA",
        kind: "agent",
        agentId: ag.id,
      })
      .returning({ id: actors.id });
    if (!agentAct) throw new Error("agentAct");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "st" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const parentId = randomUUID();
    await db.insert(rooms).values({
      id: parentId,
      ownerId: owner.id,
      type: "private",
      label: "P",
      graphThreadId: `room:${parentId}`,
      namespaceId: ns.id,
      humanActorIds: [human.id],
      createdBy: human.id,
    });
    await db.insert(roomMembers).values([
      { roomId: parentId, actorId: human.id, roomRole: "admin" },
      { roomId: parentId, actorId: agentAct.id, roomRole: "member" },
    ]);
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${parentId}`,
        ownerId: owner.id,
        personaId: "owner",
        agentId: ag.id,
        roomId: parentId,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "root" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    const { subthreadRoomId } = await createSubthreadRoom({
      parentRoomId: parentId,
      anchorMessageId: msg.id,
      label: "thr",
      requesterActorId: human.id,
    });

    const [st] = await db
      .select({ namespaceId: rooms.namespaceId, humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, subthreadRoomId))
      .limit(1);
    expect(st?.namespaceId).toBe(ns.id);
    expect(st?.humanActorIds).toEqual([human.id]);

    await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parentId));
    await db.delete(rooms).where(eq(rooms.id, parentId));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.ownerId, owner.id));
    await db.delete(agents).where(eq(agents.id, ag.id));
    await db.delete(users).where(eq(users.id, owner.id));
  });

  test("addRoomMember rejects actor not in parent when room is subthread", async () => {
    const ts = Date.now().toString(36);
    const [u1] = await db
      .insert(users)
      .values({
        name: "st-a",
        email: `st-a-${ts}@test.local`,
      })
      .returning({ id: users.id });
    const [u2] = await db
      .insert(users)
      .values({
        name: "st-b",
        email: `st-b-${ts}@test.local`,
      })
      .returning({ id: users.id });
    if (!u1 || !u2) throw new Error("users");
    const [a1] = await db
      .insert(actors)
      .values({ ownerId: u1.id, displayName: "A1", kind: "user" })
      .returning({ id: actors.id });
    const [a2] = await db
      .insert(actors)
      .values({ ownerId: u2.id, displayName: "A2", kind: "user" })
      .returning({ id: actors.id });
    if (!a1 || !a2) throw new Error("actors");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "st2" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const parentId = randomUUID();
    await db.insert(rooms).values({
      id: parentId,
      ownerId: u1.id,
      type: "private",
      label: "P2",
      graphThreadId: `room:${parentId}`,
      namespaceId: ns.id,
      humanActorIds: [a1.id],
      createdBy: a1.id,
    });
    await db.insert(roomMembers).values({ roomId: parentId, actorId: a1.id, roomRole: "admin" });
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${parentId}`,
        ownerId: u1.id,
        personaId: "owner",
        roomId: parentId,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "m" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");
    const { subthreadRoomId } = await createSubthreadRoom({
      parentRoomId: parentId,
      anchorMessageId: msg.id,
      requesterActorId: a1.id,
    });

    try {
      await addRoomMember(subthreadRoomId, { userId: u2.id }, "member");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(MembershipOpError);
    }

    await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parentId));
    await db.delete(rooms).where(eq(rooms.id, parentId));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, a1.id));
    await db.delete(actors).where(eq(actors.id, a2.id));
    await db.delete(users).where(eq(users.id, u1.id));
    await db.delete(users).where(eq(users.id, u2.id));
  });

  test("removeRoomMember cascades removal from child subthread", async () => {
    const ts = Date.now().toString(36);
    const [u1] = await db
      .insert(users)
      .values({
        name: "st-rm-a",
        email: `st-rm-a-${ts}@test.local`,
      })
      .returning({ id: users.id });
    const [u2] = await db
      .insert(users)
      .values({
        name: "st-rm-b",
        email: `st-rm-b-${ts}@test.local`,
      })
      .returning({ id: users.id });
    if (!u1 || !u2) throw new Error("users");
    const [a1] = await db
      .insert(actors)
      .values({ ownerId: u1.id, displayName: "O", kind: "user" })
      .returning({ id: actors.id });
    const [a2] = await db
      .insert(actors)
      .values({ ownerId: u2.id, displayName: "G", kind: "user" })
      .returning({ id: actors.id });
    if (!a1 || !a2) throw new Error("actors");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "st3" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const parentId = randomUUID();
    await db.insert(rooms).values({
      id: parentId,
      ownerId: u1.id,
      type: "private",
      label: "P3",
      graphThreadId: `room:${parentId}`,
      namespaceId: ns.id,
      humanActorIds: [a1.id, a2.id].sort(),
      createdBy: a1.id,
    });
    await db.insert(roomMembers).values([
      { roomId: parentId, actorId: a1.id, roomRole: "admin" },
      { roomId: parentId, actorId: a2.id, roomRole: "member" },
    ]);
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${parentId}`,
        ownerId: u1.id,
        personaId: "owner",
        roomId: parentId,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "root2" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");
    const { subthreadRoomId } = await createSubthreadRoom({
      parentRoomId: parentId,
      anchorMessageId: msg.id,
      requesterActorId: a1.id,
    });

    const inSubBefore = await db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, subthreadRoomId));
    expect(inSubBefore.some((m) => m.actorId === a2.id)).toBe(true);

    const { humanMembershipTransitions } = await removeRoomMember(
      parentId,
      a2.id,
      {},
    );

    expect(humanMembershipTransitions).toHaveLength(1);
    const transition = humanMembershipTransitions?.[0];
    expect(transition).toMatchObject({
      kind: "human_remove",
      targetHumanActorId: a2.id,
      previous: {
        roomId: parentId,
        namespaceId: ns.id,
        participantHumanActorIds: [a1.id, a2.id].sort(),
      },
      current: {
        roomId: parentId,
        namespaceId: ns.id,
        participantHumanActorIds: [a1.id],
      },
    });
    expect(transition?.current.namespaceAccessRevision).toBe(
      (transition?.previous.namespaceAccessRevision ?? -2) + 1,
    );

    const inSubAfter = await db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, subthreadRoomId));
    expect(inSubAfter.some((m) => m.actorId === a2.id)).toBe(false);

    // removeRoomMember appends a `system` membership message into each
    // member-owner's room session (reusing the existing session or minting
    // one per owner), so teardown must clear ALL sessions/messages scoped to
    // these rooms — not just the one anchor message — or the FK from
    // session_messages → sessions blocks the deletes.
    const roomScope = [parentId, subthreadRoomId];
    const scopedSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.roomId, roomScope));
    const scopedSessionIds = scopedSessions.map((s) => s.id);
    await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
    if (scopedSessionIds.length > 0) {
      await db
        .delete(sessionMessages)
        .where(inArray(sessionMessages.sessionId, scopedSessionIds));
      await db.delete(sessions).where(inArray(sessions.id, scopedSessionIds));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parentId));
    await db.delete(rooms).where(eq(rooms.id, parentId));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, a1.id));
    await db.delete(actors).where(eq(actors.id, a2.id));
    await db.delete(users).where(eq(users.id, u1.id));
    await db.delete(users).where(eq(users.id, u2.id));
  });
});
