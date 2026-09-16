/**
 * M240 — canonical `room.notification.changed` WS surface:
 *  - new message in a room → each recipient (humans minus sender) gets one
 *    viewer-scoped frame; the sender gets none;
 *  - `POST /api/rooms/:id/read` → caller gets a frame with unreadCount 0;
 *  - idempotent re-POST → zero frames (D196 emit-on-change watchpoint).
 *
 * Live instance via NAUTILO_INSTANCE_ID; fixture ensureDatabase is a no-op
 * migration on an already-migrated instance.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import {
  actors,
  agents,
  users,
  profiles,
  channelIdentities,
  groupMembers,
  roomMembers,
  sessions,
  sessionMessages,
  eq,
  inArray,
} from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

function isNotificationFrame(roomId: string) {
  return (e: unknown): e is {
    type: string;
    roomId: string;
    topLevelRoomId: string;
    roomOwnUnreadCount: number;
  } =>
    typeof e === "object" &&
    e !== null &&
    (e as { type?: string }).type === "room.notification.changed" &&
    (e as { roomId?: string }).roomId === roomId;
}

describe("M240 room.notification.changed WS", () => {
  test("recipient gets a frame on new message; sender doesn't; mark-read zeros + idempotent", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "m122ws", withDefaultAgentGraph: true });
    const roomId = fx.defaultRoomId!;
    const createdSessionIds: string[] = [];
    const peer = await seatPeerUser(fx.db, { suiteName: "m122ws", groupType: "members" });
    try {
      // Peer B joins the room so its WS subscription includes it on connect.
      await fx.db.insert(roomMembers).values({ roomId, actorId: peer.actorId, roomRole: "member" });

      // 4 unread assistant messages in the room.
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

      await withListeningServer(fx.app, async (base) => {
        const url = httpBaseToWsUrl(base, "/ws");
        const tOwner = await fx.mintOwnerBearer();
        const cOwner = await connectWsTestClient({ url, token: tOwner });
        const cB = await connectWsTestClient({ url, token: peer.bearer });

        // (1) Message arrival: emit message.new with the owner as sender.
        eventBus.emit({
          type: "message.new",
          laneKey: `room:${roomId}`,
          messageId: "999999",
          role: "user",
          content: "hi",
          senderUserId: fx.ownerId,
        });

        // B (recipient) receives a viewer-scoped frame with its count (4).
        const bFrame = await cB.waitForEvent(isNotificationFrame(roomId), 5_000);
        expect(bFrame.topLevelRoomId).toBe(roomId);
        expect(bFrame.roomOwnUnreadCount).toBe(4);

        // Owner is the sender → no frame.
        let ownerTimedOut = false;
        try {
          await cOwner.waitForEvent(isNotificationFrame(roomId), 600);
        } catch (e) {
          ownerTimedOut = e instanceof Error && /timed out/i.test(e.message);
        }
        expect(ownerTimedOut).toBe(true);

        // (2) Owner marks the room read over HTTP → owner gets a 0 frame.
        const markRes = await fetch(`${base}/api/rooms/${roomId}/read`, {
          method: "POST",
          headers: { authorization: `Bearer ${tOwner}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(markRes.status).toBe(200);
        const markBody = (await markRes.json()) as { ok: boolean; marked: number };
        expect(markBody.marked).toBe(4);

        const ownerZero = await cOwner.waitForEvent(isNotificationFrame(roomId), 5_000);
        expect(ownerZero.roomOwnUnreadCount).toBe(0);

        // (3) Idempotent re-POST → no NEW frame (emit-on-change gate). The
        // harness buffers events, so count matching frames before/after.
        const countFrames = () =>
          cOwner.events.filter((e) => isNotificationFrame(roomId)(e)).length;
        const before = countFrames();
        const re = await fetch(`${base}/api/rooms/${roomId}/read`, {
          method: "POST",
          headers: { authorization: `Bearer ${tOwner}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(((await re.json()) as { marked: number }).marked).toBe(0);
        await new Promise((r) => setTimeout(r, 600));
        expect(countFrames()).toBe(before);

        await cOwner.close();
        await cB.close();
      });
    } finally {
      await fx.db.delete(roomMembers).where(eq(roomMembers.actorId, peer.actorId));
      if (createdSessionIds.length > 0) {
        await fx.db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, createdSessionIds));
        await fx.db.delete(sessions).where(inArray(sessions.id, createdSessionIds));
      }
      // Peer teardown (mirrors seatPeerUser inserts).
      await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
      await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peer.userId));
      await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
      const peerAgentActors = await fx.db
        .select({ agentId: actors.agentId })
        .from(actors)
        .where(eq(actors.ownerId, peer.userId));
      await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
      for (const a of peerAgentActors) {
        if (a.agentId) await fx.db.delete(agents).where(eq(agents.id, a.agentId));
      }
      await fx.db.delete(users).where(eq(users.id, peer.userId));
      await fx.cleanup();
    }
  });
});
