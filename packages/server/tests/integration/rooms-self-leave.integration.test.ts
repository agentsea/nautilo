/**
 * M124 — DELETE /api/rooms/:id/members/:actorId self-leave (integration).
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

describe("DELETE /api/rooms/:id/members/:actorId — self-leave (M124 integration)", () => {
  test("member self-leave; owner blocked until another admin; owner leaves after promotion", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "rleave" });
    let openRoomId: string | null = null;
    let peerUserId: string | null = null;
    let peerActorId: string | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const createRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#leave-target", kind: "open" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as { id: string };
      openRoomId = created.id;

      const peerPin = "918273";
      const peerHandle = `rleavepeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "rleave-peer",
          email: `rleave-peer-${Date.now()}@test.local`,
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
      peerActorId = a.id;
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

      const peerLeaveRes = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/rooms/${openRoomId}/members/${peerActorId}`,
        bearer: peerToken,
      });
      expect(peerLeaveRes.statusCode).toBe(200);
      const peerRowsAfterLeave = await fx.db
        .select({ roomId: roomMembers.roomId })
        .from(roomMembers)
        .where(
          and(eq(roomMembers.roomId, openRoomId), eq(roomMembers.actorId, peerActorId)),
        );
      expect(peerRowsAfterLeave).toHaveLength(0);

      const feedRes = await authedInject(fx.app, { method: "GET", url: "/api/event-feed", bearer: adminToken });
      expect(feedRes.statusCode).toBe(200);
      const feed = JSON.parse(feedRes.body) as { events: Array<{ type: string; actorId: string; data: { roomId: string; userId: string } }> };
      expect(feed.events.map((event) => event.type)).toEqual(["room.member_left", "room.member_joined"]);
      expect(feed.events[0]).toMatchObject({ actorId: peerActorId, data: { roomId: openRoomId, userId: peerUserId } });
      const departedFeed = await authedInject(fx.app, { method: "GET", url: "/api/event-feed", bearer: peerToken });
      expect(JSON.parse(departedFeed.body)).toMatchObject({ events: [] });

      const ownerBlockedRes = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/rooms/${openRoomId}/members/${fx.ownerActorId}`,
        bearer: adminToken,
      });
      expect(ownerBlockedRes.statusCode).toBe(409);
      expect(JSON.parse(ownerBlockedRes.body)).toMatchObject({
        code: "room_owner_last_admin",
      });

      const rejoinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${openRoomId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(rejoinRes.statusCode).toBe(200);

      await fx.db
        .update(roomMembers)
        .set({ roomRole: "admin" })
        .where(
          and(eq(roomMembers.roomId, openRoomId), eq(roomMembers.actorId, peerActorId)),
        );

      const ownerLeaveRes = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/rooms/${openRoomId}/members/${fx.ownerActorId}`,
        bearer: adminToken,
      });
      expect(ownerLeaveRes.statusCode).toBe(200);
    } finally {
      if (openRoomId) {
        await deleteRoomAndNamespace(fx.db, openRoomId);
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
