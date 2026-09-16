/**
 * D124 — WS `message.new` does not stamp `markDelivered` for the sender's socket (B3).
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";

const markDeliveredMock = mock(() => Promise.resolve());

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    markDelivered: markDeliveredMock,
    getHumanSenderUserIdForMessageBroadcast: async () => "sender-uid",
  };
});

import { addClient, broadcast } from "../../src/realtime/ws-publisher";

afterAll(() => {
  mock.restore();
});

const TEST_ROOM_ID = "33333333-3333-4333-8333-333333333333";

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  CONNECTING: number;
  send(payload: string): void;
  on(_event: "close", _handler: () => void): void;
  [k: string]: unknown;
}

function makeClient(open = true): MockWs {
  return {
    readyState: open ? 1 : 3,
    sent: [],
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    CONNECTING: 0,
    send(payload: string) {
      this.sent.push(payload);
    },
    on() {
      /* no-op */
    },
  };
}

describe("ws-publisher message.new markDelivered (B3)", () => {
  test("skips markDelivered for the sender's userId only", async () => {
    markDeliveredMock.mockClear();

    const sender = makeClient(true);
    const recipient = makeClient(true);
    addClient(sender as unknown as WsWebSocket, {
      userId: "sender-uid",
      actorId: "act-sender",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(recipient as unknown as WsWebSocket, {
      userId: "other-uid",
      actorId: "act-other",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "message.new",
      laneKey: `room:${TEST_ROOM_ID}`,
      messageId: "42",
      role: "human",
      content: "hi",
    });

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(sender.sent.length).toBe(1);
    expect(recipient.sent.length).toBe(1);
    expect(markDeliveredMock.mock.calls.length).toBe(1);
    const first = markDeliveredMock.mock.calls[0] as unknown as [number, string];
    expect(first[0]).toBe(42);
    expect(first[1]).toBe("other-uid");
  });
});
