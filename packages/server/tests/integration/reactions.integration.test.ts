import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  eq,
  messageReactions,
  sessions,
  sessionMessages,
} from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

/**
 * M121 — REST substrate for message reactions (PUT / DELETE / GET).
 * Covers MR1 (idempotency), MR2 (membership gate / cross-room 404),
 * MR5 (cascade), MR6 (emoji validation).
 */

let fx: AppFixture;
let ownerBearer: string;
let messageId: number;

async function seedRoomMessage(): Promise<number> {
  const roomId = fx.defaultRoomId!;
  const [sess] = await fx.db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}:rx-${Date.now()}`,
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
    .values({ sessionId: sess.id, role: "assistant", content: "reactable body" })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("message seed failed");
  return msg.id;
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "rx", withDefaultAgentGraph: true });
  ownerBearer = await fx.mintOwnerBearer();
  messageId = await seedRoomMessage();
});

afterAll(async () => {
  if (fx) await fx.cleanup();
});

const ROOM = () => fx.defaultRoomId!;
const EMOJI = encodeURIComponent("🎉");

// PUT/DELETE need a (valid) JSON body or Fastify's parser 400s an empty
// application/json request before the handler runs.
function putReaction(url: string, bearer: string) {
  return authedInject(fx.app, { method: "PUT", url, bearer, payload: {} });
}
function deleteReaction(url: string, bearer: string) {
  return authedInject(fx.app, { method: "DELETE", url, bearer, payload: {} });
}

describe("M121 reactions REST", () => {
  test("PUT then GET round-trip surfaces the reaction with the caller's actor id", async () => {
    const put = await putReaction(
      `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(put.statusCode).toBe(200);
    const putBody = JSON.parse(put.body) as {
      reactions: { emoji: string; count: number; actorIds: string[] }[];
    };
    const agg = putBody.reactions.find((r) => r.emoji === "🎉");
    expect(agg).toBeDefined();
    expect(agg!.count).toBe(1);
    expect(agg!.actorIds).toContain(fx.ownerActorId);

    const get = await authedInject(fx.app, {
      method: "GET",
      url: `/api/rooms/${ROOM()}/messages/${messageId}/reactions`,
      bearer: ownerBearer,
    });
    expect(get.statusCode).toBe(200);
    const getBody = JSON.parse(get.body) as { reactions: { emoji: string; count: number }[] };
    expect(getBody.reactions.find((r) => r.emoji === "🎉")?.count).toBe(1);
  });

  test("MR1: double PUT is idempotent (count stays 1)", async () => {
    const put = await putReaction(
      `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(put.statusCode).toBe(200);
    const body = JSON.parse(put.body) as { reactions: { emoji: string; count: number }[] };
    expect(body.reactions.find((r) => r.emoji === "🎉")?.count).toBe(1);
  });

  test("MR1: DELETE then DELETE-absent returns 200 (not 404)", async () => {
    const del1 = await deleteReaction(
      `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(del1.statusCode).toBe(200);
    const body1 = JSON.parse(del1.body) as { reactions: { emoji: string }[] };
    expect(body1.reactions.find((r) => r.emoji === "🎉")).toBeUndefined();

    const del2 = await deleteReaction(
      `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(del2.statusCode).toBe(200);
  });

  test("MR6: over-length emoji rejected with 400", async () => {
    const longEmoji = "a".repeat(33);
    const put = await putReaction(
      `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${longEmoji}`,
      ownerBearer,
    );
    expect(put.statusCode).toBe(400);
  });

  test("MR2: non-existent / cross-room messageId returns 404", async () => {
    const put = await putReaction(
      `/api/rooms/${ROOM()}/messages/2147483600/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(put.statusCode).toBe(404);
  });

  test("MR2: a non-member receives 404 on PUT / DELETE / GET", async () => {
    const peer = await seatPeerUser(fx.db, { suiteName: "rxpeer", groupType: "members" });
    try {
      const urlEmoji = `/api/rooms/${ROOM()}/messages/${messageId}/reactions/${EMOJI}`;
      const urlList = `/api/rooms/${ROOM()}/messages/${messageId}/reactions`;
      const put = await putReaction(urlEmoji, peer.bearer);
      expect(put.statusCode).toBe(404);
      const del = await deleteReaction(urlEmoji, peer.bearer);
      expect(del.statusCode).toBe(404);
      const get = await authedInject(fx.app, { method: "GET", url: urlList, bearer: peer.bearer });
      expect(get.statusCode).toBe(404);
    } finally {
      await fx.db.delete(messageReactions).where(eq(messageReactions.actorId, peer.actorId));
    }
  });

  test("MR5: deleting the message cascade-removes its reactions", async () => {
    const tmpMessageId = await seedRoomMessage();
    const put = await putReaction(
      `/api/rooms/${ROOM()}/messages/${tmpMessageId}/reactions/${EMOJI}`,
      ownerBearer,
    );
    expect(put.statusCode).toBe(200);

    const before = await fx.db
      .select({ messageId: messageReactions.messageId })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, tmpMessageId));
    expect(before.length).toBe(1);

    await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, tmpMessageId));

    const after = await fx.db
      .select({ messageId: messageReactions.messageId })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, tmpMessageId));
    expect(after.length).toBe(0);
  });
});
