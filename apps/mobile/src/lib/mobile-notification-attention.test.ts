import { describe, expect, test } from "bun:test";
import type { NotificationStateResponse, RoomNotificationChangedEvent } from "@nautilo/types";

import {
  applyNotificationStateChange,
  notificationAttentionPresentation,
} from "./mobile-notification-attention";

const TOP = "11111111-1111-4111-8111-111111111111";
const SUBTHREAD = "22222222-2222-4222-8222-222222222222";

function snapshot(): NotificationStateResponse {
  return {
    generatedAt: "2026-08-09T00:00:00.000Z",
    preferences: { defaultLevel: "direct", roomOverrides: [] },
    totals: { unreadCount: 5, importantUnreadCount: 2 },
    rooms: [{
      roomId: TOP,
      ownUnreadCount: 2,
      ownImportantUnreadCount: 1,
      subthreadUnreadCount: 3,
      subthreadImportantUnreadCount: 1,
      unreadCount: 5,
      importantUnreadCount: 2,
    }],
    subthreads: [{
      roomId: SUBTHREAD,
      parentRoomId: TOP,
      anchorMessageId: 4,
      replyCount: 3,
      unreadCount: 3,
      importantUnreadCount: 1,
    }],
  };
}

function event(overrides: Partial<RoomNotificationChangedEvent> = {}): RoomNotificationChangedEvent {
  return {
    type: "room.notification.changed",
    userId: "33333333-3333-4333-8333-333333333333",
    roomId: TOP,
    topLevelRoomId: TOP,
    roomOwnUnreadCount: 1,
    roomOwnImportantUnreadCount: 0,
    topLevelUnreadCount: 4,
    topLevelImportantUnreadCount: 1,
    ...overrides,
  };
}

describe("Mobile notification attention", () => {
  test("matches Desktop's ambient, important, capped-count, and spoken semantics", () => {
    expect(notificationAttentionPresentation({ unreadCount: 3, importantUnreadCount: 0, label: "Chats" }))
      .toEqual({ hasUnread: true, importantText: null, accessibilityLabel: "Chats: 3 unread messages, 0 important messages" });
    expect(notificationAttentionPresentation({ unreadCount: 120, importantUnreadCount: 100, label: "Chats" }))
      .toEqual({ hasUnread: true, importantText: "99+", accessibilityLabel: "Chats: 120 unread messages, 100 important messages" });
    expect(notificationAttentionPresentation({ unreadCount: 1, importantUnreadCount: 2, label: "Chats" })).toBeNull();
  });

  test("projects a top-level delta into totals without manufacturing a second count", () => {
    const result = applyNotificationStateChange(snapshot(), event());

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected canonical patch");
    expect(result.snapshot.rooms[0]).toMatchObject({
      ownUnreadCount: 1,
      ownImportantUnreadCount: 0,
      subthreadUnreadCount: 3,
      subthreadImportantUnreadCount: 1,
      unreadCount: 4,
      importantUnreadCount: 1,
    });
    expect(result.snapshot.totals).toEqual({ unreadCount: 4, importantUnreadCount: 1 });
  });

  test("updates a known subthread once through its top-level aggregate", () => {
    const result = applyNotificationStateChange(snapshot(), event({
      roomId: SUBTHREAD,
      roomOwnUnreadCount: 4,
      roomOwnImportantUnreadCount: 2,
      topLevelUnreadCount: 6,
      topLevelImportantUnreadCount: 3,
    }));

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected canonical patch");
    expect(result.snapshot.subthreads[0]).toMatchObject({ unreadCount: 4, importantUnreadCount: 2 });
    expect(result.snapshot.rooms[0]).toMatchObject({
      ownUnreadCount: 2,
      ownImportantUnreadCount: 1,
      subthreadUnreadCount: 4,
      subthreadImportantUnreadCount: 2,
      unreadCount: 6,
      importantUnreadCount: 3,
    });
    expect(result.snapshot.totals).toEqual({ unreadCount: 6, importantUnreadCount: 3 });
  });

  test("requires a refresh for unknown or incoherent canonical deltas", () => {
    expect(applyNotificationStateChange(snapshot(), event({ roomId: SUBTHREAD, topLevelRoomId: "missing" }))).toEqual({ kind: "dirty" });
    expect(applyNotificationStateChange(snapshot(), event({ roomOwnImportantUnreadCount: 5, roomOwnUnreadCount: 1 }))).toEqual({ kind: "dirty" });
  });
});
