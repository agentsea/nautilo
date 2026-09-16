import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { ReactNode } from "react";
import type {
  ImportantMessageArrivedEvent,
  NotificationStateResponse,
  RoomNotificationChangedEvent,
} from "@nautilo/types";

const PARENT = "room-parent";
const CHILD = "room-child";
let viewerGeneration = 1;
let sessionUserId = "user-1";
let wsState: "closed" | "open" = "open";
let runtimeListener:
  | ((
      event: RoomNotificationChangedEvent | ImportantMessageArrivedEvent,
    ) => void)
  | null = null;
let invalidationHandler: (() => void) | null = null;
let navigationHandler:
  | ((target: {
      topLevelRoomId: string;
      subthreadRoomId?: string;
  }) => void)
  | null = null;
let activeSessionHandler:
  | ((state: { active: boolean }) => void)
  | null = null;

function snapshot(unreadCount = 2): NotificationStateResponse {
  return {
    generatedAt: "2026-08-03T12:00:00.000Z",
    preferences: { defaultLevel: "direct", roomOverrides: [] },
    totals: { unreadCount, importantUnreadCount: 1 },
    rooms: [
      {
        roomId: PARENT,
        ownUnreadCount: 1,
        ownImportantUnreadCount: 0,
        subthreadUnreadCount: unreadCount - 1,
        subthreadImportantUnreadCount: 1,
        unreadCount,
        importantUnreadCount: 1,
      },
    ],
    subthreads: [
      {
        roomId: CHILD,
        parentRoomId: PARENT,
        anchorMessageId: 42,
        replyCount: 2,
        unreadCount: unreadCount - 1,
        importantUnreadCount: 1,
      },
    ],
  };
}

const getNotificationState = mock(async () => snapshot());
const setDefaultNotificationLevel = mock(async () => {
  invalidationHandler?.();
});
const setRoomNotificationPreference = mock(async () => {
  invalidationHandler?.();
});
const showImportantMessage = mock(async () => {});
const publishSummary = mock(async () => {});
const navigate = mock(async () => {});
const drawerOpen = mock(() => {});
const drawerClose = mock(() => {});

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getNotificationState,
    setDefaultNotificationLevel,
    setRoomNotificationPreference,
    setNotificationStateInvalidationHandler(
      handler: (() => void) | null,
    ) {
      invalidationHandler = handler;
    },
  },
}));
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: true,
      sessionUserId,
      sessionActorId: "actor-1",
    },
    viewerGeneration,
  }),
}));
mock.module("../../src/lib/desktop", () => ({
  desktopAPI: {
    activeSession: {
      onStateChange(handler: NonNullable<typeof activeSessionHandler>) {
        activeSessionHandler = handler;
        handler({ active: true });
        return () => {
          activeSessionHandler = null;
        };
      },
    },
    notifications: {
      showImportantMessage,
      publishSummary,
      onNavigate(
        handler: NonNullable<typeof navigationHandler>,
      ) {
        navigationHandler = handler;
        return () => {
          navigationHandler = null;
        };
      },
    },
  },
}));
mock.module("react-router-dom", () => ({
  useNavigate: () => navigate,
}));
mock.module("../../src/modes/rooms/thread-drawer/drawer-state", () => ({
  useDrawer: () => ({
    current: { kind: "closed" },
    open: drawerOpen,
    close: drawerClose,
    swapTo: mock(() => {}),
  }),
}));
mock.module("../../src/adapters/runtime-contexts", () => ({
  useWsStateContext: () => ({ state: wsState, lastOpenAt: null }),
  useNotificationRuntimeEventSource: () => ({
    subscribe(
      listener: (
        event: RoomNotificationChangedEvent | ImportantMessageArrivedEvent,
      ) => void,
    ) {
      runtimeListener = listener;
      return () => {
        runtimeListener = null;
      };
    },
  }),
}));

let NotificationStateProvider:
  typeof import("../../src/notifications/notification-state-context").NotificationStateProvider;
let useNotificationState:
  typeof import("../../src/notifications/notification-state-context").useNotificationState;

