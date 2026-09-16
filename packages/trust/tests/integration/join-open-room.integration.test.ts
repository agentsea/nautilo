/**
 * M124 — `joinOpenRoom` self-join rails for open rooms (trust + DB).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
  roomJournalState,
  eq,
  inArray,
} from "@nautilo/db";
import {
  createOpenRoom,
  createSubthreadRoom,
  getRoomDetailForMember,
  joinOpenRoom,
  MembershipOpError,
} from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let creatorUserId: string;
let creatorActorId: string;
let joinerUserId: string;
let joinerActorId: string;
let openRoomId: string;
let openNamespaceId: string;
let subthreadRoomId: string;
let anchorMessageId: number;
let privateRoomId: string;
let privateNamespaceId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [creator] = await db
    .insert(users)
    .values({
      name: "m124-join-creator",
      email: `m124joinc-${ts}@test.local`,
      handle: `m124jc${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!creator) throw new Error("creator user");
  creatorUserId = creator.id;

  const [creatorActor] = await db
    .insert(actors)
    .values({
      ownerId: creatorUserId,
      displayName: "Creator",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!creatorActor) throw new Error("creator actor");
  creatorActorId = creatorActor.id;

  const openRoom = await createOpenRoom({
    creatorUserId,
    creatorActorId,
    label: "#join-me",
  });
  openRoomId = openRoom.id;

  const [openRow] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, openRoomId))
    .limit(1);
  if (!openRow) throw new Error("open room");
  openNamespaceId = openRow.namespaceId;

  const [openSession] = await db
    .insert(sessions)
    .values({
      threadId: `room:${openRoomId}`,
      ownerId: creatorUserId,
      personaId: "owner",
      roomId: openRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!openSession) throw new Error("open session");
  const [anchor] = await db
    .insert(sessionMessages)
    .values({ sessionId: openSession.id, role: "user", content: "thread root" })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("thread anchor");
  anchorMessageId = anchor.id;
  ({ subthreadRoomId } = await createSubthreadRoom({
    parentRoomId: openRoomId,
    anchorMessageId: anchor.id,
    requesterActorId: creatorActorId,
  }));

  const [joiner] = await db
    .insert(users)
    .values({
      name: "m124-join-joiner",
      email: `m124joinj-${ts}@test.local`,
      handle: `m124jj${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!joiner) throw new Error("joiner user");
  joinerUserId = joiner.id;

  const [joinerActor] = await db
    .insert(actors)
    .values({
      ownerId: joinerUserId,
      displayName: "Joiner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!joinerActor) throw new Error("joiner actor");
  joinerActorId = joinerActor.id;

  const [privateNs] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m124-private-${ts}` })
    .returning({ id: namespaces.id });
  if (!privateNs) throw new Error("private namespace");
  privateNamespaceId = privateNs.id;

  privateRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privateRoomId,
    ownerId: creatorUserId,
    type: "private",
    kind: "private",
    label: "Private room",
    graphThreadId: `room:${privateRoomId}`,
    namespaceId: privateNamespaceId,
    humanActorIds: [creatorActorId],
  });
  await db.insert(roomMembers).values({
    roomId: privateRoomId,
    actorId: creatorActorId,
    roomRole: "admin",
  });
});

afterAll(async () => {
  if (!db) return;
  try {
    const roomIds = [openRoomId, subthreadRoomId, privateRoomId].filter(Boolean);
    if (roomIds.length > 0) {
      if (subthreadRoomId) {
        await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
      }
      const sessRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.roomId, roomIds));
      const sessIds = sessRows.map((s) => s.id);
      if (sessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
        await db.delete(sessions).where(inArray(sessions.id, sessIds));
      }
      await db.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
      await db.delete(rooms).where(inArray(rooms.id, roomIds));
    }
    const nsIds = [openNamespaceId, privateNamespaceId].filter(Boolean);
    if (nsIds.length > 0) {
      await db.delete(namespaces).where(inArray(namespaces.id, nsIds));
    }
    const actorIds = [creatorActorId, joinerActorId].filter(Boolean);
    if (actorIds.length > 0) {
      await db.delete(actors).where(inArray(actors.id, actorIds));
    }
    const userIds = [creatorUserId, joinerUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  } finally {
    await db.end();
  }
});

describe("joinOpenRoom (M124)", () => {
  test("adds a member row and updates human_actor_ids on first join", async () => {
    expect(await getRoomDetailForMember(openRoomId, joinerActorId)).toBeNull();
    expect(await getRoomDetailForMember(subthreadRoomId, joinerActorId)).toBeNull();
    const {
      membershipEvent,
      membershipMessageId,
      humanMembershipTransitions,
      repairedSubthreadIds,
      repairedSubthreadEvent,
    } = await joinOpenRoom({
      userId: joinerUserId,
      actorId: joinerActorId,
      roomId: openRoomId,
    });

    expect(membershipEvent).not.toBeNull();
    expect(membershipMessageId).toBeNumber();
    expect(await getRoomDetailForMember(openRoomId, joinerActorId)).toMatchObject({
      id: openRoomId, namespaceId: openNamespaceId, parentRoomId: null,
    });
    expect(await getRoomDetailForMember(subthreadRoomId, joinerActorId)).toMatchObject({
      id: subthreadRoomId, namespaceId: openNamespaceId, parentRoomId: openRoomId,
    });
    expect(membershipEvent?.kind).toBe("member_added");
    expect(repairedSubthreadIds).toEqual([subthreadRoomId]);
    expect(repairedSubthreadEvent).toMatchObject({
      kind: "member_added",
      actorId: joinerActorId,
      actorKind: "user",
    });
    expect(humanMembershipTransitions).toHaveLength(1);
    const transition = humanMembershipTransitions?.[0];
    expect(transition).toMatchObject({
      kind: "human_add",
      targetHumanActorId: joinerActorId,
      previous: {
        roomId: openRoomId,
        namespaceId: openNamespaceId,
        participantHumanActorIds: [creatorActorId],
      },
      current: {
        roomId: openRoomId,
        namespaceId: openNamespaceId,
        participantHumanActorIds: [creatorActorId, joinerActorId].sort(),
      },
    });
    expect(transition?.current.namespaceAccessRevision).toBe(
      (transition?.previous.namespaceAccessRevision ?? -2) + 1,
    );

    const memberRows = await db
      .select()
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, openRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      );
    expect(memberRows.length).toBe(1);
    expect(memberRows[0]?.roomRole).toBe("member");

    const [roomRow] = await db
      .select({ humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, openRoomId))
      .limit(1);
    expect(roomRow?.humanActorIds).toContain(joinerActorId);

    const [childMember] = await db
      .select({ roomRole: roomMembers.roomRole })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      )
      .limit(1);
    expect(childMember?.roomRole).toBe("member");
    const [childRoom] = await db
      .select({ humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, subthreadRoomId))
      .limit(1);
    expect(childRoom?.humanActorIds).toContain(joinerActorId);
  });

  test("an idempotent parent join repairs legacy child drift", async () => {
    await db
      .delete(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      );
    await db
      .update(rooms)
      .set({ humanActorIds: [creatorActorId] })
      .where(eq(rooms.id, subthreadRoomId));
    const oldJournalTimestamp = new Date("2000-01-01T00:00:00.000Z");
    await db
      .update(roomJournalState)
      .set({ updatedAt: oldJournalTimestamp })
      .where(eq(roomJournalState.roomId, subthreadRoomId));

    const result = await joinOpenRoom({
      userId: joinerUserId,
      actorId: joinerActorId,
      roomId: openRoomId,
    });
    expect(result).toEqual({
      membershipEvent: null,
      repairedSubthreadIds: [subthreadRoomId],
      repairedSubthreadEvent: {
        kind: "member_added",
        actorId: joinerActorId,
        actorKind: "user",
        displayName: "Joiner",
      },
    });

    const memberRows = await db
      .select()
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, openRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      );
    expect(memberRows.length).toBe(1);
    const [childMember] = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      )
      .limit(1);
    expect(childMember?.actorId).toBe(joinerActorId);
    const [childRoom] = await db
      .select({ humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, subthreadRoomId))
      .limit(1);
    expect(childRoom?.humanActorIds).toContain(joinerActorId);
    const [journal] = await db
      .select({ updatedAt: roomJournalState.updatedAt })
      .from(roomJournalState)
      .where(eq(roomJournalState.roomId, subthreadRoomId))
      .limit(1);
    expect(journal?.updatedAt.getTime()).toBeGreaterThan(
      oldJournalTimestamp.getTime(),
    );
  });

  test("a fully converged idempotent join is a no-op", async () => {
    const result = await joinOpenRoom({
      userId: joinerUserId,
      actorId: joinerActorId,
      roomId: openRoomId,
    });
    expect(result).toEqual({
      membershipEvent: null,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
  });

  test("idempotent thread open repairs a historical open-Room child", async () => {
    await db
      .delete(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      );
    await db
      .update(rooms)
      .set({ humanActorIds: [creatorActorId] })
      .where(eq(rooms.id, subthreadRoomId));

    const result = await createSubthreadRoom({
      parentRoomId: openRoomId,
      anchorMessageId,
      requesterActorId: joinerActorId,
    });

    expect(result.subthreadRoomId).toBe(subthreadRoomId);
    expect(result.repairedSubthreadIds).toEqual([subthreadRoomId]);
    expect(result.repairedMembership).toMatchObject({
      actorId: joinerActorId,
      actorKind: "user",
      kind: "member_added",
    });
    const [childMember] = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, subthreadRoomId),
          eq(roomMembers.actorId, joinerActorId),
        ),
      )
      .limit(1);
    expect(childMember?.actorId).toBe(joinerActorId);
  });

  test("a non-parent actor cannot repair or enter an open child", async () => {
    const outsiderActorId = randomUUID();
    const childMembersBefore = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, subthreadRoomId));

    try {
      await createSubthreadRoom({
        parentRoomId: openRoomId,
        anchorMessageId,
        requesterActorId: outsiderActorId,
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(MembershipOpError);
      expect((error as MembershipOpError).opCode).toBe(
        "subthread_not_visible",
      );
    }

    const childMembersAfter = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, subthreadRoomId));
    expect(childMembersAfter).toEqual(childMembersBefore);
  });

  test("throws not_open for private rooms", async () => {
    try {
      await joinOpenRoom({
        userId: joinerUserId,
        actorId: joinerActorId,
        roomId: privateRoomId,
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MembershipOpError);
      expect((err as MembershipOpError).opCode).toBe("not_open");
    }
  });

  test("throws not_found for a non-existent room id", async () => {
    try {
      await joinOpenRoom({
        userId: joinerUserId,
        actorId: joinerActorId,
        roomId: randomUUID(),
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MembershipOpError);
      expect((err as MembershipOpError).opCode).toBe("not_found");
    }
  });
});
