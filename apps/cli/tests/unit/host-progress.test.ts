import { describe, expect, test } from "bun:test";

import {
  createHostProgressCoordinator,
  pollHostProgress,
  type HostInterruptController,
  type HostProgressEvent,
  type HostProgressScheduler,
} from "@nautilo/hosting";
import { createScopedHostInterruptController } from "../../src/lib/host-progress.ts";

class FakeScheduler implements HostProgressScheduler {
  milliseconds = 0;
  readonly sleeps: number[] = [];
  readonly periodic = new Map<number, { readonly milliseconds: number; readonly callback: () => void }>();
  cleared = 0;
  #nextId = 0;

  now(): number {
    return this.milliseconds;
  }

  sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
    return Promise.resolve();
  }

  every(milliseconds: number, callback: () => void): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.periodic.set(id, { milliseconds, callback });
    return () => {
      this.cleared += 1;
      this.periodic.delete(id);
    };
  }

  advance(milliseconds: number): void {
    const previous = this.milliseconds;
    const target = previous + milliseconds;
    for (const entry of this.periodic.values()) {
      const firstTick = Math.floor(previous / entry.milliseconds) + 1;
      const lastTick = Math.floor(target / entry.milliseconds);
      for (let tick = firstTick; tick <= lastTick; tick += 1) {
        this.milliseconds = tick * entry.milliseconds;
        entry.callback();
      }
    }
    this.milliseconds = target;
  }
}

class FakeInterruptController implements HostInterruptController {
  wasInterrupted = false;
  disposed = 0;

  interrupted(): boolean {
    return this.wasInterrupted;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

describe("typed host progress", () => {
  test("scopes and removes its SIGINT listener without touching another operation", () => {
    let listener: (() => void) | undefined;
    let removed: (() => void) | undefined;
    const controller = createScopedHostInterruptController({
      once: (_event, candidate) => { listener = candidate; },
      removeListener: (_event, candidate) => { removed = candidate; },
    });
    expect(controller.interrupted()).toBe(false);
    expect(controller.signal?.aborted).toBe(false);
    listener?.();
    expect(controller.interrupted()).toBe(true);
    expect(controller.signal?.aborted).toBe(true);
    controller.dispose();
    expect(removed).toBe(listener);
  });

  test("stamps exact redacted events and emits a heartbeat no later than 15 seconds", async () => {
    const scheduler = new FakeScheduler();
    const events: HostProgressEvent[] = [];
    const interruption = new FakeInterruptController();
    let attempts = 0;
    const result = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({
        clock: scheduler,
        launchId: "launch-1",
        sink: { emit: (event) => events.push(event) },
      }),
      scheduler,
      interruption,
      maxAttempts: 4,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => {
        attempts += 1;
        return attempts === 4
          ? { state: { stage: "complete" }, outcome: "complete" as const }
          : { state, outcome: "pending" as const };
      },
    });

    expect(result.outcome).toBe("complete");
    expect(scheduler.sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(events).toContainEqual({
      schemaVersion: 1,
      launchId: "launch-1",
      stage: "databases",
      kind: "started",
      elapsedMs: 0,
      messageCode: "hosting.stage.started",
    });
    expect(scheduler.cleared).toBe(1);
    expect(events).toContainEqual({
      schemaVersion: 1,
      launchId: "launch-1",
      stage: "databases",
      kind: "heartbeat",
      elapsedMs: 15_000,
      messageCode: "hosting.poll.heartbeat",
    });
    expect(events).toContainEqual({
      schemaVersion: 1,
      launchId: "launch-1",
      stage: "complete",
      kind: "terminal",
      elapsedMs: 15_000,
      messageCode: "hosting.complete",
    });
    expect(JSON.stringify(events)).not.toContain("sk-");
  });

  test("interrupt stops future polling and leaves the last returned state intact", async () => {
    const scheduler = new FakeScheduler();
    const events: HostProgressEvent[] = [];
    const interruption = new FakeInterruptController();
    let attempts = 0;
    const result = await pollHostProgress({
      initialState: { stage: "databases", checkpoint: 1 },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({
        clock: scheduler,
        sink: { emit: (event) => events.push(event) },
      }),
      scheduler,
      interruption,
      maxAttempts: 180,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => {
        attempts += 1;
        interruption.wasInterrupted = true;
        return { state: { ...state, checkpoint: 2 }, outcome: "pending" as const };
      },
    });

    expect(result).toEqual({ state: { stage: "databases", checkpoint: 2 }, outcome: "interrupted" });
    expect(attempts).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: "terminal", messageCode: "hosting.interrupted" });
    expect(interruption.disposed).toBe(0);
    expect(scheduler.cleared).toBe(1);
  });

