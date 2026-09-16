/** Typed outcome shared by quote-reply and the forthcoming Room find bar. */
export type ConversationJumpOutcome =
  | { status: "completed"; loaded: boolean }
  | { status: "not-found" }
  | { status: "failed" }
  | { status: "superseded" };

export type ConversationJumpState =
  | { state: "idle" }
  | { state: "loading"; messageId: number }
  | { state: "error"; messageId: number; reason: "not-found" | "failed" };

export interface ConversationJumpOptions {
  /** Search keeps its query field focused; quote/reply navigation focuses the row. */
  focusTarget?: boolean;
}

export interface ConversationNavigationController {
  jumpToMessage: (messageId: number, options?: ConversationJumpOptions) => Promise<ConversationJumpOutcome>;
  /** Supersedes any jump before the caller follows the transcript tail. */
  supersede: () => void;
}

export interface ConversationCommitScheduler {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  setFallback: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearFallback: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ConversationTargetWaiter<T> {
  findTarget: () => T | null;
  subscribe: (notify: () => void) => () => void;
  setFallback: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearFallback: (handle: ReturnType<typeof setTimeout>) => void;
  timeoutMs?: number;
}

/** Wait for a pinned virtual row to enter the DOM without polling or refetching. */
export function waitForConversationTarget<T>(args: ConversationTargetWaiter<T>): Promise<T | null> {
  const existing = args.findTarget();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (target: T | null): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (fallback !== null) args.clearFallback(fallback);
      resolve(target);
    };
    unsubscribe = args.subscribe(() => {
      const target = args.findTarget();
      if (target) finish(target);
    });
    // Close the subscribe race before arming the bounded fallback.
    const afterSubscribe = args.findTarget();
    if (afterSubscribe) {
      finish(afterSubscribe);
      return;
    }
    fallback = args.setFallback(() => finish(args.findTarget()), args.timeoutMs ?? 1500);
  });
}

/**
 * Wait for React's next visual commit without trusting requestAnimationFrame to
 * run forever. Electron can throttle frame callbacks while its renderer is
 * occluded; the bounded fallback keeps search navigation from remaining stuck
 * in "Opening selected message…".
 */
export function waitForConversationCommit(
  scheduler: ConversationCommitScheduler = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
    clearFallback: (handle) => clearTimeout(handle),
  },
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let frameHandle: number | null = null;
    let fallbackHandle: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (frameHandle !== null) scheduler.cancelFrame(frameHandle);
      if (fallbackHandle !== null) scheduler.clearFallback(fallbackHandle);
      resolve();
    };
    frameHandle = scheduler.requestFrame(finish);
    fallbackHandle = scheduler.setFallback(finish, 100);
  });
}

/**
 * Keep return-to-tail ordering explicit and independently testable. The caller
 * owns React state and the viewport, while this coordinator prevents a pending
 * jump from restoring an old anchor after the user chose the live tail.
 */
export function returnConversationToLatest(args: {
  supersede: () => void;
  followTail: () => void;
  clearNavigation: () => void;
  scheduleTailScroll: () => void;
}): void {
  args.supersede();
  args.followTail();
  args.clearNavigation();
  args.scheduleTailScroll();
}

/**
 * Pure async coordinator. Transcript ownership stays in the runtime and DOM
 * work stays in Conversation; this module only protects the navigation order.
 */
export function createConversationNavigationController(args: {
  getActiveRoomId: () => string | null;
  materializeById: (messageId: string) => boolean;
  loadHistoryAround: (messageId: string) => Promise<boolean>;
  waitForCommit: () => Promise<void>;
  /** Resolves true only when the target row exists and was reached in the DOM. */
  scrollAndFocus: (messageId: string, focusTarget: boolean) => Promise<boolean>;
  onState: (state: ConversationJumpState) => void;
  onCompleted: (messageId: number) => void;
}): ConversationNavigationController {
  let generation = 0;

  const supersede = (): void => {
    generation += 1;
    args.onState({ state: "idle" });
  };

  const jumpToMessage = async (
    messageId: number,
    options: ConversationJumpOptions = {},
  ): Promise<ConversationJumpOutcome> => {
    const roomId = args.getActiveRoomId();
    const requestGeneration = ++generation;
    if (!roomId || !Number.isInteger(messageId) || messageId <= 0) {
      return { status: "superseded" };
    }
    const current = (): boolean =>
      generation === requestGeneration && args.getActiveRoomId() === roomId;
    const fail = (reason: "not-found" | "failed"): ConversationJumpOutcome => {
      if (!current()) return { status: "superseded" };
      args.onState({ state: "error", messageId, reason });
      return { status: reason };
    };
    args.onState({ state: "loading", messageId });

    // The only loaded check is TranscriptWindow's stable-id materializer.
    // A true result skips history hydration entirely.
    const loaded = args.materializeById(String(messageId));
    if (!loaded) {
      const hydrated = await args.loadHistoryAround(String(messageId));
      if (!current()) return { status: "superseded" };
      if (!hydrated) return fail("failed");
      await args.waitForCommit();
      if (!current()) return { status: "superseded" };
      // Exactly one post-hydration materialization; never retry the network.
      if (!args.materializeById(String(messageId))) return fail("not-found");
    }

    await args.waitForCommit();
    if (!current()) return { status: "superseded" };
    // TranscriptWindow keeps the selected id pinned while the renderer catches
    // up. The DOM landing owns its own bounded, event-driven wait; guessing at
    // one or two visual frames produced false "not found" errors on long Rooms.
    if (!await args.scrollAndFocus(String(messageId), options.focusTarget !== false)) {
      return fail("not-found");
    }
    if (!current()) return { status: "superseded" };
    args.onCompleted(messageId);
    if (!current()) return { status: "superseded" };
    args.onState({ state: "idle" });
    return { status: "completed", loaded };
  };

  return { jumpToMessage, supersede };
}
