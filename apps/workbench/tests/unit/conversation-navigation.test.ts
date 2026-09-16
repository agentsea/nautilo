import { describe, expect, test } from "bun:test";
import {
  createConversationNavigationController,
  returnConversationToLatest,
  waitForConversationCommit,
  waitForConversationTarget,
} from "../../src/components/conversation-navigation";

describe("D430 canonical conversation navigation", () => {
  test("default commit scheduler uses and cleans up the browser frame path", async () => {
    const originalRequestFrame = globalThis.requestAnimationFrame;
    const originalCancelFrame = globalThis.cancelAnimationFrame;
    const originalClearTimeout = globalThis.clearTimeout;
    const cancelledFrames: number[] = [];
    const clearedFallbacks: ReturnType<typeof setTimeout>[] = [];
    globalThis.requestAnimationFrame = (callback) => {
      queueMicrotask(() => callback(0));
      return 19;
    };
    globalThis.cancelAnimationFrame = (handle) => cancelledFrames.push(handle);
    globalThis.clearTimeout = ((handle) => {
      clearedFallbacks.push(handle);
      originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const outcome = await Promise.race([
        waitForConversationCommit().then(() => "commit"),
        new Promise<"late">((resolve) => originalRequestFrame
          ? originalRequestFrame(() => resolve("late"))
          : setTimeout(() => resolve("late"), 50)),
      ]);
      expect(outcome).toBe("commit");
      expect(cancelledFrames).toEqual([19]);
      expect(clearedFallbacks).toHaveLength(1);
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
      globalThis.cancelAnimationFrame = originalCancelFrame;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("default commit scheduler reaches its bounded fallback without a frame", async () => {
    const originalRequestFrame = globalThis.requestAnimationFrame;
    const originalCancelFrame = globalThis.cancelAnimationFrame;
    const cancelledFrames: number[] = [];
    globalThis.requestAnimationFrame = () => 23;
    globalThis.cancelAnimationFrame = (handle) => cancelledFrames.push(handle);

    try {
      await waitForConversationCommit();
      expect(cancelledFrames).toEqual([23]);
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
      globalThis.cancelAnimationFrame = originalCancelFrame;
    }
  });

  test("commit wait resolves on a visual frame and clears its fallback", async () => {
    let frameCallback!: FrameRequestCallback;
    let fallbackCallback!: () => void;
    const cancelledFrames: number[] = [];
    const clearedFallbacks: number[] = [];
    const pending = waitForConversationCommit({
      requestFrame: (callback) => {
        frameCallback = callback;
        return 7;
      },
      cancelFrame: (handle) => cancelledFrames.push(handle),
      setFallback: (callback, delayMs) => {
        expect(delayMs).toBe(100);
        fallbackCallback = callback;
        return 11;
      },
      clearFallback: (handle) => clearedFallbacks.push(handle as number),
    });

    frameCallback(0);
    await pending;
    fallbackCallback();

    expect(cancelledFrames).toEqual([7]);
    expect(clearedFallbacks).toEqual([11]);
  });

  test("commit wait falls back when Electron throttles visual frames", async () => {
    let fallbackCallback!: () => void;
    const cancelledFrames: number[] = [];
    const pending = waitForConversationCommit({
      requestFrame: () => 13,
      cancelFrame: (handle) => cancelledFrames.push(handle),
      setFallback: (callback) => {
        fallbackCallback = callback;
        return 17;
      },
      clearFallback: () => {},
    });

    fallbackCallback();
    await pending;

    expect(cancelledFrames).toEqual([13]);
  });

  test("loaded target materializes and completes without history hydration", async () => {
    const calls: string[] = [];
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => true,
      loadHistoryAround: async () => { calls.push("history"); return true; },
      waitForCommit: async () => { calls.push("commit"); },
      scrollAndFocus: async (id, focusTarget) => {
        calls.push(`scroll:${id}:${focusTarget}`);
        return true;
      },
      onState: () => {},
      onCompleted: () => calls.push("complete"),
    });
    await expect(controller.jumpToMessage(7)).resolves.toEqual({ status: "completed", loaded: true });
    expect(calls).toEqual(["commit", "scroll:7:true", "complete"]);
  });

  test("search navigation scrolls without stealing focus from the query field", async () => {
    const focusModes: boolean[] = [];
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => true,
      loadHistoryAround: async () => true,
      waitForCommit: async () => {},
      scrollAndFocus: async (_id, focusTarget) => {
        focusModes.push(focusTarget);
        return true;
      },
      onState: () => {},
      onCompleted: () => {},
    });

    await expect(controller.jumpToMessage(7, { focusTarget: false })).resolves.toEqual({
      status: "completed",
      loaded: true,
    });
    expect(focusModes).toEqual([false]);
  });

  test("awaits an asynchronous virtual landing without reasserting the target", async () => {
    let materializations = 0;
    let scrollAttempts = 0;
    const completed: number[] = [];
    let resolveLanding!: (landed: boolean) => void;
    const landing = new Promise<boolean>((resolve) => { resolveLanding = resolve; });
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => {
        materializations += 1;
        return true;
      },
      loadHistoryAround: async () => true,
      waitForCommit: async () => {},
      scrollAndFocus: () => {
        scrollAttempts += 1;
        return landing;
      },
      onState: () => {},
      onCompleted: (id) => completed.push(id),
    });

    const jump = controller.jumpToMessage(7, { focusTarget: false });
    await Promise.resolve();
    expect(completed).toEqual([]);
    resolveLanding(true);
    await expect(jump).resolves.toEqual({
      status: "completed",
      loaded: true,
    });
    expect(materializations).toBe(1);
    expect(scrollAttempts).toBe(1);
    expect(completed).toEqual([7]);
  });

  test("target waiter resolves from one DOM signal and clears its fallback", async () => {
    const target = { id: "7" };
    let mounted: typeof target | null = null;
    let notify!: () => void;
    let fallback!: () => void;
    let unsubscribed = 0;
    let cleared = 0;
    const waiting = waitForConversationTarget({
      findTarget: () => mounted,
      subscribe: (listener) => {
        notify = listener;
        return () => { unsubscribed += 1; };
      },
      setFallback: (callback, delayMs) => {
        expect(delayMs).toBe(1500);
        fallback = callback;
        return 31;
      },
      clearFallback: () => { cleared += 1; },
    });

    mounted = target;
    notify();
    expect(await waiting).toBe(target);
    fallback();
    expect(unsubscribed).toBe(1);
    expect(cleared).toBe(1);
  });

  test("target waiter bounds a genuinely missing row and unsubscribes", async () => {
    let fallback!: () => void;
    let unsubscribed = 0;
    let cleared = 0;
    const waiting = waitForConversationTarget({
      findTarget: () => null,
      subscribe: () => () => { unsubscribed += 1; },
      setFallback: (callback) => {
        fallback = callback;
        return 37;
      },
      clearFallback: () => { cleared += 1; },
      timeoutMs: 25,
    });

    fallback();
    expect(await waiting).toBeNull();
    expect(unsubscribed).toBe(1);
    expect(cleared).toBe(1);
  });

  test("does not report completion or highlight when a virtual target never reaches the DOM", async () => {
    const completed: number[] = [];
    const states: unknown[] = [];
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => true,
      loadHistoryAround: async () => true,
      waitForCommit: async () => {},
      scrollAndFocus: async () => false,
      onState: (state) => states.push(state),
      onCompleted: (id) => completed.push(id),
    });

    await expect(controller.jumpToMessage(7, { focusTarget: false })).resolves.toEqual({
      status: "not-found",
    });
    expect(completed).toEqual([]);
    expect(states.at(-1)).toEqual({ state: "error", messageId: 7, reason: "not-found" });
  });

  test("unloaded target hydrates once then materializes once more", async () => {
    let materializations = 0;
    let historyCalls = 0;
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => ++materializations === 2,
      loadHistoryAround: async () => { historyCalls += 1; return true; },
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: () => {},
      onCompleted: () => {},
    });
    await expect(controller.jumpToMessage(7)).resolves.toEqual({ status: "completed", loaded: false });
    expect(historyCalls).toBe(1);
    expect(materializations).toBe(2);
  });

  test("a superseding navigation cannot scroll or highlight after hydration", async () => {
    let room = "room-a";
    let resolveHydration!: (value: boolean) => void;
    const hydration = new Promise<boolean>((resolve) => { resolveHydration = resolve; });
    const completed: number[] = [];
    const controller = createConversationNavigationController({
      getActiveRoomId: () => room,
      materializeById: () => false,
      loadHistoryAround: () => hydration,
      waitForCommit: async () => {},
      scrollAndFocus: async () => {
        completed.push(-1);
        return true;
      },
      onState: () => {},
      onCompleted: (id) => completed.push(id),
    });
    const jump = controller.jumpToMessage(7);
    room = "room-b";
    resolveHydration(true);
    await expect(jump).resolves.toEqual({ status: "superseded" });
    expect(completed).toEqual([]);
  });

  test("a newer jump supersedes an older pending jump", async () => {
    let resolveHydration!: (value: boolean) => void;
    const hydration = new Promise<boolean>((resolve) => { resolveHydration = resolve; });
    const completed: number[] = [];
    let materializations = 0;
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => ++materializations > 1,
      loadHistoryAround: () => hydration,
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: () => {},
      onCompleted: (id) => completed.push(id),
    });
    const oldJump = controller.jumpToMessage(7);
    await expect(controller.jumpToMessage(8)).resolves.toEqual({ status: "completed", loaded: true });
    resolveHydration(true);
    await expect(oldJump).resolves.toEqual({ status: "superseded" });
    expect(completed).toEqual([8]);
  });

  test("failed hydration surfaces a typed error without retrying", async () => {
    let materializations = 0;
    let historyCalls = 0;
    const states: unknown[] = [];
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => { materializations += 1; return false; },
      loadHistoryAround: async () => { historyCalls += 1; return false; },
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: (state) => states.push(state),
      onCompleted: () => {},
    });
    await expect(controller.jumpToMessage(7)).resolves.toEqual({ status: "failed" });
    expect(historyCalls).toBe(1);
    expect(materializations).toBe(1);
    expect(states.at(-1)).toEqual({ state: "error", messageId: 7, reason: "failed" });
  });

  test("a hydrated page missing its target reports not-found without a second request", async () => {
    let materializations = 0;
    let historyCalls = 0;
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => { materializations += 1; return false; },
      loadHistoryAround: async () => { historyCalls += 1; return true; },
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: () => {},
      onCompleted: () => {},
    });
    await expect(controller.jumpToMessage(7)).resolves.toEqual({ status: "not-found" });
    expect(historyCalls).toBe(1);
    expect(materializations).toBe(2);
  });

  test("returning to latest supersedes, follows tail once, clears, then schedules scroll", () => {
    const order: string[] = [];
    returnConversationToLatest({
      supersede: () => order.push("supersede"),
      followTail: () => order.push("followTail"),
      clearNavigation: () => order.push("clear"),
      scheduleTailScroll: () => order.push("schedule"),
    });
    expect(order).toEqual(["supersede", "followTail", "clear", "schedule"]);
    expect(order.filter((entry) => entry === "followTail")).toHaveLength(1);
  });
});
