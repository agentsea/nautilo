/**
 * M122 — `GET /api/rooms` unreadCount + `POST /api/rooms/:roomId/read` REST
 * surface. Full production app via the owner fixture. Live instance (selected by
 * NAUTILO_INSTANCE_ID); the fixture's ensureDatabase is a no-op migration on an
 * already-migrated instance.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect } from "bun:test";
import {
  actors,
  agents,
  users,
  profiles,
  channelIdentities,
  groupMembers,
  sessions,
  sessionMessages,
  eq,
  inArray,
} from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";

async function authGet(app: Awaited<ReturnType<typeof setupOwnerAppFixture>>["app"], url: string, token: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

describe("M122 rooms unread REST", () => {
  test("GET unreadCount, POST mark-read (idempotent), gates", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "m122rest", withDefaultAgentGraph: true });
    const roomId = fx.defaultRoomId!;
    const createdSessionIds: string[] = [];
    try {
      // Seed a session + 4 assistant messages in the owner's default room.
      const [sess] = await fx.db
        .insert(sessions)
        .values({
          threadId: `room:${roomId}:seed`,
          ownerId: fx.ownerId,
          personaId: "owner",
          agentId: fx.defaultAgentId!,
          roomId,
          channel: "tui",
        })
        .returning({ id: sessions.id });
      if (!sess) throw new Error("session insert failed");
      createdSessionIds.push(sess.id);
      for (let i = 0; i < 4; i++) {
        await fx.db
          .insert(sessionMessages)
          .values({ sessionId: sess.id, role: "assistant", content: `m${i}` });
      }

      const token = await fx.mintOwnerBearer();

      // GET /api/rooms → room shows unreadCount: 4
      const list1 = await authGet(fx.app, "/api/rooms", token);
      expect(list1.statusCode).toBe(200);
      const rooms1 = list1.json<{ rooms: Array<{ id: string; unreadCount?: number }> }>().rooms;
      const row1 = rooms1.find((r) => r.id === roomId);
      expect(row1?.unreadCount).toBe(4);

      // 401 without bearer
      const noAuth = await fx.app.inject({ method: "POST", url: `/api/rooms/${roomId}/read`, payload: {} });
      expect(noAuth.statusCode).toBe(401);

      // 400 invalid upToMessageId (zero)
      const bad = await fx.app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/read`,
        headers: { authorization: `Bearer ${token}` },
        payload: { upToMessageId: 0 },
      });
      expect(bad.statusCode).toBe(400);

      // POST mark-read → marked: 4
      const mark = await fx.app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/read`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(mark.statusCode).toBe(200);
      expect(mark.json()).toMatchObject({ ok: true, marked: 4 });

      // GET again → unreadCount: 0
      const list2 = await authGet(fx.app, "/api/rooms", token);
      const row2 = list2
        .json<{ rooms: Array<{ id: string; unreadCount?: number }> }>()
        .rooms.find((r) => r.id === roomId);
      expect(row2?.unreadCount).toBe(0);

      // Idempotent re-POST → marked: 0
      const mark2 = await fx.app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/read`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(mark2.json()).toMatchObject({ ok: true, marked: 0 });

      // 404 for a non-member caller (MR5).
      const peer = await seatPeerUser(fx.db, { suiteName: "m122rest", groupType: "members" });
      try {
        const notMember = await fx.app.inject({
          method: "POST",
          url: `/api/rooms/${roomId}/read`,
          headers: { authorization: `Bearer ${peer.bearer}` },
          payload: {},
        });
        expect(notMember.statusCode).toBe(404);
      } finally {
        await cleanupPeer(fx.db, peer.userId);
      }
    } finally {
      if (createdSessionIds.length > 0) {
        await fx.db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, createdSessionIds));
        await fx.db.delete(sessions).where(inArray(sessions.id, createdSessionIds));
      }
      await fx.cleanup();
    }
  });
});

async function cleanupPeer(
  db: Awaited<ReturnType<typeof setupOwnerAppFixture>>["db"],
  userId: string,
): Promise<void> {
  await db.delete(profiles).where(eq(profiles.userId, userId));
  await db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
  await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  const agentActors = await db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  await db.delete(actors).where(eq(actors.ownerId, userId));
  for (const a of agentActors) {
    if (a.agentId) await db.delete(agents).where(eq(agents.id, a.agentId));
  }
  await db.delete(users).where(eq(users.id, userId));
}
