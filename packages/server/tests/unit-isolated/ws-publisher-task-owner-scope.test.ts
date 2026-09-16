/**
 * M143 — `task.*` lifecycle events are owner-scoped (Blast-radius S7, D14).
 * A `task.completed` event must reach ONLY the owner's WS sockets, never the
 * other connected users (no room-wide broadcast).
 */
import { describe, expect, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";
import { addClient, broadcast } from "../../src/realtime/ws-publisher";

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

function makeClient(): MockWs {
  return {
    readyState: 1,
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

describe("ws-publisher task.* owner-scope (M143 S7)", () => {
  test("task.completed delivered only to the owner's sockets", async () => {
    const ownerSock = makeClient();
    const otherSock = makeClient();
    addClient(ownerSock as unknown as WsWebSocket, {
      userId: "owner-uid",
      actorId: "act-owner",
      roomIds: new Set(),
    });
    addClient(otherSock as unknown as WsWebSocket, {
      userId: "other-uid",
      actorId: "act-other",
      roomIds: new Set(),
    });

    broadcast({
      type: "task.completed",
      taskId: "t1",
      taskRunId: "r1",
      status: "completed",
      ownerId: "owner-uid",
    });

    await new Promise<void>((r) => setImmediate(r));

    expect(ownerSock.sent.length).toBe(1);
    expect(JSON.parse(ownerSock.sent[0]!)).toMatchObject({ type: "task.completed", taskId: "t1" });
    expect(otherSock.sent.length).toBe(0);
  });

  test("M147 — task.status delivered only to the owner's sockets", async () => {
    const ownerSock = makeClient();
    const otherSock = makeClient();
    addClient(ownerSock as unknown as WsWebSocket, {
      userId: "owner-uid",
      actorId: "act-owner",
      roomIds: new Set(),
    });
    addClient(otherSock as unknown as WsWebSocket, {
      userId: "other-uid",
      actorId: "act-other",
      roomIds: new Set(),
    });

    broadcast({
      type: "task.status",
      taskId: "t9",
      status: "paused",
      ownerId: "owner-uid",
    });

    await new Promise<void>((r) => setImmediate(r));

    expect(ownerSock.sent.length).toBe(1);
    expect(JSON.parse(ownerSock.sent[0]!)).toMatchObject({
      type: "task.status",
      taskId: "t9",
      status: "paused",
    });
    expect(otherSock.sent.length).toBe(0);
  });
});
