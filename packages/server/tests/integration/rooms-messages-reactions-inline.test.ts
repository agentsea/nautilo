import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessions, sessionMessages } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

/**
 * M121 Phase 3 — reactions inlined into `GET /api/rooms/:id/messages`.
 * MR3: zero-reaction rows omit the field (byte-identical to pre-M121);
 * non-zero rows carry `ReactionAggregate[]`.
 */

let fx: AppFixture;
let bearer: string;
let reactedId: number;
let plainId: number;

interface WireMessage {
  id: string;
  reactions?: { emoji: string; count: number }[];
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "rxinline", withDefaultAgentGraph: true });
  bearer = await fx.mintOwnerBearer();

  const roomId = fx.defaultRoomId!;
  const [sess] = await fx.db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}:inline-${Date.now()}`,
      ownerId: fx.ownerId,
      personaId: "owner",
      agentId: fx.defaultAgentId!,
      roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("session seed failed");

  const rows = await fx.db
    .insert(sessionMessages)
    .values([
      { sessionId: sess.id, role: "assistant", content: "reacted message" },
      { sessionId: sess.id, role: "assistant", content: "plain message" },
    ])
    .returning({ id: sessionMessages.id });
  reactedId = rows[0]!.id;
  plainId = rows[1]!.id;

  const put = await authedInject(fx.app, {
    method: "PUT",
    url: `/api/rooms/${roomId}/messages/${reactedId}/reactions/${encodeURIComponent("👀")}`,
    bearer,
    payload: {},
  });
  expect(put.statusCode).toBe(200);
});

afterAll(async () => {
  if (fx) await fx.cleanup();
});

describe("M121 inline reactions on GET messages", () => {
  test("reacted message carries reactions; plain message omits the field", async () => {
    const future = encodeURIComponent("2999-01-01T00:00:00.000Z");
    const res = await authedInject(fx.app, {
      method: "GET",
      url: `/api/rooms/${fx.defaultRoomId!}/messages?beforeId=2147483647&beforeCreatedAt=${future}&limit=200`,
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { messages: WireMessage[] };

    const reacted = body.messages.find((m) => Number(m.id) === reactedId);
    const plain = body.messages.find((m) => Number(m.id) === plainId);
    expect(reacted).toBeDefined();
    expect(plain).toBeDefined();

    expect(reacted!.reactions).toBeDefined();
    expect(reacted!.reactions!.find((r) => r.emoji === "👀")?.count).toBe(1);

    // MR3: zero-reaction row omits the field entirely.
    expect("reactions" in plain!).toBe(false);
  });
});
