import { describe, expect, test } from "bun:test";

import {
  createDesktopTaskContentBackfillSchedulerClient,
  createWorkbenchTaskContentBackfillScheduler,
} from "./task-content-backfill-scheduler";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  let visible = true;
  const listeners = new Set<() => void>();
  const scheduled: Array<{ active: boolean; callback: () => void }> = [];
  return {
    visibility: {
      get visibilityState() {
        return visible ? "visible" as const : "hidden" as const;
      },
      addEventListener(_name: string, listener: EventListenerOrEventListenerObject) {
        listeners.add(listener as () => void);
      },
      removeEventListener(_name: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener as () => void);
      },
    },
    clock: {
      now: () => 1_000,
      schedule(callback: () => void) {
        const entry = { active: true, callback };
        scheduled.push(entry);
        return () => { entry.active = false; };
      },
    },
    runNext() {
      const entry = scheduled.find((candidate) => candidate.active);
      if (entry === undefined) return false;
      entry.active = false;
      entry.callback();
      return true;
    },
    activeSchedules() {
      return scheduled.filter((entry) => entry.active).length;
    },
    setVisible(next: boolean) {
      visible = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

describe("Task content backfill scheduler", () => {
  test("requires current Task protection before entering the repair client", async () => {
    const surface = harness();
    let taskProtectionActive = false;
    let readinessReads = 0;
    let clientRuns = 0;
    const scheduler = createWorkbenchTaskContentBackfillScheduler({
      client: {
        runBatch: () => {
          clientRuns += 1;
          return Promise.resolve({ state: "waiting", resumeAt: null });
        },
      },
      readiness: {
        readTaskProtectionActive: () => {
          readinessReads += 1;
          return Promise.resolve(taskProtectionActive);
        },
      },
      visibility: surface.visibility,
      clock: surface.clock,
      errorResumeAt: () => 31_000,
    });

    scheduler.setReady(true);
    expect(surface.runNext()).toBe(true);
    await flush();
    expect(readinessReads).toBe(1);
    expect(clientRuns).toBe(0);
    expect(surface.activeSchedules()).toBe(0);

    taskProtectionActive = true;
    scheduler.notify();
    expect(surface.runNext()).toBe(true);
    await flush();
    expect(readinessReads).toBe(2);
    expect(clientRuns).toBe(1);
    scheduler.dispose();
  });

  test("combines admission, visibility, and foreground-busy gates", async () => {
    const surface = harness();
    let runs = 0;
    const scheduler = createWorkbenchTaskContentBackfillScheduler({
      client: {
        runBatch: () => {
          runs += 1;
          return Promise.resolve({ state: "waiting", resumeAt: null });
        },
      },
      readiness: { readTaskProtectionActive: () => Promise.resolve(true) },
      visibility: surface.visibility,
      clock: surface.clock,
      errorResumeAt: () => 31_000,
    });

    surface.setVisible(false);
    scheduler.setReady(true);
    expect(surface.activeSchedules()).toBe(0);
    surface.setVisible(true);
    scheduler.setForegroundBusy(true);
    expect(surface.activeSchedules()).toBe(0);
    scheduler.setForegroundBusy(false);
    expect(surface.runNext()).toBe(true);
    await flush();
    expect(runs).toBe(1);

    scheduler.setReady(false);
    scheduler.notify();
    expect(surface.activeSchedules()).toBe(0);
    scheduler.dispose();
    expect(surface.listenerCount()).toBe(0);
  });

  test("Desktop cancellation remains scoped to the in-flight repair batch", async () => {
    let cancelCalls = 0;
    let resolveService: (() => void) | undefined;
    const client = createDesktopTaskContentBackfillSchedulerClient({
      service: async () => {
        await new Promise<void>((resolve) => { resolveService = resolve; });
        return { state: "waiting", resumeAt: null };
      },
      cancel: () => {
        cancelCalls += 1;
        resolveService?.();
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    const running = client.runBatch({ signal: controller.signal });
    await flush();
    controller.abort();
    await running;
    expect(cancelCalls).toBe(1);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(await client.runBatch({ signal: alreadyAborted.signal }))
      .toEqual({ state: "waiting", resumeAt: null });
    expect(cancelCalls).toBe(1);
  });
});
