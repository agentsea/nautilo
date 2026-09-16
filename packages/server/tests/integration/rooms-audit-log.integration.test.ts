/**
 * M124 — Blast-Radius scenario 19: the security-audit log FILE gains
 * correctly-shaped `room_member_self_joined` / `room_member_self_left` rows
 * on self-join / self-leave.
 *
 * The hermetic route unit test only proves `writeSecurityAuditEvent` is
 * called; this reads the real append-only JSONL (`~/.nautilo/logs/
 * security-audit.log`, the path `roomAudit` writes to) and asserts the row
 * shape, scoped to the test's unique actor id to avoid cross-talk.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { readSecurityAuditLog } from "../../src/lib/security-audit-log";

// Same path `roomAudit` writes to in `routes/rooms.ts` (`roomAuditPath()`).
const AUDIT_LOG_PATH = join(homedir(), ".nautilo", "logs", "security-audit.log");

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

describe("M124 — security-audit log rows for self-join / self-leave (scenario 19)", () => {
  test("self-join writes room_member_self_joined; self-leave writes room_member_self_left", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "raudit" });
    let openRoomId: string | null = null;
    let peerUserId: string | null = null;
    let peerActorId: string | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const createRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#audit-target", kind: "open" },
      });
      expect(createRes.statusCode).toBe(201);
      openRoomId = (JSON.parse(createRes.body) as { id: string }).id;

      const peerHandle = `rauditpeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "raudit-peer",
          email: `raudit-peer-${Date.now()}@test.local`,
          handle: peerHandle,
          externalId: randomUUID(),
        })
        .returning({ id: users.id });
      if (!u) throw new Error("user");
      peerUserId = u.id;
      const [a] = await fx.db
        .insert(actors)
        .values({ ownerId: u.id, displayName: "Peer", trustState: "verified", kind: "user" })
        .returning({ id: actors.id });
      if (!a) throw new Error("actor");
      peerActorId = a.id;
      await fx.db
        .insert(credentials)
        .values({ userId: u.id, type: "pin", value: await hashPin("918273") });
      const fed = composeFederatedId(peerHandle, getServerHostname());
      await fx.db
        .insert(channelIdentities)
        .values([{ channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() }]);
      const peerToken = await fx.mintSessionBearerForUser(a.id, u.id);

      // Self-join.
      const joinRes = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${openRoomId}/join`,
        bearer: peerToken,
        payload: {},
      });
      expect(joinRes.statusCode).toBe(200);

      const afterJoin = readSecurityAuditLog(AUDIT_LOG_PATH, {
        actorId: peerActorId,
        limit: 50,
      });
      const joinRow = afterJoin.events.find((e) => e.kind === "room_member_self_joined");
      expect(joinRow).toBeDefined();
      expect((joinRow as { roomId?: string }).roomId).toBe(openRoomId);
      expect(joinRow?.actorId).toBe(peerActorId);

      // Self-leave.
      const leaveRes = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/rooms/${openRoomId}/members/${peerActorId}`,
        bearer: peerToken,
      });
      expect(leaveRes.statusCode).toBe(200);

      const afterLeave = readSecurityAuditLog(AUDIT_LOG_PATH, {
        actorId: peerActorId,
        limit: 50,
      });
      const leaveRow = afterLeave.events.find((e) => e.kind === "room_member_self_left");
      expect(leaveRow).toBeDefined();
      expect((leaveRow as { roomId?: string }).roomId).toBe(openRoomId);
      expect(leaveRow?.actorId).toBe(peerActorId);
    } finally {
      if (openRoomId) await deleteRoomAndNamespace(fx.db, openRoomId);
      if (peerUserId) {
        await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
        await fx.db.delete(credentials).where(eq(credentials.userId, peerUserId));
        if (peerActorId) await fx.db.delete(actors).where(eq(actors.id, peerActorId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  });
});
