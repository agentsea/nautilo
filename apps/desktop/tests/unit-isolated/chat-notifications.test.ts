import { describe, expect, mock, test } from "bun:test";
import {
  isMacosAppEffectivelyActive,
  NotificationMessageDeduper,
  pendingNotificationCountForTest,
  redactNativeError,
  showImportantMessage,
  validateImportantMessageInput,
  type ChatNotificationDeps,
  type ImportantMessageInput,
  type NotificationHandle,
} from "../../electron/chat-notifications";

const TOP = "11111111-2222-4333-8444-555555555555";
const CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function message(
  patch: Partial<ImportantMessageInput> = {},
): ImportantMessageInput {
  return {
    messageId: "message-1",
    senderDisplayName: "Maya",
    roomId: TOP,
    topLevelRoomId: TOP,
    roomLabel: "Kitchen",
    ...patch,
  };
}

class FakeNotification implements NotificationHandle {
  showCalls = 0;
  private clickHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private failedHandler: ((error: string) => void) | null = null;

  constructor(
    readonly title: string,
    readonly body: string,
    private readonly showShouldThrow = false,
  ) {}

  show(): void {
    this.showCalls += 1;
    if (this.showShouldThrow) throw new Error("show-failed");
  }
  onClick(handler: () => void): void {
    this.clickHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  onFailed(handler: (error: string) => void): void {
    this.failedHandler = handler;
  }
  click(): void {
    this.clickHandler?.();
  }
  close(): void {
    this.closeHandler?.();
  }
  fail(error: string): void {
    this.failedHandler?.(error);
  }
}

function harness(
  overrides: Partial<ChatNotificationDeps> = {},
): {
  deps: ChatNotificationDeps;
  deduper: NotificationMessageDeduper;
  notifications: FakeNotification[];
  navigate: ReturnType<typeof mock>;
} {
  const deduper = new NotificationMessageDeduper();
  const notifications: FakeNotification[] = [];
  const navigate = mock(() => {});
  const deps: ChatNotificationDeps = {
    platform: () => "darwin",
    isNotificationSupported: () => true,
    isTestEnvironment: () => false,
    isMainWindowAlive: () => true,
    isAppActive: () => false,
    resolveActiveSessionKey: () => "session-a",
    claimMessage: (sessionKey, messageId) =>
      deduper.claim(sessionKey, messageId),
    createNotification: ({ title, body }) => {
      const notification = new FakeNotification(title, body);
      notifications.push(notification);
      return notification;
    },
    logNativeFailure: () => {},
    showMainWindow: () => {},
    focusMainWindow: () => {},
    sendNavigate: navigate,
    ...overrides,
  };
  return { deps, deduper, notifications, navigate };
}

describe("M239 important-message payload validation", () => {
  test("accepts exact top-level and child shapes", () => {
    expect(validateImportantMessageInput(message())).toEqual({
      messageId: "message-1",
      senderDisplayName: "Maya",
      roomId: TOP,
      topLevelRoomId: TOP,
      roomLabel: "Kitchen",
      navigationTarget: { topLevelRoomId: TOP },
    });
    expect(
      validateImportantMessageInput(
        message({
          roomId: CHILD,
          roomLabel: "Lunch plans",
          parentRoomLabel: "Kitchen",
        }),
      ),
    ).toEqual({
      messageId: "message-1",
      senderDisplayName: "Maya",
      roomId: CHILD,
      topLevelRoomId: TOP,
      roomLabel: "Lunch plans",
      parentRoomLabel: "Kitchen",
      navigationTarget: {
        topLevelRoomId: TOP,
        subthreadRoomId: CHILD,
      },
    });
  });

  test("uses fixed fallbacks for empty display metadata", () => {
    expect(
      validateImportantMessageInput(
        message({
          senderDisplayName: " ",
          roomId: CHILD,
          roomLabel: "",
          parentRoomLabel: " ",
        }),
      ),
    ).toMatchObject({
      senderDisplayName: "Nautilo",
      roomLabel: "a thread",
      parentRoomLabel: "a room",
    });
  });

  test("rejects extra fields, malformed relationships, controls, and oversized labels", () => {
    expect(
      validateImportantMessageInput({
        ...message(),
        body: "secret preview",
      } as ImportantMessageInput),
    ).toBeNull();
    expect(
      validateImportantMessageInput(
        message({ parentRoomLabel: "not valid on a top-level arrival" }),
      ),
    ).toBeNull();
    expect(
      validateImportantMessageInput(
        message({ roomId: CHILD, parentRoomLabel: undefined }),
      ),
    ).toBeNull();
    expect(
      validateImportantMessageInput(message({ messageId: "bad\nid" })),
    ).toBeNull();
    expect(
      validateImportantMessageInput(message({ roomLabel: "bad\u0085label" })),
    ).toBeNull();
    expect(
      validateImportantMessageInput(
        message({ senderDisplayName: "x".repeat(201) }),
      ),
    ).toBeNull();
  });
});

describe("M239 notification message LRU", () => {
  test("is per-session, bounded, and refreshes duplicate recency", () => {
    const deduper = new NotificationMessageDeduper(3);
    expect(deduper.claim("a", "1")).toBe(true);
    expect(deduper.claim("a", "2")).toBe(true);
    expect(deduper.claim("a", "1")).toBe(false);
    expect(deduper.claim("a", "3")).toBe(true);
    expect(deduper.claim("a", "4")).toBe(true);
    expect(deduper.sizeForTest("a")).toBe(3);
    expect(deduper.claim("a", "2")).toBe(true);
    expect(deduper.claim("b", "1")).toBe(true);
    expect(deduper.claim("b", "1")).toBe(false);
    deduper.retainSessions(new Set(["b"]));
    expect(deduper.sizeForTest("a")).toBe(0);
    deduper.clearSession("b");
    expect(deduper.sizeForTest("b")).toBe(0);
  });
});

describe("M239 important-message delivery policy", () => {
  test("constructs sender-aware top-level copy and trusted click target", () => {
    const { deps, notifications, navigate } = harness();
    expect(showImportantMessage(7, message(), deps)).toEqual({ ok: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "Maya",
      body: "New message in Kitchen",
      showCalls: 1,
    });
    expect(pendingNotificationCountForTest()).toBe(1);
    notifications[0]?.click();
    expect(navigate).toHaveBeenCalledWith(7, "session-a", {
      topLevelRoomId: TOP,
    });
    expect(pendingNotificationCountForTest()).toBe(0);
    notifications[0]?.close();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("constructs preview-free child copy and exact structured target", () => {
    const { deps, notifications, navigate } = harness();
    expect(
      showImportantMessage(
        7,
        message({
          roomId: CHILD,
          roomLabel: "Lunch plans",
          parentRoomLabel: "Kitchen",
        }),
        deps,
      ),
    ).toEqual({ ok: true });
    expect(notifications[0]).toMatchObject({
      title: "Maya",
      body: "New reply in Lunch plans, Kitchen",
    });
    notifications[0]?.click();
    expect(navigate).toHaveBeenCalledWith(7, "session-a", {
      topLevelRoomId: TOP,
      subthreadRoomId: CHILD,
    });
  });

  test("claims before active/support gates so suppression cannot replay later", () => {
    let active = true;
    const { deps, notifications } = harness({
      isAppActive: () => active,
    });
    expect(showImportantMessage(7, message(), deps)).toEqual({
      ok: false,
      reason: "app-active",
    });
    active = false;
    expect(showImportantMessage(7, message(), deps)).toEqual({
      ok: false,
      reason: "duplicate-message",
    });
    expect(notifications).toHaveLength(0);

    const unsupported = harness({
      isNotificationSupported: () => false,
    });
    expect(showImportantMessage(7, message(), unsupported.deps)).toEqual({
      ok: false,
      reason: "unsupported-api",
    });
    expect(showImportantMessage(7, message(), unsupported.deps)).toEqual({
      ok: false,
      reason: "duplicate-message",
    });
  });

  test("rejects inactive senders before claiming or native work", () => {
    const claimMessage = mock(() => true);
    const { deps, notifications } = harness({
      resolveActiveSessionKey: () => null,
      claimMessage,
    });
    expect(showImportantMessage(7, message(), deps)).toEqual({
      ok: false,
      reason: "inactive-sender",
    });
    expect(claimMessage).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  test("stale clicks, native failures, and thrown show settle safely", () => {
    let sessionKey: string | null = "session-a";
    const nativeFailure = mock(() => {});
    const first = harness({
      resolveActiveSessionKey: () => sessionKey,
      logNativeFailure: nativeFailure,
    });
    expect(showImportantMessage(7, message(), first.deps)).toEqual({ ok: true });
    sessionKey = "session-b";
    first.notifications[0]?.click();
    expect(first.navigate).not.toHaveBeenCalled();

    const second = harness({ logNativeFailure: nativeFailure });
    expect(
      showImportantMessage(7, message({ messageId: "message-2" }), second.deps),
    ).toEqual({ ok: true });
    second.notifications[0]?.fail("denied\nby macOS");
    expect(nativeFailure).toHaveBeenLastCalledWith("denied by macOS");
    expect(pendingNotificationCountForTest()).toBe(0);

    const thrown = harness({
      createNotification: ({ title, body }) =>
        new FakeNotification(title, body, true),
    });
    expect(
      showImportantMessage(7, message({ messageId: "message-3" }), thrown.deps),
    ).toEqual({ ok: false, reason: "show-failed" });
    expect(pendingNotificationCountForTest()).toBe(0);
  });

  test("distinct messages are never burst-coalesced", () => {
    const { deps, notifications } = harness();
    expect(showImportantMessage(7, message({ messageId: "1" }), deps)).toEqual({
      ok: true,
    });
    expect(showImportantMessage(7, message({ messageId: "2" }), deps)).toEqual({
      ok: true,
    });
    expect(notifications).toHaveLength(2);
    notifications.forEach((notification) => notification.close());
  });
});

test("macOS activity and native error helpers remain bounded", () => {
  expect(
    isMacosAppEffectivelyActive({
      eventStateActive: true,
      hasFocusedAppWindow: true,
    }),
  ).toBe(true);
  expect(
    isMacosAppEffectivelyActive({
      eventStateActive: true,
      hasFocusedAppWindow: false,
    }),
  ).toBe(false);
  expect(redactNativeError(` denied\n${"x".repeat(600)}`)).toHaveLength(500);
});
