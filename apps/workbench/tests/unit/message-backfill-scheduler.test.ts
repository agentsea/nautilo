import { describe, expect, test } from "bun:test";
import type { MessageBackfillBatchResult } from "@nautilo/lattice-bridge/client/browser";

import {
  createDesktopMessageBackfillSchedulerClient,
  createWorkbenchMessageBackfillScheduler,
  type PrioritizedHistoryRefreshResult,
  type WorkbenchMessageBackfillClient,
} from "../../src/adapters/message-backfill-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class FakeClock {
  nowMs = 1_000;
  private nextId = 0;
  private readonly tasks = new Map<number, Readonly<{
    at: number;
    callback: () => void;
  }>>();

  readonly clock = {
    now: () => this.nowMs,
    schedule: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.nowMs + delayMs, callback });
      return () => { this.tasks.delete(id); };
    },
  };

  runDue(): void {
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined) return;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
  }

  advanceTo(nowMs: number): void {
    this.nowMs = nowMs;
    this.runDue();
  }

  get pending(): number {
    return this.tasks.size;
  }
}

class FakeVisibility {
  visibilityState: DocumentVisibilityState = "hidden";
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(typeof listener === "function"
      ? listener as () => void
      : () => listener.handleEvent(new Event("visibilitychange")));
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.delete(listener as () => void);
  }

  set(value: DocumentVisibilityState): void {
    this.visibilityState = value;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Workbench Message backfill scheduler", () => {
  test("gates work on visibility, readiness, and foreground activity while coalescing hints", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    const first = deferred<MessageBackfillBatchResult>();
    const signals: AbortSignal[] = [];
    const prioritized: unknown[] = [];
    let calls = 0;
    const client: WorkbenchMessageBackfillClient = {
      prioritize: (selection) => { prioritized.push(selection); },
      runBatch({ signal }) {
        calls += 1;
        signals.push(signal);
        return calls === 1
          ? first.promise
          : Promise.resolve({ state: "caught_up", resumeAt: null });
      },
    };
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client,
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
    });

    scheduler.setReady(true);
    expect(time.pending).toBe(0);
    visibility.set("visible");
    time.runDue();
    expect(calls).toBe(1);
    const urgent = { roomId: "room-1", messageId: 27, revision: 2 };
    scheduler.prioritize(urgent);
    scheduler.notify();
    expect(calls).toBe(1);
    expect(prioritized).toEqual([urgent]);

    scheduler.setForegroundBusy(true);
    expect(signals[0]?.aborted).toBe(true);
    scheduler.setForegroundBusy(false);
    time.runDue();
    expect(calls).toBe(1);

    first.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    await flush();
    expect(calls).toBe(2);
    scheduler.dispose();
  });

  test("Desktop abort requests cancellation and never overlaps a pending main-process batch", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const first = deferred<MessageBackfillBatchResult>();
    let services = 0;
    let cancellations = 0;
    const desktop = createDesktopMessageBackfillSchedulerClient({
      service: async () => {
        services += 1;
        return services === 1
          ? first.promise
          : { state: "caught_up", resumeAt: null };
      },
      cancel: async () => { cancellations += 1; },
    });
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: desktop,
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
    });

    scheduler.setReady(true);
    time.runDue();
    expect(services).toBe(1);
    scheduler.notify();
    scheduler.setForegroundBusy(true);
    await flush();
    expect(cancellations).toBe(1);
    scheduler.setForegroundBusy(false);
    time.runDue();
    expect(services).toBe(1);

    first.resolve({ state: "waiting", resumeAt: null });
    await flush();
    time.runDue();
    await flush();
    expect(services).toBe(2);
    scheduler.dispose();
  });

  test("refreshes a prioritized visible row once after its batch yields more", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const selection = { roomId: "room-1", messageId: 27, revision: 0 };
    const results: MessageBackfillBatchResult[] = [
      { state: "more", resumeAt: null, reconciled: true,
        reconciledSelection: selection },
      { state: "caught_up", resumeAt: null },
      { state: "caught_up", resumeAt: null },
    ];
    let refreshes = 0;
    let calls = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => results[calls++],
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        refreshes += 1;
        return "refreshed";
      },
    });

    scheduler.prioritize(selection);
    scheduler.setReady(true);
    time.runDue();
    await flush();
    expect(refreshes).toBe(1);

    time.runDue();
    await flush();
    scheduler.notify();
    time.runDue();
    await flush();
    expect(calls).toBe(3);
    expect(refreshes).toBe(1);
    scheduler.dispose();
  });

  test("does not refresh the active page for unprioritized background work", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    let refreshes = 0;
    let calls = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => calls++ === 0
          ? { state: "more", resumeAt: null, reconciled: true }
          : { state: "caught_up", resumeAt: null },
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        refreshes += 1;
        return "refreshed";
      },
    });

    scheduler.setReady(true);
    time.runDue();
    await flush();
    time.runDue();
    await flush();
    expect(calls).toBe(2);
    expect(refreshes).toBe(0);
    scheduler.dispose();
  });

  test("retries a parent-mounted priority resolved through its canonical child without terminal feedback", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const refreshed: unknown[] = [];
    const parentSelection = { roomId: "parent-room", messageId: 27, revision: 0 };
    const childSelection = { roomId: "child-room", messageId: 27, revision: 0 };
    let calls = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => {
          calls += 1;
          return { state: "caught_up", resumeAt: null, resolvedSelection: childSelection };
        },
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: (value) => {
        refreshed.push(value);
        return "refreshed";
      },
    });

    scheduler.prioritize(parentSelection);
    scheduler.setReady(true);
    time.runDue();
    await flush();
    expect(refreshed).toEqual([childSelection]);

    scheduler.notify();
    time.runDue();
    await flush();
    expect(refreshed).toEqual([childSelection]);

    // A new visible unavailable observation for the same exact coordinate is
    // distinct from repeated terminal worker results for the prior observation.
    scheduler.prioritize(parentSelection);
    time.runDue();
    await flush();
    expect(refreshed).toEqual([childSelection, childSelection]);

    scheduler.notify();
    time.runDue();
    await flush();
    expect(refreshed).toEqual([childSelection, childSelection]);
    scheduler.dispose();
  });

  test("does not consume a later same-coordinate observation with an in-flight refresh", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const selection = { roomId: "room-1", messageId: 27, revision: 0 };
    const refreshResults: Array<ReturnType<typeof deferred<PrioritizedHistoryRefreshResult>>> = [];
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => ({
          state: "caught_up",
          resumeAt: null,
          resolvedSelection: selection,
        }),
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        const result = deferred<PrioritizedHistoryRefreshResult>();
        refreshResults.push(result);
        return result.promise;
      },
    });

    scheduler.prioritize(selection);
    scheduler.setReady(true);
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(1);

    scheduler.prioritize(selection);
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(1);

    refreshResults[0]?.resolve("refreshed");
    await flush();
    expect(refreshResults).toHaveLength(2);
    refreshResults[1]?.resolve("refreshed");
    await flush();

    scheduler.notify();
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(2);
    scheduler.dispose();
  });

  test("replays a later same-coordinate observation when the in-flight refresh becomes stale", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const selection = { roomId: "room-1", messageId: 27, revision: 0 };
    const refreshResults: Array<ReturnType<typeof deferred<PrioritizedHistoryRefreshResult>>> = [];
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => ({
          state: "caught_up",
          resumeAt: null,
          resolvedSelection: selection,
        }),
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        const result = deferred<PrioritizedHistoryRefreshResult>();
        refreshResults.push(result);
        return result.promise;
      },
    });

    scheduler.prioritize(selection);
    scheduler.setReady(true);
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(1);

    scheduler.prioritize(selection);
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(1);

    refreshResults[0]?.resolve("ignored");
    await flush();
    expect(refreshResults).toHaveLength(2);

    refreshResults[1]?.resolve("refreshed");
    await flush();
    scheduler.notify();
    time.runDue();
    await flush();
    expect(refreshResults).toHaveLength(2);
    scheduler.dispose();
  });

  test("does not refresh after disposal", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const first = deferred<MessageBackfillBatchResult>();
    let refreshes = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: () => first.promise,
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        refreshes += 1;
        return "refreshed";
      },
    });

    scheduler.setReady(true);
    time.runDue();
    scheduler.dispose();
    first.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    expect(refreshes).toBe(0);
    expect(time.pending).toBe(0);
  });

  test("retries a failed mounted reread at the worker error cadence and dedupes only after success", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const selection = { roomId: "room-1", messageId: 27, revision: 2 };
    let batches = 0;
    let refreshes = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: () => undefined,
        runBatch: async () => {
          batches += 1;
          return {
            state: "caught_up",
            resumeAt: null,
            resolvedSelection: selection,
          };
        },
      },
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
      onPrioritizedHistoryChanged: () => {
        refreshes += 1;
        return refreshes === 1 ? "retry" : "refreshed";
      },
    });

    scheduler.setReady(true);
    time.runDue();
    await flush();
    expect(batches).toBe(1);
    expect(refreshes).toBe(1);
    expect(time.pending).toBe(1);

    visibility.set("hidden");
    expect(time.pending).toBe(0);
    time.advanceTo(31_000);
    await flush();
    expect(refreshes).toBe(1);
    visibility.set("visible");
    expect(time.pending).toBeGreaterThanOrEqual(1);
    time.runDue();
    await flush();
    expect(refreshes).toBe(2);
    expect(time.pending).toBe(0);

    const batchesBeforeNotify = batches;
    scheduler.notify();
    time.runDue();
    await flush();
    expect(batches).toBe(batchesBeforeNotify + 1);
    expect(refreshes).toBe(2);
    scheduler.dispose();
  });

  test("dispose removes visibility ownership, cancels work, and ignores later hints", async () => {
    const time = new FakeClock();
    const visibility = new FakeVisibility();
    visibility.visibilityState = "visible";
    const pending = deferred<MessageBackfillBatchResult>();
    let services = 0;
    let cancellations = 0;
    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: createDesktopMessageBackfillSchedulerClient({
        service: () => {
          services += 1;
          return pending.promise;
        },
        cancel: async () => { cancellations += 1; },
      }),
      visibility: visibility as never,
      clock: time.clock,
      errorResumeAt: () => time.nowMs + 30_000,
    });

    scheduler.setReady(true);
    time.runDue();
    expect(services).toBe(1);
    expect(visibility.listenerCount).toBe(1);
    scheduler.dispose();
    await flush();
    expect(cancellations).toBe(1);
    expect(visibility.listenerCount).toBe(0);

    visibility.set("hidden");
    visibility.set("visible");
    scheduler.notify();
    pending.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    expect(services).toBe(1);
    expect(time.pending).toBe(0);
  });
});
