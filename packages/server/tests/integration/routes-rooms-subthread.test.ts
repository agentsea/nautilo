/**
 * D111 — POST/GET subthread routes + agent-less group room (integration).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import { eq, sessions, sessionMessages, rooms, roomMembers, actors, users, namespaces } from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import { addClient, publishRoomMembersChanged } from "../../src/realtime/ws-publisher";
import type { WebSocket as WsWebSocket } from "ws";

function fakeSocket() {
  let closeHandler: (() => void) | null = null;
  return {
    OPEN: 1,
    readyState: 1,
    sent: [] as string[],
    send(payload: string) {
      this.sent.push(payload);
    },
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
    },
    closeForTest() {
      closeHandler?.();
    },
  };
}

describe("D111 rooms — subthreads + explicit members (integration)", () => {
  test("POST message subthread + GET list; POST /api/rooms with two users → kind group", async () => {
    if (process.env["AUTH_MODE"] === "logto") {
      return;
    }
    const fx = await setupOwnerAppFixture({
      suiteName: "r-st",
      withDefaultAgentGraph: true,
    });
    let subthreadId: string | null = null;
    let extraUserId: string | null = null;
    let sessionId: string | null = null;
    let messageId: number | null = null;
    let groupRoomId: string | null = null;
    try {
      const roomId = fx.defaultRoomId!;
      const [sess] = await fx.db
        .insert(sessions)
        .values({
          threadId: `room:${roomId}`,
          ownerId: fx.ownerId,
          personaId: "owner",
          agentId: fx.defaultAgentId!,
          roomId,
          channel: "tui",
        })
        .returning({ id: sessions.id });
      if (!sess) throw new Error("session");
      sessionId = sess.id;
      const [msg] = await fx.db
        .insert(sessionMessages)
        .values({ sessionId: sess.id, role: "user", content: "anchor" })
        .returning({ id: sessionMessages.id });
      if (!msg) throw new Error("msg");
      messageId = msg.id;

      const token = await fx.mintOwnerBearer();
      const postSt = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${roomId}/messages/${messageId}/subthreads`,
        bearer: token,
        payload: { label: "Side" },
      });
      expect(postSt.statusCode).toBe(201);
      const stBody = JSON.parse(postSt.body) as { subthreadRoomId: string };
      subthreadId = stBody.subthreadRoomId;

      const listSt = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${roomId}/subthreads`,
        bearer: token,
      });
      expect(listSt.statusCode).toBe(200);
      const listBody = JSON.parse(listSt.body) as { subthreads: { id: string }[] };
      expect(listBody.subthreads.some((s) => s.id === subthreadId)).toBe(true);

      const detailRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${subthreadId}/thread-detail`,
        bearer: token,
      });
      expect(detailRes.statusCode).toBe(200);
      const detailBody = JSON.parse(detailRes.body) as {
        parentRoomId: string;
        subthreadRoomId: string;
        anchor: { id: string; content: string; replyCount: number; summaryRevision: number };
        summary: { replyCount: number; lastReplyAt: string | null; summaryRevision: number };
      };
      expect(detailBody.parentRoomId).toBe(roomId);
      expect(detailBody.subthreadRoomId).toBe(subthreadId);
      expect(detailBody.anchor).toMatchObject({
        id: String(messageId),
        content: "anchor",
        replyCount: 0,
        summaryRevision: 0,
      });
      expect(detailBody.summary).toEqual({
        replyCount: 0,
        lastReplyAt: null,
        summaryRevision: 0,
      });
      expect(detailBody).not.toHaveProperty("responder");

      const explorerRes = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms",
        bearer: token,
      });
      expect(explorerRes.statusCode).toBe(200);
      const explorerBody = JSON.parse(explorerRes.body) as { rooms: { id: string }[] };
      expect(explorerBody.rooms.some((room) => room.id === subthreadId)).toBe(false);
      expect(explorerBody.rooms.some((room) => room.id === roomId)).toBe(true);

      const parentAsThread = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${roomId}/thread-detail`,
        bearer: token,
      });
      expect(parentAsThread.statusCode).toBe(404);
      const malformedThread = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/not-a-uuid/thread-detail",
        bearer: token,
      });
      expect(malformedThread.statusCode).toBe(404);

      // Re-register an already-connected member with only the parent lane,
      // then repeat the idempotent create. The route must refresh the child
      // membership before returning, without subscribing an outsider.
      const memberSocket = fakeSocket();
      const outsiderSocket = fakeSocket();
      addClient(memberSocket as unknown as WsWebSocket, {
        userId: fx.ownerId,
        actorId: fx.ownerActorId,
        roomIds: new Set([roomId]),
      });
      addClient(outsiderSocket as unknown as WsWebSocket, {
        userId: "00000000-0000-4000-8000-000000000099",
        actorId: "00000000-0000-4000-8000-000000000098",
        roomIds: new Set([roomId]),
      });
      const repeatCreate = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${roomId}/messages/${messageId}/subthreads`,
        bearer: token,
        payload: { label: "Ignored idempotent label" },
      });
      expect(repeatCreate.statusCode).toBe(201);
      const repeatBody = JSON.parse(repeatCreate.body) as { subthreadRoomId: string };
      expect(repeatBody.subthreadRoomId).toBe(subthreadId);
      publishRoomMembersChanged(subthreadId, {
        kind: "member_added",
        actorId: fx.ownerActorId,
        actorKind: "user",
        displayName: "Owner",
      });
      expect(memberSocket.sent).toHaveLength(1);
      expect(outsiderSocket.sent).toHaveLength(0);
      memberSocket.closeForTest();
      outsiderSocket.closeForTest();

      const ts = Date.now().toString(36);
      const [u2] = await fx.db
        .insert(users)
        .values({
          name: "peer",
          email: `peer-${ts}@test.local`,
          handle: `peer${ts.slice(-6)}`,
          externalId: `peer-sub-${ts}`,
        })
        .returning({ id: users.id });
      if (!u2) throw new Error("u2");
      extraUserId = u2.id;
      const [peerActor] = await fx.db
        .insert(actors)
        .values({
          ownerId: u2.id,
          displayName: "Peer",
          kind: "user",
        })
        .returning({ id: actors.id });
      if (!peerActor) throw new Error("peer actor");

      const peerToken = await fx.mintSessionBearerForUser(peerActor.id, u2.id);
      const outsiderDetail = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${subthreadId}/thread-detail`,
        bearer: peerToken,
      });
      expect(outsiderDetail.statusCode).toBe(404);

      // A parent-only member of a private/group Room must not inherit or
      // mutate an existing child merely by opening its parent anchor.
      await fx.db.insert(roomMembers).values({
        roomId,
        actorId: peerActor.id,
        roomRole: "member",
      });
      const childMembersBefore = await fx.db
        .select({ actorId: roomMembers.actorId })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, subthreadId));
      const hiddenList = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${roomId}/subthreads`,
        bearer: peerToken,
      });
      expect(hiddenList.statusCode).toBe(200);
      expect(JSON.parse(hiddenList.body)).toEqual({ subthreads: [] });
      const hiddenDuplicate = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${roomId}/messages/${messageId}/subthreads`,
        bearer: peerToken,
        payload: {},
      });
      expect(hiddenDuplicate.statusCode).toBe(404);
      expect(JSON.parse(hiddenDuplicate.body)).toEqual({ error: "Not found" });
      const childMembersAfter = await fx.db
        .select({ actorId: roomMembers.actorId })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, subthreadId));
      expect(childMembersAfter).toEqual(childMembersBefore);

      const grp = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: token,
        payload: {
          label: `grp-${ts}`,
          members: [
            { kind: "user", id: fx.ownerId },
            { kind: "user", id: u2.id },
          ],
        },
      });
      expect(grp.statusCode).toBe(201);
      const grpBody = JSON.parse(grp.body) as { id: string; kind: string };
      groupRoomId = grpBody.id;
      expect(grpBody.kind).toBe("group");

      // Corrupt the anchor's session-room relationship to exercise the
      // fail-closed cross-parent guard, then restore it for normal cleanup.
      await fx.db
        .update(sessions)
        .set({ roomId: groupRoomId })
        .where(eq(sessions.id, sessionId));
      const crossParentDetail = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${subthreadId}/thread-detail`,
        bearer: token,
      });
      expect(crossParentDetail.statusCode).toBe(404);
      await fx.db
        .update(sessions)
        .set({ roomId })
        .where(eq(sessions.id, sessionId));
    } finally {
      if (groupRoomId) {
        const [gr] = await fx.db
          .select({ namespaceId: rooms.namespaceId })
          .from(rooms)
          .where(eq(rooms.id, groupRoomId))
          .limit(1);
        await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, groupRoomId));
        await fx.db.delete(rooms).where(eq(rooms.id, groupRoomId));
        if (gr?.namespaceId) {
          await fx.db.delete(namespaces).where(eq(namespaces.id, gr.namespaceId));
        }
      }
      if (extraUserId) {
        await fx.db.delete(actors).where(eq(actors.ownerId, extraUserId));
        await fx.db.delete(users).where(eq(users.id, extraUserId));
      }
      if (subthreadId) {
        await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, subthreadId));
        await fx.db.delete(rooms).where(eq(rooms.id, subthreadId));
      }
      if (messageId !== null) {
        await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
      }
      if (sessionId) {
        await fx.db.delete(sessions).where(eq(sessions.id, sessionId));
      }
      await fx.cleanup();
    }
  });
});
