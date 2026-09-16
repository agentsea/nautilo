import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessions, sessionMessages } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "../helpers/app-fixture";
import { authedInject, withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

/**
 * M121 Phase 4 — reaction WS events on the `room:<id>` lane.
 * MR4 (room-lane only), MR8 (emit only on a real state change).
 */

let fx: AppFixture;
let bearer: string;
let messageId: number;

interface ReactionFrame {
  type: string;
  laneKey?: string;
  messageId?: number;
  emoji?: string;
}

function isReaction(type: string, emoji: string, lane: string) {
  return (e: unknown): e is ReactionFrame =>
    typeof e === "object" &&
    e !== null &&
    (e as ReactionFrame).type === type &&
    (e as ReactionFrame).laneKey === lane &&
    (e as ReactionFrame).emoji === emoji;
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "rxws", withDefaultAgentGraph: true });
  bearer = await fx.mintOwnerBearer();
  const roomId = fx.defaultRoomId!;
  const [sess] = await fx.db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}:ws-${Date.now()}`,
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
    .values({ sessionId: sess.id, role: "assistant", content: "ws reactable" })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("message seed failed");
  messageId = msg.id;
});

afterAll(async () => {
  if (fx) await fx.cleanup();
});

describe("M121 reaction WS events", () => {
  test("PUT emits reaction.added and DELETE emits reaction.removed on the room lane; idempotent PUT emits once", async () => {
    const roomId = fx.defaultRoomId!;
    const lane = `room:${roomId}`;
    const emoji = "🎉";
    const encoded = encodeURIComponent(emoji);

    await withListeningServer(fx.app, async (base) => {
      const client = await connectWsTestClient({
        url: httpBaseToWsUrl(base, "/ws"),
        token: bearer,
      });
      try {
        const put1 = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/rooms/${roomId}/messages/${messageId}/reactions/${encoded}`,
          bearer,
          payload: {},
        });
        expect(put1.statusCode).toBe(200);

        const added = await client.waitForEvent(
          isReaction("reaction.added", emoji, lane),
          8_000,
        );
        expect(added.messageId).toBe(messageId);

        // MR8: idempotent re-PUT must NOT emit a second event.
        const put2 = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/rooms/${roomId}/messages/${messageId}/reactions/${encoded}`,
          bearer,
          payload: {},
        });
        expect(put2.statusCode).toBe(200);
        await new Promise((r) => setTimeout(r, 400));
        const addedCount = client.events.filter(
          isReaction("reaction.added", emoji, lane),
        ).length;
        expect(addedCount).toBe(1);

        const del = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/rooms/${roomId}/messages/${messageId}/reactions/${encoded}`,
          bearer,
          payload: {},
        });
        expect(del.statusCode).toBe(200);
        const removed = await client.waitForEvent(
          isReaction("reaction.removed", emoji, lane),
          8_000,
        );
        expect(removed.messageId).toBe(messageId);

        // MR8: DELETE of an absent row must NOT emit.
        const delAbsent = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/rooms/${roomId}/messages/${messageId}/reactions/${encoded}`,
          bearer,
          payload: {},
        });
        expect(delAbsent.statusCode).toBe(200);
        await new Promise((r) => setTimeout(r, 400));
        const removedCount = client.events.filter(
          isReaction("reaction.removed", emoji, lane),
        ).length;
        expect(removedCount).toBe(1);
      } finally {
        await client.close();
      }
    });
  });
});
