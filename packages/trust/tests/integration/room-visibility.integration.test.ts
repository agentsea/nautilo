import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  moderationActions,
  moderationRestrictions,
  moderationSubjects,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createRoomForOwner,
  createSubthreadRoom,
  joinOpenRoom,
  MembershipOpError,
  updateRoomVisibility,
} from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let ownerUserId: string;
let ownerActorId: string;
let joinedUserId: string;
let joinedActorId: string;
let laterUserId: string;
let laterActorId: string;
let ownedAgentId: string;
let ownedAgentActorId: string;
const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdSessionIds: string[] = [];
const createdRestrictionIds: string[] = [];

async function createFixtureRoom(input: {
  type: "private" | "shared";
  kind: "private" | "group" | "open" | "multi_agent";
  members?: string[];
  withMessage?: boolean;
}) {
  const roomId = randomUUID();
  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `visibility-${roomId}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("namespace");
  createdRoomIds.push(roomId);
  createdNamespaceIds.push(namespace.id);
  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: input.type,
    kind: input.kind,
    label: `Visibility ${roomId}`,
    graphThreadId: `room:${roomId}`,
    namespaceId: namespace.id,
    humanActorIds: (input.members ?? [ownerActorId, ownedAgentActorId])
      .filter((id) => id === ownerActorId || id === joinedActorId)
      .sort(),
  });
  const memberIds = input.members ?? [ownerActorId, ownedAgentActorId];
  await db.insert(roomMembers).values(
    memberIds.map((actorId) => ({
      roomId,
      actorId,
      roomRole: actorId === ownerActorId ? "admin" : "member",
      ...(actorId === ownedAgentActorId ? { agentResponseMode: "active" as const } : {}),
    })),
  );
  let messageId: number | undefined;
  if (input.withMessage) {
    const [session] = await db.insert(sessions).values({
      threadId: `room:${roomId}`,
      ownerId: ownerUserId,
      personaId: "owner",
      roomId,
      channel: "tui",
    }).returning({ id: sessions.id });
    if (!session) throw new Error("session");
    createdSessionIds.push(session.id);
    const [message] = await db.insert(sessionMessages).values({
      sessionId: session.id,
      role: "user",
      content: "visibility history survives",
    }).returning({ id: sessionMessages.id });
    if (!message) throw new Error("message");
    messageId = message.id;
  }
  return { roomId, messageId };
}

async function banHumanFromChild(userId: string, childRoomId: string): Promise<void> {
  const [subject] = await db.insert(moderationSubjects).values({ userId })
    .returning({ id: moderationSubjects.id });
  if (!subject) throw new Error("moderation subject");
  const operationId = randomUUID();
  const restrictionId = randomUUID();
  createdRestrictionIds.push(restrictionId);
  await db.insert(moderationActions).values({
    operationId,
    requestDigest: "0".repeat(64),
    requesterUserId: ownerUserId,
    subjectId: subject.id,
    roomId: childRoomId,
    action: "ban",
    restrictionId,
  });
  await db.insert(moderationRestrictions).values({
    id: restrictionId,
    subjectId: subject.id,
    roomId: childRoomId,
    kind: "access",
    createOperationId: operationId,
  });
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const suffix = randomUUID().slice(0, 8);
  const [owner, joined, later] = await db.insert(users).values([
    {
      name: "Visibility owner",
      email: `visibility-owner-${suffix}@test.local`,
      handle: `visibilityowner${suffix}`,
    },
    {
      name: "Visibility joiner",
      email: `visibility-joiner-${suffix}@test.local`,
      handle: `visibilityjoiner${suffix}`,
    },
    {
      name: "Visibility later joiner",
      email: `visibility-later-${suffix}@test.local`,
      handle: `visibilitylater${suffix}`,
    },
  ]).returning({ id: users.id });
  if (!owner || !joined || !later) throw new Error("users");
  ownerUserId = owner.id;
  joinedUserId = joined.id;
  laterUserId = later.id;
  const [ownerActor, joinedActor, laterActor] = await db.insert(actors).values([
    {
      ownerId: ownerUserId,
      displayName: "Visibility owner",
      trustState: "verified",
      kind: "user",
    },
    {
      ownerId: joinedUserId,
      displayName: "Visibility joiner",
      trustState: "verified",
      kind: "user",
    },
    {
      ownerId: laterUserId,
      displayName: "Visibility later joiner",
      trustState: "verified",
      kind: "user",
    },
  ]).returning({ id: actors.id });
  if (!ownerActor || !joinedActor || !laterActor) throw new Error("human actors");
  ownerActorId = ownerActor.id;
  joinedActorId = joinedActor.id;
  laterActorId = laterActor.id;
  const [agent] = await db.insert(agents).values({
    handle: `visibility-agent-${suffix}`,
  }).returning({ id: agents.id });
  if (!agent) throw new Error("agent");
  ownedAgentId = agent.id;
  const [agentActor] = await db.insert(actors).values({
    ownerId: ownerUserId,
    displayName: "Visibility Genie",
    kind: "agent",
    agentId: ownedAgentId,
  }).returning({ id: actors.id });
  if (!agentActor) throw new Error("agent actor");
  ownedAgentActorId = agentActor.id;
});

afterAll(async () => {
  if (!db) return;
  try {
    if (createdRestrictionIds.length > 0) {
      await db.delete(moderationRestrictions)
        .where(inArray(moderationRestrictions.id, createdRestrictionIds));
    }
    if (createdRoomIds.length > 0) {
      // Anchored messages use ON DELETE SET NULL, while the Subthread shape
      // requires one live/tombstoned anchor. Remove child Rooms first.
      const childRooms = await db.select({ id: rooms.id, kind: rooms.kind }).from(rooms)
        .where(inArray(rooms.id, createdRoomIds));
      const childRoomIds = childRooms
        .filter((room) => room.kind === "subthread")
        .map((room) => room.id);
      if (childRoomIds.length > 0) {
        await db.delete(rooms).where(inArray(rooms.id, childRoomIds));
      }
      const storedSessions = await db.select({ id: sessions.id }).from(sessions)
        .where(inArray(sessions.roomId, createdRoomIds));
      const sessionIds = [...new Set([
        ...createdSessionIds,
        ...storedSessions.map((session) => session.id),
      ])];
      if (sessionIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
        await db.delete(sessions).where(inArray(sessions.id, sessionIds));
      }
    }
    if (createdRoomIds.length > 0) {
      await db.delete(roomMembers).where(inArray(roomMembers.roomId, createdRoomIds));
      await db.delete(rooms).where(inArray(rooms.id, createdRoomIds));
    }
    if (createdNamespaceIds.length > 0) {
      await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds));
    }
    const actorIds = [
      ownerActorId,
      joinedActorId,
      laterActorId,
      ownedAgentActorId,
    ].filter(Boolean);
    if (actorIds.length > 0) await db.delete(actors).where(inArray(actors.id, actorIds));
    if (ownedAgentId) await db.delete(agents).where(eq(agents.id, ownedAgentId));
    const userIds = [ownerUserId, joinedUserId, laterUserId].filter(Boolean);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  } finally {
    await db.end();
  }
});

describe("updateRoomVisibility (integration)", () => {
  test("round-trips an unchanged personal Room through external visibility", async () => {
    const { roomId, messageId } = await createFixtureRoom({
      type: "private",
      kind: "private",
      withMessage: true,
    });

    expect(await updateRoomVisibility(roomId, "open", false)).toEqual({
      changed: true,
      kind: "open",
      discoverable: false,
    });
    expect(await updateRoomVisibility(roomId, "group")).toEqual({
      changed: true,
      kind: "private",
      discoverable: false,
    });

    const storedMembers = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, roomId));
    const [storedMessage] = await db.select({ id: sessionMessages.id })
      .from(sessionMessages).where(eq(sessionMessages.id, messageId!)).limit(1);
    expect(storedMembers.map((member) => member.actorId).sort()).toEqual(
      [ownerActorId, ownedAgentActorId].sort(),
    );
    expect(storedMessage?.id).toBe(messageId);
  });

  test("returns an opened personal Room with a joined Human to group without losing roster or history", async () => {
    const members = [ownerActorId, ownedAgentActorId, joinedActorId];
    const { roomId, messageId } = await createFixtureRoom({
      type: "private",
      kind: "open",
      members,
      withMessage: true,
    });

    expect(await updateRoomVisibility(roomId, "group")).toEqual({
      changed: true,
      kind: "group",
      discoverable: true,
    });
    const storedMembers = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, roomId));
    const [storedMessage] = await db.select({ id: sessionMessages.id })
      .from(sessionMessages).where(eq(sessionMessages.id, messageId!)).limit(1);
    expect(storedMembers.map((member) => member.actorId).sort()).toEqual(
      [...members].sort(),
    );
    expect(storedMessage?.id).toBe(messageId);
  });

  test("does not convert an existing group that happens to have a personal roster", async () => {
    const { roomId } = await createFixtureRoom({ type: "private", kind: "group" });
    expect(await updateRoomVisibility(roomId, "group")).toEqual({
      changed: false,
      kind: "group",
      discoverable: true,
    });
  });

  test("returns an open shared-origin Room to group", async () => {
    const { roomId } = await createFixtureRoom({ type: "shared", kind: "open" });
    expect(await updateRoomVisibility(roomId, "group")).toEqual({
      changed: true,
      kind: "group",
      discoverable: true,
    });
  });

  test("serializes a private restoration with a concurrent self-join", async () => {
    const detail = await createRoomForOwner({
      ownerUserId,
      ownerActorId,
      defaultAgentId: ownedAgentId,
      label: "Visibility race",
    });
    createdRoomIds.push(detail.id);
    if (!detail.namespaceId) throw new Error("personal namespace");
    createdNamespaceIds.push(detail.namespaceId);
    await updateRoomVisibility(detail.id, "open", false);

    const [visibilityResult, joinResult] = await Promise.allSettled([
      updateRoomVisibility(detail.id, "group"),
      joinOpenRoom({
        userId: joinedUserId,
        actorId: joinedActorId,
        roomId: detail.id,
      }),
    ]);
    expect(visibilityResult.status).toBe("fulfilled");

    const [stored] = await db.select({ kind: rooms.kind }).from(rooms)
      .where(eq(rooms.id, detail.id)).limit(1);
    const storedMembers = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, detail.id));
    if (!stored || visibilityResult.status !== "fulfilled") {
      throw new Error("visibility result unavailable");
    }
    if (joinResult.status === "fulfilled") {
      expect(visibilityResult.value.kind).toBe("group");
      expect(stored.kind).toBe("group");
      expect(storedMembers.map((member) => member.actorId).sort()).toEqual(
        [ownerActorId, ownedAgentActorId, joinedActorId].sort(),
      );
    } else {
      expect(joinResult.reason).toBeInstanceOf(MembershipOpError);
      expect((joinResult.reason as MembershipOpError).opCode).toBe("not_open");
      expect(visibilityResult.value.kind).toBe("private");
      expect(stored.kind).toBe("private");
      expect(storedMembers.map((member) => member.actorId).sort()).toEqual(
        [ownerActorId, ownedAgentActorId].sort(),
      );
    }
  });

  test("opening a restricted child repairs the inherited audience and later joins stay consistent", async () => {
    const parentMembers = [ownerActorId, ownedAgentActorId, joinedActorId];
    const { roomId, messageId } = await createFixtureRoom({
      type: "private",
      kind: "group",
      members: parentMembers,
      withMessage: true,
    });
    const { subthreadRoomId } = await createSubthreadRoom({
      parentRoomId: roomId,
      anchorMessageId: messageId!,
      requesterActorId: ownerActorId,
      members: [{ actorId: ownerActorId }, { actorId: ownedAgentActorId }],
    });
    createdRoomIds.push(subthreadRoomId);

    const opened = await updateRoomVisibility(roomId, "open", false);
    expect(opened.subthreadMembershipRepairs).toEqual([
      {
        roomId: subthreadRoomId,
        event: {
          kind: "member_added",
          actorId: joinedActorId,
          actorKind: "user",
          displayName: "Visibility joiner",
        },
      },
    ]);
    let childMembers = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, subthreadRoomId));
    expect(childMembers.map((member) => member.actorId).sort()).toEqual(
      [...parentMembers].sort(),
    );

    await joinOpenRoom({
      userId: laterUserId,
      actorId: laterActorId,
      roomId,
    });
    childMembers = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, subthreadRoomId));
    expect(childMembers.map((member) => member.actorId).sort()).toEqual(
      [...parentMembers, laterActorId].sort(),
    );
  });

  test("opening preserves a child-scoped Human ban while repairing other inherited actors", async () => {
    const parentMembers = [ownerActorId, ownedAgentActorId, joinedActorId];
    const { roomId, messageId } = await createFixtureRoom({
      type: "private",
      kind: "group",
      members: parentMembers,
      withMessage: true,
    });
    const { subthreadRoomId } = await createSubthreadRoom({
      parentRoomId: roomId,
      anchorMessageId: messageId!,
      requesterActorId: ownerActorId,
      members: [{ actorId: ownerActorId }, { actorId: ownedAgentActorId }],
    });
    createdRoomIds.push(subthreadRoomId);
    await banHumanFromChild(joinedUserId, subthreadRoomId);

    const opened = await updateRoomVisibility(roomId, "open", false);
    expect(opened.subthreadMembershipRepairs).toBeUndefined();
    const parentRows = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, roomId));
    const childRows = await db.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, subthreadRoomId));
    expect(parentRows.map((member) => member.actorId).sort()).toEqual(
      [...parentMembers].sort(),
    );
    expect(childRows.map((member) => member.actorId).sort()).toEqual(
      [ownerActorId, ownedAgentActorId].sort(),
    );
  });

  test("rejects unsupported Room kinds", async () => {
    const { roomId } = await createFixtureRoom({ type: "private", kind: "multi_agent" });
    const error = await updateRoomVisibility(roomId, "open").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MembershipOpError);
    expect((error as MembershipOpError).opCode).toBe("invalid_kind_for_visibility");
  });
});