  test("keeps heartbeat active while an individual provider attempt is slow", async () => {
    const scheduler = new FakeScheduler();
    const events: HostProgressEvent[] = [];
    const result = await pollHostProgress({
      initialState: { stage: "logto-core" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({
        clock: scheduler,
        sink: { emit: (event) => events.push(event) },
      }),
      scheduler,
      interruption: new FakeInterruptController(),
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => {
        scheduler.advance(16_000);
        return { state, outcome: "failure" as const, failureCode: "railway.readiness.failed" };
      },
    });

    expect(result.outcome).toBe("failure");
    expect(events.find((event) => event.kind === "heartbeat")).toEqual({
      schemaVersion: 1,
      stage: "logto-core",
      kind: "heartbeat",
      elapsedMs: 15_000,
      messageCode: "hosting.poll.heartbeat",
    });
    expect(scheduler.cleared).toBe(1);
  });

  test("treats a throwing sink as observation loss, not an execution failure", async () => {
    const scheduler = new FakeScheduler();
    const result = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({
        clock: scheduler,
        sink: { emit: () => { throw new Error("renderer unavailable"); } },
      }),
      scheduler,
      interruption: new FakeInterruptController(),
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => ({ state: { ...state, stage: "complete" }, outcome: "complete" }),
    });
    expect(result.outcome).toBe("complete");
    expect(scheduler.cleared).toBe(1);
  });

  test("does not duplicate a boundary already emitted from a durable workflow transition", async () => {
    const scheduler = new FakeScheduler();
    const events: HostProgressEvent[] = [];
    const coordinator = createHostProgressCoordinator({
      clock: scheduler,
      sink: { emit: (event) => events.push(event) },
    });
    const result = await pollHostProgress({
      initialState: { stage: "authorized" },
      stage: (state) => state.stage,
      coordinator,
      scheduler,
      interruption: new FakeInterruptController(),
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async () => {
        coordinator.emit({ stage: "authorized", kind: "completed", messageCode: "hosting.stage.completed" });
        coordinator.emit({ stage: "databases", kind: "started", messageCode: "hosting.stage.started" });
        return { state: { stage: "databases" }, outcome: "failure" as const, durableStageTransitions: true };
      },
    });
    expect(result.outcome).toBe("failure");
    expect(events.map((event) => `${event.kind}:${event.stage}`)).toEqual([
      "started:authorized",
      "completed:authorized",
      "started:databases",
      "terminal:databases",
    ]);
  });

  test("converts execute and scheduler failures into terminal redacted failures", async () => {
    const executeScheduler = new FakeScheduler();
    const executeEvents: HostProgressEvent[] = [];
    const executeResult = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({ clock: executeScheduler, sink: { emit: (event) => executeEvents.push(event) } }),
      scheduler: executeScheduler,
      interruption: new FakeInterruptController(),
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async () => Promise.reject(new Error("provider token must not escape")),
    });
    expect(executeResult).toEqual({
      state: { stage: "databases" }, outcome: "failure", failureCode: "hosting.progress.execution-failed",
    });
    expect(executeEvents.at(-1)).toMatchObject({ kind: "terminal", messageCode: "hosting.execution.failed" });

    const scheduler = new FakeScheduler();
    scheduler.sleep = () => Promise.reject(new Error("scheduler raw failure"));
    const schedulerEvents: HostProgressEvent[] = [];
    const schedulerResult = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({ clock: scheduler, sink: { emit: (event) => schedulerEvents.push(event) } }),
      scheduler,
      interruption: new FakeInterruptController(),
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => ({ state, outcome: "pending" as const }),
    });
    expect(schedulerResult.failureCode).toBe("hosting.progress.scheduler-failed");
    expect(schedulerEvents.at(-1)).toMatchObject({ kind: "terminal", messageCode: "hosting.scheduler.failed" });
    expect(JSON.stringify([...executeEvents, ...schedulerEvents])).not.toContain("provider token");
  });
});