beforeAll(async () => {
  ({
    NotificationStateProvider,
    useNotificationState,
  } = await import("../../src/notifications/notification-state-context"));
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  viewerGeneration = 1;
  sessionUserId = "user-1";
  wsState = "open";
  runtimeListener = null;
  invalidationHandler = null;
  navigationHandler = null;
  activeSessionHandler = null;
  getNotificationState.mockReset();
  getNotificationState.mockImplementation(async () => snapshot());
  setDefaultNotificationLevel.mockReset();
  setDefaultNotificationLevel.mockImplementation(async () => {
    invalidationHandler?.();
  });
  setRoomNotificationPreference.mockReset();
  setRoomNotificationPreference.mockImplementation(async () => {
    invalidationHandler?.();
  });
  showImportantMessage.mockReset();
  showImportantMessage.mockImplementation(async () => {});
  publishSummary.mockReset();
  publishSummary.mockImplementation(async () => {});
  navigate.mockReset();
  navigate.mockImplementation(async () => {});
  drawerOpen.mockReset();
  drawerClose.mockReset();
});

afterAll(() => {
  mock.restore();
  reapplyHappyDomGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  return <NotificationStateProvider>{children}</NotificationStateProvider>;
}

describe("M236 Workbench notification provider lifecycle", () => {
  test("hydrates, applies a private live patch, and refreshes on mutation invalidation", async () => {
    const { result } = renderHook(() => useNotificationState(), { wrapper });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(getNotificationState).toHaveBeenCalledTimes(1);

    act(() => {
      runtimeListener?.({
        type: "room.notification.changed",
        userId: sessionUserId,
        roomId: CHILD,
        topLevelRoomId: PARENT,
        roomOwnUnreadCount: 3,
        roomOwnImportantUnreadCount: 2,
        topLevelUnreadCount: 4,
        topLevelImportantUnreadCount: 2,
      });
    });
    expect(result.current.snapshot?.totals).toEqual({
      unreadCount: 4,
      importantUnreadCount: 2,
    });
    expect(showImportantMessage).not.toHaveBeenCalled();

    act(() => {
      runtimeListener?.({
        type: "notification.message.important",
        userId: sessionUserId,
        messageId: "message-1",
        roomId: CHILD,
        topLevelRoomId: PARENT,
        senderActorId: "actor-2",
        senderDisplayName: "Maya",
        roomLabel: "Thread",
        parentRoomLabel: "Household",
        occurredAt: "2026-08-03T12:01:00.000Z",
      });
    });
    expect(showImportantMessage).toHaveBeenCalledTimes(1);
    expect(showImportantMessage).toHaveBeenCalledWith({
      messageId: "message-1",
      senderDisplayName: "Maya",
      roomId: CHILD,
      topLevelRoomId: PARENT,
      roomLabel: "Thread",
      parentRoomLabel: "Household",
    });
    expect(publishSummary).toHaveBeenCalledWith(expect.objectContaining({
      generatedAt: "2026-08-03T12:00:00.000Z",
      unreadCount: 4,
      importantUnreadCount: 2,
    }));

    act(() => invalidationHandler?.());
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(2));

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(3));
  });

  test("reconciles every minute while authenticated and connected", async () => {
    const realSetInterval = window.setInterval;
    const realClearInterval = window.clearInterval;
    let scheduled: (() => void) | null = null;
    let clearedTimer: number | undefined;
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(60_000);
      scheduled = handler as () => void;
      return 236;
    }) as typeof window.setInterval;
    window.clearInterval = ((timer?: number) => {
      clearedTimer = timer;
    }) as typeof window.clearInterval;

    try {
      const { unmount } = renderHook(() => useNotificationState(), { wrapper });
      await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(1));

      act(() => scheduled?.());
      await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(2));

      unmount();
      expect(clearedTimer).toBe(236);
    } finally {
      window.setInterval = realSetInterval;
      window.clearInterval = realClearInterval;
    }
  });

  test("publishes summaries while preserved in background and reconciles on reactivation", async () => {
    renderHook(() => useNotificationState(), { wrapper });
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(publishSummary).toHaveBeenCalledWith(expect.objectContaining({
        unreadCount: 2,
        importantUnreadCount: 1,
      })),
    );

    publishSummary.mockClear();
    act(() => activeSessionHandler?.({ active: false }));
    act(() => {
      runtimeListener?.({
        type: "room.notification.changed",
        userId: sessionUserId,
        roomId: CHILD,
        topLevelRoomId: PARENT,
        roomOwnUnreadCount: 3,
        roomOwnImportantUnreadCount: 2,
        topLevelUnreadCount: 4,
        topLevelImportantUnreadCount: 2,
      });
    });
    expect(publishSummary).toHaveBeenCalledWith(expect.objectContaining({
      unreadCount: 4,
      importantUnreadCount: 2,
    }));

    publishSummary.mockClear();
    act(() => activeSessionHandler?.({ active: true }));
    await waitFor(() => {
      expect(getNotificationState).toHaveBeenCalledTimes(2);
      expect(publishSummary).toHaveBeenCalledWith(expect.objectContaining({
        unreadCount: 2,
        importantUnreadCount: 1,
      }));
    });
  });

  test("keeps the last snapshot stale on refresh failure and clears it on viewer switch", async () => {
    const { result, rerender } = renderHook(() => useNotificationState(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    getNotificationState.mockImplementationOnce(async () => {
      throw new Error("refresh failed");
    });

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.error).toBe("refresh failed");
    expect(result.current.snapshot).not.toBeNull();

    publishSummary.mockClear();
    viewerGeneration = 2;
    sessionUserId = "user-2";
    wsState = "closed";
    rerender();
    await waitFor(() => expect(result.current.snapshot).toBeNull());
    expect(result.current.latestAppliedGeneration).toBe(0);
    expect(publishSummary).not.toHaveBeenCalled();

    getNotificationState.mockImplementationOnce(async () => snapshot(5));
    wsState = "open";
    rerender();
    await waitFor(() =>
      expect(result.current.snapshot?.totals.unreadCount).toBe(5),
    );
  });

  test("bounds preference mutations and reconciles only after success", async () => {
    let resolveDefault: (() => void) | null = null;
    setDefaultNotificationLevel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDefault = resolve;
        }).then(() => invalidationHandler?.()),
    );
    const { result } = renderHook(() => useNotificationState(), { wrapper });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = result.current.setDefaultNotificationLevel("all");
      duplicate = result.current.setDefaultNotificationLevel("none");
    });
    expect(setDefaultNotificationLevel).toHaveBeenCalledTimes(1);
    expect(await duplicate).toBe(false);
    expect(result.current.defaultPreferenceMutation.busy).toBe(true);
    act(() => resolveDefault?.());
    expect(await first).toBe(true);
    await waitFor(() =>
      expect(result.current.defaultPreferenceMutation.busy).toBe(false),
    );
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(2));

    setRoomNotificationPreference.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      expect(
        await result.current.setRoomNotificationPreference(PARENT, "none"),
      ).toBe(false);
    });
    expect(
      result.current.roomPreferenceMutations.get(PARENT)?.error,
    ).toBe("offline");
    expect(result.current.snapshot?.preferences.defaultLevel).toBe("direct");
  });

  test("routes native clicks to a top-level Room or exact eligible Subthread", async () => {
    const { result } = renderHook(() => useNotificationState(), { wrapper });
    await waitFor(() => expect(navigationHandler).not.toBeNull());
    await waitFor(() => expect(result.current.snapshot?.subthreads).toHaveLength(1));

    act(() => navigationHandler?.({ topLevelRoomId: PARENT }));
    expect(drawerClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith(`/rooms/${PARENT}`);
    expect(drawerOpen).not.toHaveBeenCalled();

    act(() =>
      navigationHandler?.({
        topLevelRoomId: PARENT,
        subthreadRoomId: CHILD,
      }),
    );
    expect(drawerOpen).toHaveBeenLastCalledWith({
      kind: "thread",
      parentRoomId: PARENT,
      subthreadRoomId: CHILD,
      anchorMessageId: 42,
    });
  });

  test("reconciles a missing child once and falls back safely to its parent", async () => {
    getNotificationState
      .mockImplementationOnce(async () => ({
        ...snapshot(),
        subthreads: [],
      }))
      .mockImplementationOnce(async () => snapshot());
    renderHook(() => useNotificationState(), { wrapper });
    await waitFor(() => expect(navigationHandler).not.toBeNull());
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(1));

    act(() =>
      navigationHandler?.({
        topLevelRoomId: PARENT,
        subthreadRoomId: CHILD,
      }),
    );
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(drawerOpen).toHaveBeenCalledWith({
        kind: "thread",
        parentRoomId: PARENT,
        subthreadRoomId: CHILD,
        anchorMessageId: 42,
      }),
    );

    getNotificationState.mockImplementationOnce(async () => ({
      ...snapshot(),
      subthreads: [],
    }));
    act(() =>
      navigationHandler?.({
        topLevelRoomId: PARENT,
        subthreadRoomId: "missing-child",
      }),
    );
    await waitFor(() => expect(getNotificationState).toHaveBeenCalledTimes(3));
    expect(drawerClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith(`/rooms/${PARENT}`);
    expect(drawerOpen).toHaveBeenCalledTimes(1);
  });
});
