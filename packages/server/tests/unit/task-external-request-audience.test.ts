import { expect, test } from "bun:test";
import type { WebSocket } from "ws";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent, TaskExternalRequestChangedEvent } from "@nautilo/types";
import { startEventBridge } from "../../src/realtime/event-bridge";
import { addClient } from "../../src/realtime/ws-publisher";

function client(userId: string) {
  const sent: string[] = [];
  let close: (() => void) | undefined;
  const socket = { readyState: 1, OPEN: 1, send: (value: string) => { sent.push(value); },
    on: (name: string, callback: () => void) => { if (name === "close") close = callback; } };
  addClient(socket as unknown as WebSocket, { userId, actorId: `actor-${userId}`, roomIds: new Set(["shared-room"]) });
  return { sent, close: () => close?.() };
}

test("runtime private request hints reach the owner on both devices and never other Room members", () => {
  startEventBridge();
  const owner = client("request-owner");
  const secondDevice = client("request-owner");
  const other = client("room-member");
  try {
    for (const state of ["available", "unavailable"] as const) {
      const event: TaskExternalRequestChangedEvent = { type: "task.external_request.changed", ownerId: "request-owner",
        requestId: "request", taskId: "task", taskRunId: "run", jobId: "job", roomId: "shared-room", state };
      eventBus.emit(event);
      expect(owner.sent.at(-1)).toBe(JSON.stringify(event));
      expect(secondDevice.sent.at(-1)).toBe(JSON.stringify(event));
      expect(other.sent).toHaveLength(0);
    }
    expect(owner.sent).toHaveLength(2);
  } finally { owner.close(); secondDevice.close(); other.close(); }
});

test("a missing private request owner fails closed even when an unexpected Room lane is supplied", () => {
  startEventBridge();
  const member = client("room-member");
  try {
    for (const ownerId of [undefined, ""]) {
      eventBus.emit({ type: "task.external_request.changed", ownerId, requestId: "request", taskId: "task", taskRunId: "run",
        jobId: "job", roomId: "shared-room", state: "available", laneKey: "room:shared-room" } as unknown as ServerEvent);
      expect(member.sent).toHaveLength(0);
    }
  } finally { member.close(); }
});
