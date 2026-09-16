import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, rooms, sessions, sessionMessages } from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

/**
 * ISSUE-M172 — REST surface for `DELETE /api/rooms/:roomId/messages/:messageId`.
 *
 * Covers the reachable HTTP status matrix under the default RBAC seed: 200 (own
 * + agent message, owner holds `manage_rooms`), 404 (unknown id, non-member),
 * and 409 (subthread anchor). NOTE: a 403 (`forbidden`) is unreachable with the
 * default seed because `manage_rooms` is held by every non-guest rung (and a
 * guest fails the verified-member gate → 404); the forbidden branch is covered
 * by the pure `decideMessageDelete` unit test in `@nautilo/trust`.
 */

let fx: AppFixture;
let ownerBearer: string;

async function seedRoomMessage(role: "user" | "assistant"): Promise<number> {
  const roomId = fx.defaultRoomId!;
  const [sess] = await fx.db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}:del-${randomUUID()}`,
      ownerId: fx.ownerId,
      personaId: "owner",
      agentId: fx.defaultAgentId!,
      roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("session seed failed");
  const [msg] = await fx.db
    .insert(sessionMessages)
    .values({ sessionId: sess.id, role, content: "deletable body" })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("message seed failed");
  return msg.id;
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "delmsg", withDefaultAgentGraph: true });
  ownerBearer = await fx.mintOwnerBearer();
});

afterAll(async () => {
  if (fx) await fx.cleanup();
});

const ROOM = () => fx.defaultRoomId!;

function deleteMessage(roomId: string, messageId: string | number, bearer: string) {
  return authedInject(fx.app, {
    method: "DELETE",
    url: `/api/rooms/${roomId}/messages/${messageId}`,
    bearer,
    payload: {},
  });
}

describe("M172 delete-message REST", () => {
  test("owner deletes their own user message → 200 and the row is gone", async () => {
    const messageId = await seedRoomMessage("user");
    const res = await deleteMessage(ROOM(), messageId, ownerBearer);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const remaining = await fx.db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, messageId));
    expect(remaining.length).toBe(0);

    // A second delete of the now-gone row is a 404.
    const again = await deleteMessage(ROOM(), messageId, ownerBearer);
    expect(again.statusCode).toBe(404);
  });

  test("manage_rooms owner deletes the agent's assistant message → 200", async () => {
    const messageId = await seedRoomMessage("assistant");
    const res = await deleteMessage(ROOM(), messageId, ownerBearer);
    expect(res.statusCode).toBe(200);
  });

  test("unknown message id → 404", async () => {
    const res = await deleteMessage(ROOM(), 2_147_483_600, ownerBearer);
    expect(res.statusCode).toBe(404);
  });

  test("non-member → 404 (never reveal existence)", async () => {
    const messageId = await seedRoomMessage("user");
    const peer = await seatPeerUser(fx.db, { suiteName: "delpeer", groupType: "members" });
    const res = await deleteMessage(ROOM(), messageId, peer.bearer);
    expect(res.statusCode).toBe(404);
    // Row untouched.
    const still = await fx.db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, messageId));
    expect(still.length).toBe(1);
    await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
  });

  test("subthread anchor → 409 message_anchors_thread (anchor survives)", async () => {
    const anchorId = await seedRoomMessage("user");
    const [room] = await fx.db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, ROOM()));
    if (!room) throw new Error("default room not found");
    const [sub] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "sub",
        kind: "subthread",
        parentRoomId: ROOM(),
        threadRootMessageId: anchorId,
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: room.namespaceId,
        humanActorIds: [fx.ownerActorId],
      })
      .returning({ id: rooms.id });
    if (!sub) throw new Error("subthread seed failed");

    try {
      const res = await deleteMessage(ROOM(), anchorId, ownerBearer);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "message_anchors_thread" });
      const still = await fx.db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, anchorId));
      expect(still.length).toBe(1);
    } finally {
      await fx.db.delete(rooms).where(eq(rooms.id, sub.id));
      await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, anchorId));
    }
  });
});
