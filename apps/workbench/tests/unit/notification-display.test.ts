import { describe, expect, test } from "bun:test";
import type { NotificationStateResponse } from "@nautilo/types";
import {
  buildSubthreadsByAnchor,
  formatCompactNotificationCount,
  notificationAttentionPresentation,
  notificationLevelLabel,
  subthreadAnchorKey,
} from "../../src/notifications/notification-display";

describe("M238 notification display semantics", () => {
  test.each([
    [0, "0"],
    [1, "1"],
    [99, "99"],
    [100, "99+"],
    [10_000, "99+"],
    [-1, null],
    [1.5, null],
    [Number.NaN, null],
  ])("formats %p as %p", (value, expected) => {
    expect(formatCompactNotificationCount(value)).toBe(expected);
  });

  test("distinguishes zero, ambient-only, and important attention", () => {
    expect(
      notificationAttentionPresentation({
        unreadCount: 0,
        importantUnreadCount: 0,
        label: "Rooms",
      }),
    ).toEqual({
      hasUnread: false,
      importantText: null,
      ariaLabel: "Rooms: 0 unread messages, 0 important messages",
    });
    expect(
      notificationAttentionPresentation({
        unreadCount: 3,
        importantUnreadCount: 0,
        label: "Kitchen",
      }),
    ).toEqual({
      hasUnread: true,
      importantText: null,
      ariaLabel: "Kitchen: 3 unread messages, 0 important messages",
    });
    expect(
      notificationAttentionPresentation({
        unreadCount: 120,
        importantUnreadCount: 100,
        label: "Kitchen",
      }),
    ).toEqual({
      hasUnread: true,
      importantText: "99+",
      ariaLabel: "Kitchen: 120 unread messages, 100 important messages",
    });
  });

  test("rejects impossible or invalid count pairs", () => {
    expect(
      notificationAttentionPresentation({
        unreadCount: 1,
        importantUnreadCount: 2,
        label: "Room",
      }),
    ).toBeNull();
    expect(
      notificationAttentionPresentation({
        unreadCount: Number.NaN,
        importantUnreadCount: 0,
        label: "Room",
      }),
    ).toBeNull();
  });

  test("uses the locked preference labels", () => {
    expect(notificationLevelLabel("none")).toBe("Nothing");
    expect(notificationLevelLabel("direct")).toBe("Directed messages");
    expect(notificationLevelLabel("all")).toBe("All messages");
  });

  test("indexes eligible Subthreads by parent and anchor", () => {
    const snapshot = {
      subthreads: [
        {
          roomId: "child",
          parentRoomId: "parent",
          anchorMessageId: 42,
          replyCount: 3,
          unreadCount: 2,
          importantUnreadCount: 1,
        },
      ],
    } as NotificationStateResponse;
    const index = buildSubthreadsByAnchor(snapshot);
    expect(index.get(subthreadAnchorKey("parent", 42))?.roomId).toBe(
      "child",
    );
    expect(index.get(subthreadAnchorKey("parent", 41))).toBeUndefined();
  });
});
