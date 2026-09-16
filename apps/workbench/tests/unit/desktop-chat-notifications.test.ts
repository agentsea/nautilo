import { describe, expect, test } from "bun:test";
import type { ImportantMessageArrivedEvent } from "@nautilo/types";
import { buildImportantArrivalNotificationRequest } from "../../src/lib/desktop-chat-notifications";

function arrival(
  patch: Partial<ImportantMessageArrivedEvent> = {},
): ImportantMessageArrivedEvent {
  return {
    type: "notification.message.important",
    userId: "user-1",
    messageId: "message-1",
    roomId: "room-1",
    topLevelRoomId: "room-1",
    senderActorId: "actor-2",
    senderDisplayName: "Maya",
    roomLabel: "Kitchen",
    occurredAt: "2026-08-03T12:00:00.000Z",
    ...patch,
  };
}

describe("M239 important-arrival desktop projection", () => {
  test("carries the complete preview-free top-level payload", () => {
    expect(buildImportantArrivalNotificationRequest(arrival())).toEqual({
      messageId: "message-1",
      senderDisplayName: "Maya",
      roomId: "room-1",
      topLevelRoomId: "room-1",
      roomLabel: "Kitchen",
    });
  });

  test("carries exact child and parent identity without changing labels", () => {
    expect(
      buildImportantArrivalNotificationRequest(
        arrival({
          roomId: "child-1",
          topLevelRoomId: "parent-1",
          roomLabel: "Lunch plans",
          parentRoomLabel: "Household",
        }),
      ),
    ).toEqual({
      messageId: "message-1",
      senderDisplayName: "Maya",
      roomId: "child-1",
      topLevelRoomId: "parent-1",
      roomLabel: "Lunch plans",
      parentRoomLabel: "Household",
    });
  });

  test("rejects incomplete identity instead of fabricating a target", () => {
    expect(
      buildImportantArrivalNotificationRequest(
        arrival({ topLevelRoomId: "" }),
      ),
    ).toBeNull();
    expect(
      buildImportantArrivalNotificationRequest(
        arrival({
          roomId: "child-1",
          topLevelRoomId: "parent-1",
          parentRoomLabel: undefined,
        }),
      ),
    ).toBeNull();
  });
});
