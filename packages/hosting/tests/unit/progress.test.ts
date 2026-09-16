import { describe, expect, test } from "bun:test";

import {
  createHostProgressCoordinator,
  pollHostProgress,
  type HostProgressScheduler,
} from "../../src/index.ts";

class Scheduler implements HostProgressScheduler {
  nowMs = 0;
  now(): number { return this.nowMs; }
  sleep(milliseconds: number): Promise<void> { this.nowMs += milliseconds; return Promise.resolve(); }
  every(_milliseconds: number, _callback: () => void): () => void { return () => {}; }
}

describe("shared hosting progress contract", () => {
  test("exports a redacted coordinator and keeps sink failure observational", async () => {
    const scheduler = new Scheduler();
    const result = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({
        clock: scheduler,
        sink: { emit: () => { throw new Error("must not affect execution"); } },
      }),
      scheduler,
      interruption: { interrupted: () => false, dispose: () => {} },
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => ({ state, outcome: "complete" as const }),
    });
    expect(result.outcome).toBe("complete");
  });

  test("turns timer setup failure into a redacted result and ignores cleanup failure", async () => {
    const setupScheduler = new Scheduler();
    setupScheduler.every = () => { throw new Error("raw timer setup failure"); };
    const setupResult = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({ clock: setupScheduler }),
      scheduler: setupScheduler,
      interruption: { interrupted: () => false, dispose: () => {} },
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => ({ state, outcome: "complete" as const }),
    });
    expect(setupResult).toEqual({
      state: { stage: "databases" },
      outcome: "failure",
      failureCode: "hosting.progress.scheduler-failed",
    });

    const cleanupScheduler = new Scheduler();
    cleanupScheduler.every = () => () => { throw new Error("raw timer cleanup failure"); };
    const cleanupResult = await pollHostProgress({
      initialState: { stage: "databases" },
      stage: (state) => state.stage,
      coordinator: createHostProgressCoordinator({ clock: cleanupScheduler }),
      scheduler: cleanupScheduler,
      interruption: { interrupted: () => false, dispose: () => {} },
      maxAttempts: 1,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (state) => ({ state, outcome: "complete" as const }),
    });
    expect(cleanupResult.outcome).toBe("complete");
  });
});
