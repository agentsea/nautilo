/**
 * D111 — concurrent `createSubthreadRoom` calls share one row (B4).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, createDirectDb, ensureDatabase, eq, rooms, roomMembers, sessionMessages, sessions, users, actors, namespaces } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createSubthreadRoom, joinOpenRoom } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let userId: string;
let actorId: string;
let parentRoomId: string;
let namespaceId: string;
let sessionId: string;
let anchorMessageId: number;
let joinerUserId: string;
let joinerActorId: string;
let joinRaceAnchorMessageId: number;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [u] = await db
    .insert(users)
    .values({
      name: "race-subthread",
      email: `race-st-${ts}@test.local`,
      handle: `racest${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  userId = u.id;

  const [act] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "Race actor",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!act) throw new Error("actor");
  actorId = act.id;

  const [joinerUser] = await db
    .insert(users)
    .values({
      name: "race-joiner",
      email: `race-join-${ts}@test.local`,
      handle: `racejoin${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!joinerUser) throw new Error("joiner user");
  joinerUserId = joinerUser.id;
  const [joinerActor] = await db
    .insert(actors)
    .values({
      ownerId: joinerUserId,
      displayName: "Race joiner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!joinerActor) throw new Error("joiner actor");
  joinerActorId = joinerActor.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `race-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");
  namespaceId = ns.id;

  const [rm] = await db
    .insert(rooms)
    .values({
      ownerId: userId,
      type: "private",
      label: "Race parent",
      graphThreadId: "pending",
      namespaceId: ns.id,
      humanActorIds: [actorId],
      kind: "open",
      createdBy: actorId,
    })
    .returning({ id: rooms.id });
  if (!rm) throw new Error("room");
  parentRoomId = rm.id;
  await db.update(rooms).set({ graphThreadId: `room:${rm.id}` }).where(eq(rooms.id, rm.id));

  await db.insert(roomMembers).values({
    roomId: parentRoomId,
    actorId,
    roomRole: "admin",
  });

  const [sess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${parentRoomId}`,
      ownerId: userId,
      personaId: "owner",
      roomId: parentRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("session");
  sessionId = sess.id;

  const [msg] = await db
    .insert(sessionMessages)
    .values({ sessionId: sess.id, role: "user", content: "anchor" })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("msg");
  anchorMessageId = msg.id;
  const [joinRaceMsg] = await db
    .insert(sessionMessages)
    .values({ sessionId: sess.id, role: "user", content: "join race anchor" })
    .returning({ id: sessionMessages.id });
  if (!joinRaceMsg) throw new Error("join race msg");
  joinRaceAnchorMessageId = joinRaceMsg.id;
});

afterAll(async () => {
  const subIds = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.kind, "subthread"),
        eq(rooms.parentRoomId, parentRoomId),
      ),
    );
  for (const r of subIds) {
    await db.delete(roomMembers).where(eq(roomMembers.roomId, r.id));
    await db.delete(rooms).where(eq(rooms.id, r.id));
  }
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, parentRoomId));
  await db.delete(rooms).where(eq(rooms.id, parentRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
  await db.delete(actors).where(eq(actors.id, actorId));
  await db.delete(actors).where(eq(actors.id, joinerActorId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, joinerUserId));
  await db.end();
});

describe("createSubthreadRoom concurrent create (B4)", () => {
  test("two parallel creates return the same subthreadRoomId", async () => {
    const [a, b] = await Promise.all([
      createSubthreadRoom({
        parentRoomId,
        anchorMessageId,
        requesterActorId: actorId,
      }),
      createSubthreadRoom({
        parentRoomId,
        anchorMessageId,
        requesterActorId: actorId,
      }),
    ]);
    expect(a.subthreadRoomId).toBe(b.subthreadRoomId);

    const rows = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.kind, "subthread"), eq(rooms.threadRootMessageId, anchorMessageId)));
    expect(rows).toHaveLength(1);
  });

  test("a concurrent open-room join cannot leave the created child behind", async () => {
    const [created, joined] = await Promise.all([
      createSubthreadRoom({
        parentRoomId,
        anchorMessageId: joinRaceAnchorMessageId,
        requesterActorId: actorId,
      }),
      joinOpenRoom({
        userId: joinerUserId,
        actorId: joinerActorId,
        roomId: parentRoomId,
      }),
    ]);

    expect(joined.membershipEvent?.actorId).toBe(joinerActorId);
    const [childMembership] = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, created.subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      )
      .limit(1);
    expect(childMembership?.actorId).toBe(joinerActorId);
  });
});
