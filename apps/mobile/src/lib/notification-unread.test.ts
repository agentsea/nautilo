import { describe, expect, test } from "bun:test";
import type {
  RoomNotificationChangedEvent,
  RoomSummaryDto,
} from "@nautilo/types";
import { applyNotificationUnread } from "./notification-unread";

const TOP_LEVEL_ID = "11111111-1111-4111-8111-111111111111";
const SUBTHREAD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

function event(
  overrides: Partial<RoomNotificationChangedEvent> = {},
): RoomNotificationChangedEvent {
  return {
    type: "room.notification.changed",
    userId: USER_ID,
    roomId: TOP_LEVEL_ID,
    topLevelRoomId: TOP_LEVEL_ID,
    roomOwnUnreadCount: 2,
    roomOwnImportantUnreadCount: 1,
    topLevelUnreadCount: 2,
    topLevelImportantUnreadCount: 1,
    ...overrides,
  };
}

function rooms(unreadCount = 0): RoomSummaryDto[] {
  return [{
    id: TOP_LEVEL_ID,
    label: "Test group",
    type: "group",
    graphThreadId: TOP_LEVEL_ID,
    createdAt: "2026-08-09T00:00:00.000Z",
    memberCount: 2,
    kind: "group",
    unreadCount,
  }];
}

describe("Mobile canonical notification unread projection", () => {
  test("patches the existing top-level row's own unread count", () => {
    const current = rooms();
    const result = applyNotificationUnread(current, event());

    expect(result.kind).toBe("patched");
    expect(result.rooms).not.toBe(current);
    expect(result.rooms[0]?.unreadCount).toBe(2);
  });

  test("ignores subthread events because they do not own chat-list rows", () => {
    const current = rooms();
    const result = applyNotificationUnread(current, event({
      roomId: SUBTHREAD_ID,
      roomOwnUnreadCount: 4,
      topLevelUnreadCount: 4,
    }));

    expect(result).toEqual({ kind: "unchanged", rooms: current });
  });

  test("requests reconciliation only for an unknown positive top-level room", () => {
    const current: RoomSummaryDto[] = [];

    expect(applyNotificationUnread(current, event()).kind).toBe(
      "unknown-positive",
    );
    expect(
      applyNotificationUnread(
        current,
        event({
          roomOwnUnreadCount: 0,
          roomOwnImportantUnreadCount: 0,
          topLevelUnreadCount: 0,
          topLevelImportantUnreadCount: 0,
        }),
      ).kind,
    ).toBe("unchanged");
  });
});
