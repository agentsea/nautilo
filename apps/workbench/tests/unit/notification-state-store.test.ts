import { describe, expect, mock, test } from "bun:test";
import type { NotificationStateResponse } from "@nautilo/types";
import {
  applyNotificationStateChange,
  createNotificationRefreshCoordinator,
} from "../../src/notifications/notification-state-store";

const USER = "user-1";
const PARENT = "room-parent";
const CHILD = "room-child";

function snapshot(generatedAt = "2026-08-03T12:00:00.000Z"): NotificationStateResponse {
  return {
    generatedAt,
    preferences: { defaultLevel: "direct", roomOverrides: [] },
    totals: { unreadCount: 7, importantUnreadCount: 3 },
    rooms: [
      {
        roomId: PARENT,
        ownUnreadCount: 3,
        ownImportantUnreadCount: 1,
        subthreadUnreadCount: 2,
        subthreadImportantUnreadCount: 1,
        unreadCount: 5,
        importantUnreadCount: 2,
      },
      {
        roomId: "other",
        ownUnreadCount: 2,
        ownImportantUnreadCount: 1,
        subthreadUnreadCount: 0,
        subthreadImportantUnreadCount: 0,
        unreadCount: 2,
        importantUnreadCount: 1,
      },
    ],
    subthreads: [
      {
        roomId: CHILD,
        parentRoomId: PARENT,
        anchorMessageId: 42,
        replyCount: 4,
        unreadCount: 2,
        importantUnreadCount: 1,
      },
    ],
  };
}

describe("M236 Workbench notification state", () => {
  test("patches child own counts, parent aggregate, and global delta", () => {
    const result = applyNotificationStateChange(snapshot(), {
      type: "room.notification.changed",
      userId: USER,
      roomId: CHILD,
      topLevelRoomId: PARENT,
      roomOwnUnreadCount: 4,
      roomOwnImportantUnreadCount: 3,
      topLevelUnreadCount: 7,
      topLevelImportantUnreadCount: 4,
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied patch");
    expect(result.snapshot.subthreads[0]).toMatchObject({
      unreadCount: 4,
      importantUnreadCount: 3,
    });
    expect(result.snapshot.rooms[0]).toMatchObject({
      ownUnreadCount: 3,
      subthreadUnreadCount: 4,
      unreadCount: 7,
      importantUnreadCount: 4,
    });
    expect(result.snapshot.totals).toEqual({
      unreadCount: 9,
      importantUnreadCount: 5,
    });
  });

  test("marks unknown and invalid events dirty instead of inventing state", () => {
    expect(
      applyNotificationStateChange(snapshot(), {
        type: "room.notification.changed",
        userId: USER,
        roomId: "unknown-child",
        topLevelRoomId: PARENT,
        roomOwnUnreadCount: 1,
        roomOwnImportantUnreadCount: 1,
        topLevelUnreadCount: 6,
        topLevelImportantUnreadCount: 3,
      }).kind,
    ).toBe("dirty");
    expect(
      applyNotificationStateChange(snapshot(), {
        type: "room.notification.changed",
        userId: USER,
        roomId: PARENT,
        topLevelRoomId: PARENT,
        roomOwnUnreadCount: 1,
        roomOwnImportantUnreadCount: 2,
        topLevelUnreadCount: 1,
        topLevelImportantUnreadCount: 1,
      }).kind,
    ).toBe("dirty");
  });

  test("keeps refresh single-flight and supersedes an older response", async () => {
    let resolveFirst!: (value: NotificationStateResponse) => void;
    let resolveSecond!: (value: NotificationStateResponse) => void;
    const first = new Promise<NotificationStateResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<NotificationStateResponse>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchState = mock()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const onApply = mock(() => {});
    const onRefreshing = mock(() => {});
    const coordinator = createNotificationRefreshCoordinator({
      fetchState,
      onApply,
      onError: mock(() => {}),
      onRefreshing,
    });
    coordinator.reset("server-a:user-a");

    coordinator.request();
    coordinator.request();
    expect(fetchState).toHaveBeenCalledTimes(1);

    resolveFirst(snapshot("2026-08-03T12:00:00.000Z"));
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(onApply).not.toHaveBeenCalled();
    expect(fetchState).toHaveBeenCalledTimes(2);

    const newest = snapshot("2026-08-03T12:01:00.000Z");
    resolveSecond(newest);
    await second;
    await Promise.resolve();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toEqual(newest);
    expect(onRefreshing.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  test("invalidates an in-flight response on server-session reset", async () => {
    let resolve!: (value: NotificationStateResponse) => void;
    const pending = new Promise<NotificationStateResponse>((done) => {
      resolve = done;
    });
    const onApply = mock(() => {});
    const coordinator = createNotificationRefreshCoordinator({
      fetchState: () => pending,
      onApply,
      onError: mock(() => {}),
      onRefreshing: mock(() => {}),
    });
    coordinator.reset("server-a:user-a");
    coordinator.request();
    coordinator.reset("server-b:user-a");
    resolve(snapshot());
    await pending;
    await Promise.resolve();
    expect(onApply).not.toHaveBeenCalled();
  });
});
