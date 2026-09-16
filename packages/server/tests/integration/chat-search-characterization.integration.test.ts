/**
 * D470 task 0.1 — deliberately red characterization for the missing
 * cross-Room search seam. The fixture pins the D430 Human-visible corpus and
 * exact Room-membership boundary before the endpoint/query is implemented.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  eq,
  groupMembers,
  inArray,
  namespaces,
  profiles,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { getUserCapabilities } from "@nautilo/trust";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

interface SearchBody {
  conversations: Array<{ room: { id: string } }>;
  messages: Array<{
    messageId: string;
    createdAt: string;
    roomId: string;
    snippet: string;
    parentRoomId?: string;
    parentRoomLabel?: string;
  }>;
  conversationsTruncated: boolean;
  messageAsOf: { createdAt: string; messageId: string } | null;
  nextOlderMessageCursor: { createdAt: string; messageId: string } | null;
  hasMoreOlderMessages: boolean;
}

let fx: AppFixture;
let ownerBearer = "";
let peer: Awaited<ReturnType<typeof seatPeerUser>> | null = null;
const roomIds: string[] = [];
const namespaceIds: string[] = [];
const sessionIds: string[] = [];
const expected = {
  topLevelRoomId: "",
  topLevelSessionId: "",
  subthreadRoomId: "",
  unauthorizedRoomId: "",
};

async function createRoom(args: {
  label: string;
  kind?: "private" | "subthread" | "task" | "access";
  ownerId?: string;
  memberActorId?: string;
  parentRoomId?: string;
  threadRootMessageId?: number;
  archived?: boolean;
}): Promise<string> {
  const ownerId = args.ownerId ?? fx.ownerId;
  const memberActorId = args.memberActorId ?? fx.ownerActorId;
  const [namespace] = await fx.db
    .insert(namespaces)
    .values({ scope: "private", label: `d470-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("D470 namespace insert failed");
  namespaceIds.push(namespace.id);

  const roomId = randomUUID();
  await fx.db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    kind: args.kind ?? "private",
    label: args.label,
    graphThreadId: `room:${roomId}`,
    namespaceId: namespace.id,
    humanActorIds: [memberActorId],
    createdBy: memberActorId,
    parentRoomId: args.parentRoomId,
    threadRootMessageId: args.threadRootMessageId,
    archivedAt: args.archived ? new Date("2026-01-01T00:00:00.000Z") : null,
  });
  await fx.db.insert(roomMembers).values({
    roomId,
    actorId: memberActorId,
    roomRole: "admin",
  });
  roomIds.push(roomId);
  return roomId;
}

async function createSession(roomId: string, ownerId = fx.ownerId, threadPrefix = "main"): Promise<string> {
  const [session] = await fx.db
    .insert(sessions)
    .values({
      ownerId,
      roomId,
      threadId: `${threadPrefix}:${randomUUID()}`,
      channel: "workbench",
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("D470 session insert failed");
  sessionIds.push(session.id);
  return session.id;
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "d470char" });
  ownerBearer = await fx.mintOwnerBearer();
  peer = await seatPeerUser(fx.db, { suiteName: "d470char", groupType: "members" });

  const topLevelRoomId = await createRoom({ label: "Needle planning" });
  expected.topLevelRoomId = topLevelRoomId;
  const topLevelSession = await createSession(topLevelRoomId);
  expected.topLevelSessionId = topLevelSession;
  const duplicateSession = await createSession(topLevelRoomId);
  const subagentSession = await createSession(topLevelRoomId, fx.ownerId, "subagent");
  const at = (minute: number) => new Date(`2026-02-01T10:${String(minute).padStart(2, "0")}:00.000Z`);
  const [anchor] = await fx.db
    .insert(sessionMessages)
    .values({ sessionId: topLevelSession, role: "user", content: "thread anchor", createdAt: at(0) })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("D470 anchor insert failed");
  await fx.db.insert(sessionMessages).values([
    { sessionId: topLevelSession, role: "user", content: "needle ordinary", createdAt: at(1) },
    { sessionId: topLevelSession, role: "tool", content: "needle lookup result", toolName: "lookup", createdAt: at(2) },
    { sessionId: topLevelSession, role: "tool", content: "needle legacy tool", toolName: null, createdAt: at(3) },
    { sessionId: topLevelSession, role: "tool", content: "needle reaction hidden", toolName: "react", createdAt: at(4) },
    { sessionId: topLevelSession, role: "user", content: "needle task-origin hidden", metadata: { originatedBy: "task" }, createdAt: at(5) },
    { sessionId: subagentSession, role: "user", content: "needle subagent hidden", createdAt: at(6) },
    { sessionId: topLevelSession, role: "user", content: "needle duplicate old", fingerprint: "d470-duplicate", createdAt: at(7) },
    { sessionId: duplicateSession, role: "user", content: "needle duplicate canonical", fingerprint: "d470-duplicate", createdAt: at(8) },
  ]);

  const subthreadRoomId = await createRoom({
    label: "Needle implementation thread",
    kind: "subthread",
    parentRoomId: topLevelRoomId,
    threadRootMessageId: anchor.id,
  });
  expected.subthreadRoomId = subthreadRoomId;
  const subthreadSession = await createSession(subthreadRoomId);
  await fx.db.insert(sessionMessages).values({
    sessionId: subthreadSession,
    role: "user",
    content: "needle child reply",
    createdAt: at(9),
  });

  const unauthorizedRoomId = await createRoom({
    label: "Needle unauthorized",
    ownerId: peer.userId,
    memberActorId: peer.actorId,
  });
  expected.unauthorizedRoomId = unauthorizedRoomId;
  const unauthorizedSession = await createSession(unauthorizedRoomId, peer.userId);
  await fx.db.insert(sessionMessages).values({
    sessionId: unauthorizedSession,
    role: "user",
    content: "needle unauthorized message",
    createdAt: at(10),
  });

  for (const hidden of [
    { label: "Needle archived", kind: "private" as const, archived: true },
    { label: "Needle task room", kind: "task" as const },
    { label: "Needle access room", kind: "access" as const },
  ]) {
    const hiddenRoomId = await createRoom(hidden);
    const hiddenSession = await createSession(hiddenRoomId);
    await fx.db.insert(sessionMessages).values({
      sessionId: hiddenSession,
      role: "user",
      content: `needle ${hidden.kind} hidden`,
      createdAt: at(11),
    });
  }
});

afterAll(async () => {
  if (!fx) return;
  // A Subthread's anchor FK is ON DELETE SET NULL, while the Room invariant
  // requires both parent + anchor until the child Room is deleted. Remove the
  // child lane first so deleting the parent anchor cannot create an invalid
  // intermediate row.
  const subthreadSessionRows = expected.subthreadRoomId
    ? await fx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.roomId, expected.subthreadRoomId))
    : [];
  const subthreadSessionIds = subthreadSessionRows.map((row) => row.id);
  if (subthreadSessionIds.length > 0) {
    await fx.db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, subthreadSessionIds));
    await fx.db.delete(sessions).where(inArray(sessions.id, subthreadSessionIds));
  }
  if (expected.subthreadRoomId) {
    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, expected.subthreadRoomId));
    await fx.db.delete(rooms).where(eq(rooms.id, expected.subthreadRoomId));
  }

  const remainingSessionIds = sessionIds.filter((id) => !subthreadSessionIds.includes(id));
  if (remainingSessionIds.length > 0) {
    await fx.db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, remainingSessionIds));
    await fx.db.delete(sessions).where(inArray(sessions.id, remainingSessionIds));
  }
  const remainingRoomIds = roomIds.filter((id) => id !== expected.subthreadRoomId);
  if (remainingRoomIds.length > 0) {
    await fx.db.delete(roomMembers).where(inArray(roomMembers.roomId, remainingRoomIds));
    await fx.db.delete(rooms).where(inArray(rooms.id, remainingRoomIds));
  }
  if (namespaceIds.length > 0) {
    await fx.db.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
  }
  if (peer) {
    await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
    await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peer.userId));
    await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
    await fx.db.delete(actors).where(eq(actors.agentId, peer.agentId));
    await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
    await fx.db.delete(users).where(eq(users.id, peer.userId));
  }
  await fx.cleanup();
});

describe("D470 cross-Room search characterization", () => {
  test("one bounded request returns only the exact-member D430 corpus and breadcrumbs Subthreads", async () => {
    const response = await authedInject(fx.app, {
      method: "GET",
      url: "/api/rooms/search?query=needle&mode=whole&ignoreCase=true&limit=20",
      bearer: ownerBearer,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as SearchBody;
    expect(body.conversations.map((hit) => hit.room.id)).toEqual([expected.topLevelRoomId]);
    expect(body.messages.map((hit) => ({
      roomId: hit.roomId,
      snippet: hit.snippet,
      parentRoomId: hit.parentRoomId,
      parentRoomLabel: hit.parentRoomLabel,
    }))).toEqual([
      {
        roomId: expected.subthreadRoomId,
        snippet: "needle child reply",
        parentRoomId: expected.topLevelRoomId,
        parentRoomLabel: "Needle planning",
      },
      {
        roomId: expected.topLevelRoomId,
        snippet: "needle duplicate canonical",
        parentRoomId: undefined,
        parentRoomLabel: undefined,
      },
      {
        roomId: expected.topLevelRoomId,
        snippet: "needle legacy tool",
        parentRoomId: undefined,
        parentRoomLabel: undefined,
      },
      {
        roomId: expected.topLevelRoomId,
        snippet: "needle lookup result",
        parentRoomId: undefined,
        parentRoomLabel: undefined,
      },
      {
        roomId: expected.topLevelRoomId,
        snippet: "needle ordinary",
        parentRoomId: undefined,
        parentRoomLabel: undefined,
      },
    ]);
    expect(body.conversationsTruncated).toBe(false);
    expect(body.hasMoreOlderMessages).toBe(false);
  });

  test("returns an empty page for a valid query with no authorized matches", async () => {
    const response = await authedInject(fx.app, {
      method: "GET",
      url: "/api/rooms/search?query=no-such-d470-result&mode=whole&ignoreCase=true&limit=20",
      bearer: ownerBearer,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      conversations: [],
      conversationsTruncated: false,
      messages: [],
      messageAsOf: null,
      nextOlderMessageCursor: null,
      hasMoreOlderMessages: false,
    });
  });

  test("membership revocation invalidates an already-issued continuation without identifiers", async () => {
    const revokedRoomIds = [expected.topLevelRoomId, expected.subthreadRoomId];
    const initialResponse = await authedInject(fx.app, {
      method: "GET",
      url: "/api/rooms/search?query=needle&mode=whole&ignoreCase=true&limit=2",
      bearer: ownerBearer,
    });
    expect(initialResponse.statusCode).toBe(200);
    const initial = JSON.parse(initialResponse.body) as SearchBody;
    expect(initial.messages).toHaveLength(2);
    expect(initial.messageAsOf).not.toBeNull();
    expect(initial.nextOlderMessageCursor).not.toBeNull();
    const asOf = initial.messageAsOf!;
    const cursor = initial.nextOlderMessageCursor!;
    try {
      await fx.db
        .delete(roomMembers)
        .where(inArray(roomMembers.roomId, revokedRoomIds));

      const response = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/search?query=needle&mode=whole&ignoreCase=true&limit=20" +
          `&cursorCreatedAt=${encodeURIComponent(cursor.createdAt)}&cursorMessageId=${cursor.messageId}` +
          `&asOfCreatedAt=${encodeURIComponent(asOf.createdAt)}&asOfMessageId=${asOf.messageId}`,
        bearer: ownerBearer,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        // Continuations preserve the caller-supplied snapshot anchor but emit
        // no new Room or Message identifier after revocation.
        messageAsOf: asOf,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      });
    } finally {
      await fx.db.insert(roomMembers).values([
        { roomId: expected.topLevelRoomId, actorId: fx.ownerActorId, roomRole: "admin" },
        { roomId: expected.subthreadRoomId, actorId: fx.ownerActorId, roomRole: "admin" },
      ]).onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.actorId] });
    }
  });

  test("a message deleted after discovery leaves no target or existence signal", async () => {
    const marker = `deletionproof${randomUUID().replaceAll("-", "")}`;
    const [inserted] = await fx.db.insert(sessionMessages).values({
      sessionId: expected.topLevelSessionId,
      role: "user",
      content: marker,
      createdAt: new Date("2026-02-01T11:00:00.000Z"),
    }).returning({ id: sessionMessages.id });
    if (!inserted) throw new Error("D470 deletion target insert failed");

    const before = await authedInject(fx.app, {
      method: "GET",
      url: `/api/rooms/search?query=${marker}&mode=whole&ignoreCase=true&limit=20`,
      bearer: ownerBearer,
    });
    expect(before.statusCode).toBe(200);
    expect((JSON.parse(before.body) as SearchBody).messages.map((hit) => hit.messageId)).toEqual([
      String(inserted.id),
    ]);

    await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, inserted.id));
    const after = await authedInject(fx.app, {
      method: "GET",
      url: `/api/rooms/search?query=${marker}&mode=whole&ignoreCase=true&limit=20`,
      bearer: ownerBearer,
    });
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body)).toEqual({
      conversations: [],
      conversationsTruncated: false,
      messages: [],
      messageAsOf: null,
      nextOlderMessageCursor: null,
      hasMoreOlderMessages: false,
    });
  });

  test("capability removal invalidates the same bearer's previously visible corpus", async () => {
    if (!peer) throw new Error("D470 guest peer was not seeded");
    expect(await getUserCapabilities(peer.userId)).toContain("read_memories");
    const before = await authedInject(fx.app, {
      method: "GET",
      url: "/api/rooms/search?query=needle&mode=whole&ignoreCase=true&limit=20",
      bearer: peer.bearer,
    });
    expect(before.statusCode).toBe(200);
    const visibleBefore = JSON.parse(before.body) as SearchBody;
    expect(visibleBefore.conversations.map((hit) => hit.room.id)).toContain(
      expected.unauthorizedRoomId,
    );
    expect(visibleBefore.messages.map((hit) => hit.roomId)).toContain(
      expected.unauthorizedRoomId,
    );

    const removedMemberships = await fx.db
      .delete(groupMembers)
      .where(eq(groupMembers.userId, peer.userId))
      .returning({
        groupId: groupMembers.groupId,
        userId: groupMembers.userId,
        grantedAt: groupMembers.grantedAt,
        grantedBy: groupMembers.grantedBy,
      });
    expect(removedMemberships.length).toBeGreaterThan(0);
    try {
      expect(await getUserCapabilities(peer.userId)).not.toContain("read_memories");
      const response = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/search?query=needle&mode=whole&ignoreCase=true&limit=20",
        bearer: peer.bearer,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SearchBody;
      expect(body.conversations).toEqual([]);
      expect(body.messages).toEqual([]);
      expect(body.conversationsTruncated).toBe(false);
      expect(body.hasMoreOlderMessages).toBe(false);
    } finally {
      await fx.db.insert(groupMembers).values(removedMemberships).onConflictDoNothing({
        target: [groupMembers.groupId, groupMembers.userId],
      });
    }
  });
});
