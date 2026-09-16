/**
 * M124 — POST /api/rooms/:id/join (integration).
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import { hashPin } from "@nautilo/trust";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  users,
  actors,
  credentials,
  channelIdentities,
  rooms,
  roomMembers,
  namespaces,
  sessions,
  sessionMessages,
  eq,
  and,
  inArray,
  feedEvents,
  sql,
} from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

async function deleteRoomAndNamespace(
  db: Awaited<ReturnType<typeof setupOwnerAppFixture>>["db"],
  roomId: string,
): Promise<void> {
  await db.delete(feedEvents).where(eq(sql<string>`${feedEvents.data}->>'roomId'`, roomId));
  const [row] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  // Join/leave append room system messages, which create `sessions` rows
  // referencing the room (sessions.room_id FK). Clear them before the room.
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, roomId));
  const sessionIds = sessionRows.map((s) => s.id);
  if (sessionIds.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  }
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));
  if (row?.namespaceId) {
    await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId));
  }
}

describe("POST /api/rooms/:id/join (M124 integration)", () => {
  test("peer joins open room; idempotent; rejects non-open, missing, unauthenticated", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "rjoin" });
    const createdRoomIds: string[] = [];
    let peerUserId: string | null = null;
    let peerActorId: string | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const openRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#join-target", kind: "open" },
      });
      expect(openRes.statusCode).toBe(201);
      const openBody = JSON.parse(openRes.body) as { id: string };
      const openRoomId = openBody.id;
      createdRoomIds.push(openRoomId);

      const peerPin = "918273";
      const peerHandle = `rjoinpeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "rjoin-peer",
          email: `rjoin-peer-${Date.now()}@test.local`,
          handle: peerHandle,
          externalId: randomUUID(),
        })
        .returning({ id: users.id });
      if (!u) throw new Error("user");
      peerUserId = u.id;
      const [a] = await fx.db
        .insert(actors)
        .values({
          ownerId: u.id,
          displayName: "Peer",
          trustState: "verified",
          kind: "user",
        })
        .returning({ id: actors.id });
      if (!a) throw new Error("actor");
      const peerActor = a.id;
      peerActorId = peerActor;
      await fx.db.insert(credentials).values({
        userId: u.id,
        type: "pin",
        value: await hashPin(peerPin),
      });
      const fed = composeFederatedId(peerHandle, getServerHostname());
      await fx.db.insert(channelIdentities).values([
        { channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() },
      ]);

      const peerToken = await fx.mintSessionBearerForUser(a.id, u.id);

      const joinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${openRoomId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(joinRes.statusCode).toBe(200);
      const joinBody = JSON.parse(joinRes.body) as { id: string };
      expect(joinBody.id).toBe(openRoomId);

      // Authoritative "is now a member" signal is the room_members row. We do
      // NOT assert via `GET /api/rooms` here: that list endpoint is gated by
      // the pre-existing `canViewOwnSessionTranscripts(actorRole)` rule, and a
      // bare open-room joiner with no Agent relationship resolves to `guest`
      // (excluded). That gate is M077/M128 territory, orthogonal to M124.
      const joinedRows = await fx.db
        .select({ roomId: roomMembers.roomId })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, openRoomId), eq(roomMembers.actorId, peerActor)));
      expect(joinedRows).toHaveLength(1);

      const rejoinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${openRoomId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(rejoinRes.statusCode).toBe(200);
      const memberRows = await fx.db
        .select({ roomId: roomMembers.roomId })
        .from(roomMembers)
        .where(
          and(eq(roomMembers.roomId, openRoomId), eq(roomMembers.actorId, peerActor)),
        );
      expect(memberRows).toHaveLength(1);

      // PR 2: real join produces one personal entry, replay cannot reset it.
      const feedRes = await authedInject(fx.app, { method: "GET", url: "/api/event-feed", bearer: adminToken });
      expect(feedRes.statusCode).toBe(200);
      const feed = JSON.parse(feedRes.body) as { events: Array<{ id: string; type: string; actorId: string; data: { roomId: string; userId: string }; readAt: string | null }> };
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0]).toMatchObject({ type: "room.member_joined", actorId: peerActor, data: { roomId: openRoomId, userId: peerUserId }, readAt: null });
      const peerFeed = await authedInject(fx.app, { method: "GET", url: "/api/event-feed", bearer: peerToken });
      expect(JSON.parse(peerFeed.body)).toMatchObject({ events: [] });
      const read = await authedInject(fx.app, { method: "PUT", url: `/api/event-feed/${feed.events[0]!.id}/read`, bearer: adminToken, payload: { read: true } });
      expect(read.statusCode).toBe(200);
      await authedInject(fx.app, { method: "POST", url: `/api/rooms/${openRoomId}/join`, bearer: peerToken, payload: {} });
      const count = await authedInject(fx.app, { method: "GET", url: "/api/event-feed/unread-count", bearer: adminToken });
      expect(JSON.parse(count.body)).toEqual({ unreadCount: 0 });

      // Seed a non-open (private) room directly — the no-members POST path
      // needs a personal agent + canonical groups that a fresh named instance
      // may not have seeded; a direct insert keeps this test self-contained.
      const privateRoomId = randomUUID();
      const [pns] = await fx.db
        .insert(namespaces)
        .values({ scope: "private", label: `rjoin-priv-${Date.now().toString(36).slice(-8)}` })
        .returning({ id: namespaces.id });
      if (!pns) throw new Error("private namespace");
      await fx.db.insert(rooms).values({
        id: privateRoomId,
        ownerId: fx.ownerId,
        type: "private",
        kind: "private",
        label: "rjoin-private",
        graphThreadId: `room:${privateRoomId}`,
        namespaceId: pns.id,
        humanActorIds: [fx.ownerActorId],
      });
      await fx.db
        .insert(roomMembers)
        .values({ roomId: privateRoomId, actorId: fx.ownerActorId, roomRole: "admin" });
      createdRoomIds.push(privateRoomId);

      const privateJoinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${privateRoomId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(privateJoinRes.statusCode).toBe(403);
      expect(JSON.parse(privateJoinRes.body)).toMatchObject({ code: "not_open" });

      const missingId = randomUUID();
      const missingJoinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${missingId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(missingJoinRes.statusCode).toBe(404);

      const unauthJoinRes = await fx.app.inject({
        method: "POST",
        url: `/api/rooms/${openRoomId}/join`,
      });
      expect(unauthJoinRes.statusCode).toBe(401);
    } finally {
      for (const roomId of createdRoomIds) {
        await deleteRoomAndNamespace(fx.db, roomId);
      }
      if (peerUserId) {
        await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
        await fx.db.delete(credentials).where(eq(credentials.userId, peerUserId));
        if (peerActorId) {
          await fx.db.delete(actors).where(eq(actors.id, peerActorId));
        }
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  });
});
