import { describe, expect, mock, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";

let listener: ((event: ServerEvent) => void) | null = null;
const getImportantMessageArrivals = mock(async () => [
  {
    type: "notification.message.important" as const,
    userId: "22222222-2222-4222-8222-222222222222",
    messageId: "42",
    roomId: "11111111-1111-4111-8111-111111111111",
    topLevelRoomId: "11111111-1111-4111-8111-111111111111",
    senderActorId: "33333333-3333-4333-8333-333333333333",
    senderDisplayName: "Sender",
    roomLabel: "Room",
    occurredAt: "2026-08-03T12:00:00.000Z",
  },
]);
const publishImportantMessageArrived = mock(() => {});
const recomputeAndPublishNotificationState = mock(async () => {});

mock.module("@nautilo/runtime", () => ({
  eventBus: {
    on(next: (event: ServerEvent) => void) {
      listener = next;
    },
  },
}));
mock.module("@nautilo/logger", () => ({ warn: () => {} }));
mock.module("@nautilo/trust", () => ({
  getImportantMessageArrivals,
  listHumanUserIdsInRoom: async () => [],
}));
mock.module("../../src/realtime/ws-publisher", () => ({
  audienceForBridgedServerEvent: () => ({ kind: "all" }),
  broadcast: () => {},
  publishImportantMessageArrived,
  recomputeAndPublishNotificationState,
  roomIdFromLaneKey: () => "11111111-1111-4111-8111-111111111111",
}));

const { startEventBridge } = await import("../../src/realtime/event-bridge");

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("M236 canonical important-arrival trigger", () => {
  test("classifies one durable message ID and makes one publish attempt", async () => {
    startEventBridge();
    expect(listener).not.toBeNull();

    listener?.({
      type: "message.new",
      messageId: "42",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
    } as ServerEvent);
    await drainMicrotasks();

    expect(getImportantMessageArrivals).toHaveBeenCalledTimes(1);
    expect(getImportantMessageArrivals).toHaveBeenCalledWith(42);
    expect(publishImportantMessageArrived).toHaveBeenCalledTimes(1);
    expect(publishImportantMessageArrived).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "42" }),
    );
  });

  test("non-arrival events never invoke important classification", async () => {
    startEventBridge();
    getImportantMessageArrivals.mockClear();
    publishImportantMessageArrived.mockClear();

    listener?.({
      type: "room.notification.changed",
      userId: "22222222-2222-4222-8222-222222222222",
      roomId: "11111111-1111-4111-8111-111111111111",
      topLevelRoomId: "11111111-1111-4111-8111-111111111111",
      roomOwnUnreadCount: 1,
      roomOwnImportantUnreadCount: 1,
      topLevelUnreadCount: 1,
      topLevelImportantUnreadCount: 1,
    });
    await drainMicrotasks();

    expect(getImportantMessageArrivals).not.toHaveBeenCalled();
    expect(publishImportantMessageArrived).not.toHaveBeenCalled();
  });

  test("protected arrivals invoke the shared structural classifier and fan out", async () => {
    startEventBridge();
    getImportantMessageArrivals.mockClear();
    publishImportantMessageArrived.mockClear();

    listener?.({
      wireVersion: 2,
      type: "message.new",
      protection: "protected",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      message: {
        dtoVersion: 2,
        projection: {
          messageId: "42",
          sessionId: "22222222-2222-4222-8222-222222222222",
          roomId: "11111111-1111-4111-8111-111111111111",
          namespaceId: "33333333-3333-4333-8333-333333333333",
          role: "assistant",
          createdAt: "2026-08-03T12:00:00.000Z",
          editRevision: 0,
        },
        protectedPayload: {
          status: "pending",
          reason: "shadow_pending",
        },
      },
    });
    await drainMicrotasks();

    expect(getImportantMessageArrivals).toHaveBeenCalledTimes(1);
    expect(getImportantMessageArrivals).toHaveBeenCalledWith(42);
    expect(publishImportantMessageArrived).toHaveBeenCalledTimes(1);
    expect(publishImportantMessageArrived).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "42" }),
    );
  });
});
