/**
 * Stack 74 (D194) — adding a member to a room writes EXACTLY ONE
 * "joined the room" system transcript row, regardless of how many human
 * members the room already has.
 *
 * Regression: `appendRoomMembershipSystemMessagesInTx` used to fan out one
 * row per human member-owner session. Because the room transcript reader
 * (`getRoomMessagesAcrossMemberSessions`) aggregates `session_messages`
 * across every member session by `room_id` and only de-dupes `role=user`
 * rows, an N-human room surfaced the same join line N times. The fix homes
 * a single row in the room owner's session.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  and,
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  eq,
  inArray,
} from "@nautilo/db";
import { randomUUID } from "node:crypto";
import { addRoomMember, removeRoomMember } from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let roomId: string;
let namespaceId: string;
// Three humans already in the room (owner + two members) before the add.
const seededUserIds: string[] = [];
const seededActorIds: string[] = [];
// The fourth human, added during the test.
let newUserId: string;
let newActorId: string;

const NEW_MEMBER_DISPLAY_NAME = "New Member RegressionTest";

async function seedHuman(label: string): Promise<{ userId: string; actorId: string }> {
  const ts = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const [user] = await db
    .insert(users)
    .values({
      name: `s74-${label}`,
      email: `s74-${label}-${ts}@test.local`,
      handle: `s74${label}${ts}`.replace(/[^a-z0-9]/gi, "").slice(0, 40),
    })
    .returning({ id: users.id });
  if (!user) throw new Error(`seedHuman: user insert failed (${label})`);

  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: label === "newmember" ? NEW_MEMBER_DISPLAY_NAME : `s74 ${label}`,
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error(`seedHuman: actor insert failed (${label})`);

  return { userId: user.id, actorId: actor.id };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  // Owner + two existing members = three humans already in the room.
  const owner = await seedHuman("owner");
  const member2 = await seedHuman("member2");
  const member3 = await seedHuman("member3");
  seededUserIds.push(owner.userId, member2.userId, member3.userId);
  seededActorIds.push(owner.actorId, member2.actorId, member3.actorId);

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `s74-${Date.now().toString(36)}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  namespaceId = ns.id;

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: owner.userId,
    type: "private",
    kind: "private",
    label: "Three-human room",
    graphThreadId: `room:${roomId}`,
    namespaceId,
    humanActorIds: seededActorIds,
    createdBy: owner.actorId,
  });

  await db.insert(roomMembers).values([
    { roomId, actorId: owner.actorId, roomRole: "admin" },
    { roomId, actorId: member2.actorId, roomRole: "member" },
    { roomId, actorId: member3.actorId, roomRole: "member" },
  ]);

  // Give each existing human a session in the room — this is what the old
  // fan-out wrote into (one join row per session), so the regression only
  // bites when multiple member sessions exist.
  for (const actorId of seededActorIds) {
    const [owns] = await db
      .select({ ownerId: actors.ownerId })
      .from(actors)
      .where(eq(actors.id, actorId))
      .limit(1);
    if (!owns?.ownerId) continue;
    await db.insert(sessions).values({
      threadId: `room:${roomId}`,
      ownerId: owns.ownerId,
      personaId: "owner",
      roomId,
    });
  }

  const newMember = await seedHuman("newmember");
  newUserId = newMember.userId;
  newActorId = newMember.actorId;
});

afterAll(async () => {
  if (!db) return;
  try {
    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, roomId));
    const sessIds = sessRows.map((s) => s.id);
    if (sessIds.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
      await db.delete(sessions).where(inArray(sessions.id, sessIds));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    if (namespaceId) {
      await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    }
    const actorIds = [...seededActorIds, newActorId].filter(Boolean);
    if (actorIds.length > 0) {
      await db.delete(actors).where(inArray(actors.id, actorIds));
    }
    const userIds = [...seededUserIds, newUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  } finally {
    await db.end();
  }
});

describe("addRoomMember system message (Stack 74 / D194)", () => {
  test("writes exactly one join system row in a 3-human room", async () => {
    const { membershipEvent, membershipMessageId, humanMembershipTransitions } = await addRoomMember(
      roomId,
      { userId: newUserId },
      "member",
    );
    expect(membershipEvent?.kind).toBe("member_added");
    expect(humanMembershipTransitions).toHaveLength(1);
    const transition = humanMembershipTransitions?.[0];
    expect(transition).toMatchObject({
      kind: "human_add",
      targetHumanActorId: newActorId,
      previous: {
        roomId,
        namespaceId,
        participantHumanActorIds: [...seededActorIds].sort(),
      },
      current: {
        roomId,
        namespaceId,
        participantHumanActorIds: [...seededActorIds, newActorId].sort(),
      },
    });
    expect(transition?.current.namespaceAccessRevision).toBe(
      (transition?.previous.namespaceAccessRevision ?? -2) + 1,
    );

    // Count membership system rows for the NEW member across EVERY session
    // in the room (the aggregated-transcript view). The sidecar JSON in
    // `tool_calls` carries the joined actor's id.
    const rows = await db
      .select({
        id: sessionMessages.id,
        content: sessionMessages.content,
        toolCalls: sessionMessages.toolCalls,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(and(eq(sessions.roomId, roomId), eq(sessionMessages.role, "system")));

    const joinRows = rows.filter(
      (r) => typeof r.toolCalls === "string" && r.toolCalls.includes(newActorId),
    );

    // Pre-fix this was 4 (one per human member-owner session). Post-fix: 1.
    expect(joinRows.length).toBe(1);
    expect(membershipMessageId).toBe(joinRows[0]?.id);
    expect(joinRows[0]?.content).toContain("joined the room");
    expect(joinRows[0]?.content).toContain(NEW_MEMBER_DISPLAY_NAME);
  });
  test("leave and rejoin return distinct committed occurrence identities", async () => {
    const left = await removeRoomMember(roomId, newActorId, {});
    const rejoined = await addRoomMember(roomId, { userId: newUserId }, "member");
    expect(left.membershipMessageId).toBeNumber();
    expect(rejoined.membershipMessageId).toBeNumber();
    expect(left.membershipMessageId).not.toBe(rejoined.membershipMessageId);
    const messages = await db.select({ id: sessionMessages.id })
      .from(sessionMessages).where(inArray(sessionMessages.id, [left.membershipMessageId!, rejoined.membershipMessageId!]));
    expect(messages).toHaveLength(2);
    const duplicate = await addRoomMember(roomId, { userId: newUserId }, "member").catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(Error);
  });

  test("internal task membership keeps its system message but has no feed occurrence", async () => {
    await db.update(rooms).set({ kind: "task" }).where(eq(rooms.id, roomId));
    try {
      const left = await removeRoomMember(roomId, newActorId, {});
      expect(left.membershipEvent?.kind).toBe("member_removed");
      expect(left.membershipMessageId).toBeUndefined();
    } finally {
      await db.update(rooms).set({ kind: "private" }).where(eq(rooms.id, roomId));
    }
  });

});
