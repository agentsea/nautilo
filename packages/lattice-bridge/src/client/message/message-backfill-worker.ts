import type { MessageBackfillUrgentSelection } from "@nautilo/api-client/browser";

export type MessageBackfillBatchResult = Readonly<{
  state: "more" | "waiting" | "caught_up";
  /** Absolute time on the injected clock, or null until an external hint. */
  resumeAt: number | null;
  /** Present only when this batch durably acknowledged a reconciled Message. */
  reconciled?: true;
  reconciledSelection?: Readonly<{
    roomId: string;
    messageId: number;
    revision: number;
  }>;
  /** The server proved this exact requested priority already reconciled. */
  resolvedSelection?: MessageBackfillUrgentSelection;
}>;

export type MessageBackfillWorkerState = Readonly<{
  state: "running" | "more" | "waiting" | "caught_up" | "error";
  resumeAt: number | null;
  reconciled?: true;
  reconciledSelection?: Readonly<{
    roomId: string;
    messageId: number;
    revision: number;
  }>;
  resolvedSelection?: MessageBackfillUrgentSelection;
}>;

export type MessageBackfillWorker = Readonly<{
  setReady(ready: boolean): void;
  setForegroundBusy(busy: boolean): void;
  setVisible(visible: boolean): void;
  /** Coalesces admission, reconnect, key-delivery, and realtime latency hints. */
  notify(): void;
  dispose(): void;
}>;

export function createMessageBackfillWorker(input: Readonly<{
  runBatch(input: Readonly<{ signal: AbortSignal }>): Promise<MessageBackfillBatchResult>;
  clock: Readonly<{
    now(): number;
    schedule(callback: () => void, delayMs: number): () => void;
  }>;
  onState?(state: MessageBackfillWorkerState): void;
  /** Supplies external retry timing without making failures terminal or counting attempts. */
  errorResumeAt?(): number | null;
}>): MessageBackfillWorker {
  let ready = false;
  let foregroundBusy = false;
  let visible = false;
  let disposed = false;
  let generation = 0;
  let inFlight: AbortController | null = null;
  let scheduledCancel: (() => void) | null = null;
  let scheduledAt: number | null = null;
  let immediateRescanRequested = false;

  const canRun = () => ready && visible && !foregroundBusy && !disposed;

  function cancelScheduled(): void {
    scheduledCancel?.();
    scheduledCancel = null;
    scheduledAt = null;
  }

  function scheduleAt(resumeAt: number): void {
    if (!canRun()) return;
    if (inFlight !== null) {
      immediateRescanRequested = true;
      return;
    }
    if (scheduledAt !== null && scheduledAt <= resumeAt) return;
    cancelScheduled();
    scheduledAt = resumeAt;
    scheduledCancel = input.clock.schedule(() => {
      scheduledCancel = null;
      scheduledAt = null;
      void run();
    }, Math.max(0, resumeAt - input.clock.now()));
  }

  function requestImmediate(): void {
    if (!canRun()) return;
    if (inFlight !== null) {
      immediateRescanRequested = true;
      return;
    }
    scheduleAt(input.clock.now());
  }

  async function run(): Promise<void> {
    if (!canRun() || inFlight !== null) return;
    const runGeneration = generation;
    const controller = new AbortController();
    inFlight = controller;
    input.onState?.({ state: "running", resumeAt: null });

    try {
      const result = await input.runBatch({ signal: controller.signal });
      if (disposed || runGeneration !== generation || controller.signal.aborted) return;
      if (inFlight === controller) inFlight = null;
      input.onState?.(result);
      if (immediateRescanRequested || result.state === "more") {
        immediateRescanRequested = false;
        scheduleAt(input.clock.now());
      } else if (result.resumeAt !== null) {
        scheduleAt(result.resumeAt);
      }
    } catch {
      if (disposed || runGeneration !== generation || controller.signal.aborted) return;
      if (inFlight === controller) inFlight = null;
      const resumeAt = input.errorResumeAt?.() ?? null;
      input.onState?.({ state: "error", resumeAt });
      if (immediateRescanRequested) {
        immediateRescanRequested = false;
        scheduleAt(input.clock.now());
      } else if (resumeAt !== null) {
        scheduleAt(resumeAt);
      }
    } finally {
      if (inFlight === controller) inFlight = null;
      if (canRun() && immediateRescanRequested) {
        immediateRescanRequested = false;
        scheduleAt(input.clock.now());
      }
    }
  }

  function pause(): void {
    generation += 1;
    cancelScheduled();
    immediateRescanRequested = false;
    inFlight?.abort();
  }

  return Object.freeze({
    setReady(nextReady) {
      if (disposed || ready === nextReady) return;
      ready = nextReady;
      if (ready) requestImmediate();
      else pause();
    },
    setForegroundBusy(nextBusy) {
      if (disposed || foregroundBusy === nextBusy) return;
      foregroundBusy = nextBusy;
      if (foregroundBusy) pause();
      else requestImmediate();
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      if (visible) requestImmediate();
      else pause();
    },
    notify() {
      if (disposed) return;
      cancelScheduled();
      requestImmediate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pause();
    },
  });
}
