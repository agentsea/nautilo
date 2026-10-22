import { afterEach, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import type { WebSocket } from "ws";
import { addClient, audienceForBridgedServerEvent, broadcast } from "../../src/realtime/ws-publisher";

const closeCallbacks: Array<() => void> = [];
afterEach(() => { closeCallbacks.splice(0).forEach(close => close()); });

test("Task definition grants reach only the requester across devices and never shared Room peers", () => {
  const roomId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const requester = "task-grant-requester";
  const register = (userId: string) => {
    const sent: string[] = [];
    addClient({ readyState: 1, OPEN: 1, send: (value: string) => sent.push(value),
      on(_event: string, close: () => void) { closeCallbacks.push(close); } } as unknown as WebSocket,
      { userId, actorId: `actor:${userId}`, roomIds: new Set([roomId]) });
    return sent;
  };
  const firstDevice = register(requester);
  const secondDevice = register(requester);
  const peer = register("task-grant-peer");
  const event = {
    wireVersion: 1,
    type: "message.task_definition_authorization_required",
    userId: requester, roomId, laneKey: `room:${roomId}`,
    parentOperationId: "parent:operation", parentSessionId: "parent:conversation",
    authorizationId: "task:authorization",
    taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", operation: "create",
    targetContentRevision: 1,
    workDescriptorDigestBase64url: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    parentAgentSignerPublicKeyBase64url: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    clientActionSessionId: "client:action", deadlineAt: Date.now() + 30_000,
    authorizationScheme: "runtime_foreground_v1",
    authorizationPlanBytesBase64url: "AA", recipientPublicKeyBase64url: "AA",
  } as const satisfies ServerEvent;
  broadcast(event, audienceForBridgedServerEvent(event));
  expect(firstDevice).toEqual([JSON.stringify(event)]);
  expect(secondDevice).toEqual(firstDevice);
  expect(peer).toEqual([]);
  const malformed = { ...event, userId: "" };
  broadcast(malformed, audienceForBridgedServerEvent(malformed));
  expect(firstDevice).toHaveLength(1);
  expect(secondDevice).toHaveLength(1);
  expect(peer).toEqual([]);
});
