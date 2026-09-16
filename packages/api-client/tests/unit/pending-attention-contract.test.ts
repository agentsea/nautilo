import { describe, expect, test } from "bun:test";

import {
  isRoomPendingAttentionEventForViewer,
  NautiloApiClient,
  type NautiloApiFetch,
  type RoomPendingAttentionEvent,
} from "../../src/client";

const ROOM = "40000000-0000-4000-8000-000000000322";
const HUMAN = "20000000-0000-4000-8000-000000000322";
const AGENT = "30000000-0000-4000-8000-000000000322";
const USER = "10000000-0000-4000-8000-000000000322";

function approval(laneKey: string): RoomPendingAttentionEvent {
  return {
    type: "approval.ask",
    approvalId: "approval-322",
    threadId: "thread-322",
    laneKey,
    userId: USER,
    tools: [{ name: "read_file", args: { path: "/tmp/example" } }],
    reason: "Review required",
    reasonCode: "destructive-tool",
    allowedVerbs: ["once", "deny"],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("pending attention HTTP contract", () => {
  test("posts exact action-session/device coordinates with an opaque cursor", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      seen = {
        url: typeof target === "string" ? target
          : target instanceof URL ? target.href : target.url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      return json({ status: "ready", events: [], nextCursor: null });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    await client.getRoomPendingAttention(ROOM, {
      clientActionSessionId: "action-session-322",
      authorizationDeviceId: "device-322",
      cursor: "eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA5LTA5VDAwOjAwOjAwLjAwMFoifQ",
    });

    expect(seen).toEqual({
      url: `https://nautilo.test/api/rooms/${ROOM}/pending-attention`,
      body: {
        clientActionSessionId: "action-session-322",
        authorizationDeviceId: "device-322",
        cursor: "eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA5LTA5VDAwOjAwOjAwLjAwMFoifQ",
      },
    });
  });

  test("admits only exact direct or Human-bound group Room lanes", () => {
    const expected = { roomId: ROOM, userId: USER, humanActorId: HUMAN };
    expect(isRoomPendingAttentionEventForViewer(approval(`room:${ROOM}`), expected))
      .toBeTrue();
    expect(isRoomPendingAttentionEventForViewer(
      approval(`room:${ROOM}:user:${HUMAN}:bot:${AGENT}`),
      expected,
    )).toBeTrue();
    for (const laneKey of [
      `room:${ROOM}:unexpected`,
      `room:${ROOM}:user:${AGENT}:bot:${AGENT}`,
      `room:${ROOM}:user:not-a-uuid:bot:${AGENT}`,
      `room:${ROOM}:user:${HUMAN}:bot:not-a-uuid`,
    ]) {
      expect(isRoomPendingAttentionEventForViewer(approval(laneKey), expected))
        .toBeFalse();
    }
  });

  test("rejects arbitrary realtime events from the recovery response", async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: () => Promise.resolve(json({
        status: "ready",
        events: [{
          type: "message.tokens",
          laneKey: `room:${ROOM}`,
          content: "must not replay",
          chunkSequence: 1,
          done: true,
          threadId: "thread-322",
          userId: USER,
        }],
        nextCursor: null,
      })),
    });
    let rejected = false;
    try {
      await client.getRoomPendingAttention(ROOM, {
        clientActionSessionId: "action-session-322",
        authorizationDeviceId: "device-322",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBeTrue();
  });
});
