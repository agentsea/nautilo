/**
 * M124 — POST /api/rooms { kind: "open" } (integration).
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

describe("POST /api/rooms { kind: 'open' } (M124 integration)", () => {
  test("admin creates open room; non-admin and unauthenticated are rejected", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "rco" });
    const createdRoomIds: string[] = [];
    let peerUserId: string | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const createRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#announce", kind: "open" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as {
        id: string;
        kind: string;
        type: string;
        members: Array<{ actorId: string; roomRole: string; kind: string }>;
      };
      createdRoomIds.push(created.id);
      expect(created.kind).toBe("open");
      expect(created.type).toBe("shared");
      expect(created.members).toHaveLength(1);
      expect(created.members[0]?.actorId).toBe(fx.ownerActorId);
      expect(created.members[0]?.roomRole).toBe("admin");
      expect(created.members.every((m) => m.kind !== "agent")).toBe(true);

      const peerPin = "918273";
      const peerHandle = `rcopeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "rco-peer",
          email: `rco-peer-${Date.now()}@test.local`,
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
      const forbiddenRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: peerToken,
        payload: { label: "#nope", kind: "open" },
      });
      expect(forbiddenRes.statusCode).toBe(403);
      const forbiddenBody = JSON.parse(forbiddenRes.body) as { code: string };
      expect(forbiddenBody.code).toBe("admin_required");

      const unauthRes = await fx.app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { "content-type": "application/json" },
        payload: { label: "#x", kind: "open" },
      });
      expect(unauthRes.statusCode).toBe(401);
    } finally {
      for (const roomId of createdRoomIds) {
        await deleteRoomAndNamespace(fx.db, roomId);
      }
      if (peerUserId) {
        await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
        await fx.db.delete(credentials).where(eq(credentials.userId, peerUserId));
        await fx.db.delete(actors).where(eq(actors.ownerId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  });
});
