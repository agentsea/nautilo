/**
 * M124 — GET /api/rooms/discoverable (integration).
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
  inArray,
} from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

async function deleteRoomAndNamespace(
  db: Awaited<ReturnType<typeof setupOwnerAppFixture>>["db"],
  roomId: string,
): Promise<void> {
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

describe("GET /api/rooms/discoverable (M124 integration)", () => {
  test("lists open rooms the caller is not in; excludes already-joined rooms", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "rdisc" });
    let openRoomId: string | null = null;
    let peerUserId: string | null = null;
    let peerActorId: string | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const createRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#discover-me", kind: "open" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as { id: string };
      openRoomId = created.id;

      const peerPin = "918273";
      const peerHandle = `rdiscpeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "rdisc-peer",
          email: `rdisc-peer-${Date.now()}@test.local`,
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
      const peerDiscover = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/discoverable",
        bearer: peerToken,
      });
      expect(peerDiscover.statusCode).toBe(200);
      const peerBody = JSON.parse(peerDiscover.body) as { rooms: Array<{ id: string }> };
      expect(peerBody.rooms.some((r) => r.id === openRoomId)).toBe(true);

      const adminDiscover = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/discoverable",
        bearer: adminToken,
      });
      expect(adminDiscover.statusCode).toBe(200);
      const adminBody = JSON.parse(adminDiscover.body) as { rooms: Array<{ id: string }> };
      expect(adminBody.rooms.some((r) => r.id === openRoomId)).toBe(false);

      const unauthRes = await fx.app.inject({
        method: "GET",
        url: "/api/rooms/discoverable",
      });
      expect(unauthRes.statusCode).toBe(401);
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
