import { describe, expect, test } from "bun:test";
import type {
  DurableSleepRunBudget,
  DurableSleepRunResult,
  DurableSleepSemanticPort,
  DurableSleepWorkPort,
} from "@nautilo/reflection";
import { runDurableHierarchySleep } from "@nautilo/reflection";
import type { DurableSleepItemLatencySample } from "@nautilo/reflection";

import {
  ReflectionSemanticWorker,
  type ReflectionSemanticWorkerDeps,
  type ReflectionSemanticWorkerHealthEvent,
} from "../../src/reflection/semantic-sleep-worker";

const BUDGET: DurableSleepRunBudget = Object.freeze({
  maxWorkItems: 2,
  hierarchy: Object.freeze({
    maxModelCalls: 4,
    maxVisitedRecords: 16,
    maxCreatedRecords: 2,
    maxTraversalWork: 16,
    maxStatementCharacters: 4_096,
  }),
});

const EMPTY_RESULT: DurableSleepRunResult = Object.freeze({
  usage: Object.freeze({
    modelCalls: 0,
    visitedRecords: 0,
    createdRecords: 0,
    traversalWork: 0,
  }),
  diagnostics: Object.freeze({
    authorityElapsedMs: 0,
    searchProjectionElapsedMs: 0,
    candidateElapsedMs: 0,
    modelElapsedMs: 0,
    publicationElapsedMs: 0,
    modelAttempts: 0,
    modelFailures: 0,
    deterministicNoChanges: 0,
    modelBatches: 0,
    modelBatchItems: 0,
    batchStaleRescheduled: 0,
  }),
  completedItemLatencies: Object.freeze([]),
  claimed: 0,
  checkpointed: 0,
  completed: 0,
  deferred: 0,
  paused: 0,
  quarantined: 0,
  recovered: 0,
  superseded: 0,
  leaseLost: 0,
  operations: Object.freeze({
    no_change: 0,
    create_parent: 0,
    extend_parent: 0,
    wrap_parent: 0,
    supersede_parent: 0,
    resolve_parent: 0,
    dissolve_parent: 0,
  }),
  failures: Object.freeze({}),
  terminalOutcomes: Object.freeze({}),
  planning: Object.freeze({
    sameRoomPlans: 0,
    crossRoomPlans: 0,
    sameRoomCompletions: 0,
    crossRoomCompletions: 0,
    candidatesOpened: 0,
    unsupportedAuthorityShapes: 0,
    authorityParentsResolved: 0,
    authorityParentsSkipped: 0,
    protectedExecutionUnavailable: 0,
  }),
  budgetExhausted: false,
});

const LATENCY_SAMPLE: DurableSleepItemLatencySample = Object.freeze({
  lane: "cross_room",
  queueElapsedMs: 10,
  claimStoreElapsedMs: 2,
  authorityElapsedMs: 3,
  searchProjectionElapsedMs: 4,
  sameRoomCandidateElapsedMs: 5,
  crossRoomCandidateElapsedMs: 6,
  selectedOpenElapsedMs: 7,
  promptConstructionElapsedMs: 8,
  promptInputCount: 3,
  promptCodePoints: 120,
  modelElapsedMs: 9,
  modelAttempts: 1,
  modelRepairs: 0,
  modelFailures: 0,
  proposalValidationElapsedMs: 1,
  publicationPlanningElapsedMs: 2,
  finalAuthorityElapsedMs: 3,
  productPublicationElapsedMs: 4,
  completionElapsedMs: 5,
  recursiveAdmissionElapsedMs: 6,
  endToEndElapsedMs: 80,
});

const UNUSED_WORK: DurableSleepWorkPort = {
  claimNext: async () => ({ status: "empty" }),
  checkpoint: async () => ({ status: "accepted" }),
  pause: async () => ({ status: "accepted" }),
  complete: async () => ({ status: "accepted" }),
  defer: async () => ({ status: "deferred" }),
  enqueue: async () => {},
};

const UNUSED_SEMANTIC: DurableSleepSemanticPort = {
  resolveParentConflict: async () => ({ status: "not_applicable" }),
  ensureAuthority: async () => ({ status: "ready" }),
  ensureSearchProjection: async () => ({ status: "ready" }),
  loadOrganizerView: async () => ({
    status: "unavailable",
    failureCode: "candidate_unavailable",
  }),
  resolveDependencyLoss: async () => ({ status: "not_applicable" }),
  invokeOrganizer: async () => "{}",
  applyProposal: async () => ({
    status: "unavailable",
    failureCode: "publication_unavailable",
  }),
};

function silentLogger(): NonNullable<ReflectionSemanticWorkerDeps["logger"]> {
  return { info() {}, warn() {}, error() {} };
}

function baseDeps(
  overrides: Partial<ReflectionSemanticWorkerDeps> = {},
): ReflectionSemanticWorkerDeps {
  return {
    maintenanceGate: { isAcceptingWork: async () => true },
    work: UNUSED_WORK,
    semantic: UNUSED_SEMANTIC,
    budget: BUDGET,
    logger: silentLogger(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class VirtualClock {
  nowMs = Date.parse("2026-08-18T12:00:00.000Z");
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  readonly adapter = {
    now: () => this.nowMs,
    setTimer: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.nowMs + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      this.tasks.delete(timer as unknown as number);
    },
  };

  get pendingTimers(): number {
    return this.tasks.size;
  }

  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.nowMs + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      this.nowMs = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    }
    this.nowMs = target;
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }
}

describe("ReflectionSemanticWorker", () => {
  test("aggregates completed items by lane and resets the numeric window on stop", async () => {
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => ({
        ...EMPTY_RESULT,
        completed: 1,
        completedItemLatencies: [LATENCY_SAMPLE],
      }),
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    expect(worker.getHealth().latency).toMatchObject({
      sameRoom: { endToEnd: { samples: 0 } },
      crossRoom: {
        endToEnd: { samples: 1, p50Ms: 80, p90Ms: 80, maximumMs: 80 },
        candidate: { p50Ms: 18 },
        publication: { p50Ms: 21 },
      },
    });
    await worker.stop();
    expect(worker.getHealth().latency.crossRoom.endToEnd.samples).toBe(0);
  });

  test("coalesces repeated wakeups behind a completion-relative cooldown", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async ({ budget, signal }) => {
        calls += 1;
        expect(budget).toEqual(BUDGET);
        expect(signal?.aborted).toBe(false);
        if (calls === 1) await first;
        return EMPTY_RESULT;
      },
    }), { scanIntervalMs: 60_000, clock: clock.adapter });

    worker.start();
    await clock.advanceBy(0);
    worker.wakeup(1);
    worker.wakeup(1);
    worker.wakeup(1);
    expect(calls).toBe(1);
    releaseFirst?.();
    await clock.advanceBy(0);
    expect(calls).toBe(1);
    worker.wakeup(1);
    worker.wakeup(1);
    expect(clock.pendingTimers).toBe(1);
    await clock.advanceBy(59_999);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    expect(worker.getHealth().window.admitted).toBe(5);
    await worker.stop();
  });

  test("does not start semantic work while maintenance rejects work", async () => {
    let calls = 0;
    const health: ReflectionSemanticWorkerHealthEvent[] = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      maintenanceGate: { isAcceptingWork: async () => false },
      runSleep: async () => {
        calls += 1;
        return EMPTY_RESULT;
      },
      onHealth: (event) => health.push(event),
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    await worker.stop();
    expect(calls).toBe(0);
    expect(health).toEqual([{ status: "skipped", reason: "maintenance" }]);
  });

  test("stop aborts the active poll and discards a queued wakeup", async () => {
    let calls = 0;
    let observedAbort = false;
    const health: ReflectionSemanticWorkerHealthEvent[] = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: ({ signal }) => {
        calls += 1;
        return new Promise<DurableSleepRunResult>((resolve) => {
          signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve(EMPTY_RESULT);
          }, { once: true });
        });
      },
      onHealth: (event) => health.push(event),
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    worker.wakeup();
    await worker.stop();
    await flush();
    expect(observedAbort).toBe(true);
    expect(calls).toBe(1);
    expect(health).toEqual([]);
  });

  test("OFF to ON does not bypass cooldown after aborting active work", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: ({ signal }) => {
        calls += 1;
        return new Promise<DurableSleepRunResult>((resolve) => {
          signal?.addEventListener("abort", () => resolve(EMPTY_RESULT), { once: true });
        });
      },
    }), { scanIntervalMs: 100, clock: clock.adapter });

    worker.start();
    await clock.advanceBy(0);
    await worker.stop();
    worker.start();
    await clock.advanceBy(99);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    await worker.stop();
  });

  test("OFF to ON recovers when a stale provider ignores abort forever", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise<DurableSleepRunResult>(() => {});
        }
        return EMPTY_RESULT;
      },
    }), { scanIntervalMs: 100, shutdownWaitMs: 1, clock: clock.adapter });

    worker.start();
    await clock.advanceBy(0);
    await worker.stop();
    worker.start();
    await clock.advanceBy(99);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    expect(worker.getHealth().state).toBe("cooldown");
    await worker.stop();
  });

  test("honors a model-lane retry delay instead of polling on the scan interval", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => {
        calls += 1;
        return { ...EMPTY_RESULT, modelRetryAfterMilliseconds: 90_000 };
      },
    }), { scanIntervalMs: 100, clock: clock.adapter });

    worker.start();
    await clock.advanceBy(0);
    expect(calls).toBe(1);
    expect(worker.getHealth().nextEligiblePollAt).toBe(
      new Date(clock.nowMs + 90_000).toISOString(),
    );

    await clock.advanceBy(89_999);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    await worker.stop();
  });

  test("uses the short catch-up interval only while durable work is ready", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      readPressure: async () => ({
        backlog: 10,
        ready: calls === 1 ? 4 : 0,
        oldestDueAt: new Date(clock.nowMs - 1_000),
      }),
      runSleep: async () => {
        calls += 1;
        return calls === 1 ? { ...EMPTY_RESULT, claimed: 1 } : EMPTY_RESULT;
      },
    }), {
      scanIntervalMs: 100,
      catchUpIntervalMs: 10,
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    expect(calls).toBe(1);
    await clock.advanceBy(9);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    await clock.advanceBy(99);
    expect(calls).toBe(2);
    await clock.advanceBy(1);
    expect(calls).toBe(3);
    await worker.stop();
  });

  test("gated protected stages do not keep the worker on the catch-up loop", async () => {
    const clock = new VirtualClock();
    let stage: "authority_projection" | "search_projection" =
      "authority_projection";
    let sleepCalls = 0;
    let authorityCalls = 0;
    let bodyOrProviderCalls = 0;
    const work: DurableSleepWorkPort = {
      async claimNext(_signal, options) {
        if (
          stage !== "authority_projection"
          || options?.maximumStage !== "authority_projection"
        ) return { status: "empty" };
        return {
          status: "claimed",
          claim: {
            logicalObjectRef: "record:protected",
            recordRef: "record:protected",
            generation: 1,
            changeReason: "created",
            stage,
            leaseToken: "lease:protected",
          },
        };
      },
      async checkpoint() {
        stage = "search_projection";
        return { status: "accepted" };
      },
      pause: async () => ({ status: "accepted" }),
      complete: async () => ({ status: "accepted" }),
      defer: async () => ({ status: "deferred" }),
      enqueue: async () => {},
    };
    const worker = new ReflectionSemanticWorker(baseDeps({
      work,
      resolveStageAdmission: async () => ({
        maximumStage: "authority_projection",
      }),
      semantic: {
        ...UNUSED_SEMANTIC,
        ensureAuthority: async () => {
          authorityCalls += 1;
          return { status: "ready" };
        },
        ensureSearchProjection: async () => {
          bodyOrProviderCalls += 1;
          return { status: "ready" };
        },
        invokeOrganizer: async () => {
          bodyOrProviderCalls += 1;
          return "{}";
        },
      },
      readPressure: async () => ({
        backlog: 1,
        // Aggregate storage health sees the due checkpoint, while the claim
        // path correctly rejects it under the protected PR1 stage ceiling.
        ready: 1,
        oldestDueAt: new Date(clock.nowMs - 1_000),
      }),
      runSleep: async (input) => {
        sleepCalls += 1;
        return runDurableHierarchySleep(input);
      },
    }), {
      scanIntervalMs: 100,
      catchUpIntervalMs: 10,
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    expect(sleepCalls).toBe(1);
    expect(authorityCalls).toBe(1);
    expect(String(stage)).toBe("search_projection");

    // One catch-up observes the newly gated checkpoint. Once the real claim
    // path returns empty, aggregate ready rows cannot cause another hot poll.
    await clock.advanceBy(10);
    expect(sleepCalls).toBe(2);
    await clock.advanceBy(99);
    expect(sleepCalls).toBe(2);
    await clock.advanceBy(1);
    expect(sleepCalls).toBe(3);
    expect(worker.getHealth().backlog.size).toBe(1);
    expect(bodyOrProviderCalls).toBe(0);
    await worker.stop();
  });

  test("reports only bounded result counters and fixed failure codes", async () => {
    const health: ReflectionSemanticWorkerHealthEvent[] = [];
    const logged: Array<Readonly<{
      level: string;
      message: string;
      fields: Record<string, unknown> | undefined;
    }>> = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => ({
        ...EMPTY_RESULT,
        usage: { ...EMPTY_RESULT.usage, modelCalls: 2 },
        diagnostics: {
          authorityElapsedMs: 3,
          searchProjectionElapsedMs: 5,
          candidateElapsedMs: 7,
          modelElapsedMs: 11,
          publicationElapsedMs: 13,
          modelAttempts: 2,
          modelFailures: 1,
          deterministicNoChanges: 1,
          modelBatches: 1,
          modelBatchItems: 2,
          batchStaleRescheduled: 0,
        },
        claimed: 2,
        completed: 1,
        deferred: 1,
        modelRetryAfterMilliseconds: 90_000,
        failures: { embedding_unavailable: 1 },
        failureDetails: { candidate_projection_stale: 1 },
      }),
      onHealth: (event) => health.push(event),
      logger: {
        info: (message, fields) => logged.push({ level: "info", message, fields }),
        warn: (message, fields) => logged.push({ level: "warn", message, fields }),
        error: (message, fields) => logged.push({ level: "error", message, fields }),
      },
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
      lastPoll: {
        modelCalls: 2,
        modelFailures: 1,
        authorityElapsedMs: 3,
        searchProjectionElapsedMs: 5,
        candidateElapsedMs: 7,
        modelElapsedMs: 11,
        publicationElapsedMs: 13,
        deterministicNoChanges: 1,
      },
    });
    await worker.stop();
    expect(health).toHaveLength(1);
    expect(health[0]?.status).toBe("completed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: "info",
      message: "[reflection] semantic poll completed",
      fields: {
        bootstrapAdmitted: 0,
        claimed: 2,
        completed: 1,
        deferred: 1,
        modelCalls: 2,
        modelFailures: 1,
        modelRetryAfterMilliseconds: 90_000,
        candidateElapsedMs: 7,
        modelElapsedMs: 11,
        deterministicNoChanges: 1,
        failureCounts: { embedding_unavailable: 1 },
        failureDetailCounts: { candidate_projection_stale: 1 },
      },
    });
    expect(JSON.stringify(logged)).not.toContain("statement");
    expect(JSON.stringify(logged)).not.toContain("recordRef");
  });

  test("keeps bounded bootstrap admission from consuming the Sleep budget", async () => {
    const clock = new VirtualClock();
    const bootstrapInputs: unknown[] = [];
    const sleepBudgets: number[] = [];
    let page = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      bootstrap: {
        bootstrapPage: async (input) => {
          bootstrapInputs.push(input);
          page += 1;
          return page === 1
            ? { admitted: 2, continuation: "opaque-page" }
            : { admitted: 2 };
        },
      },
      runSleep: async ({ budget }) => {
        sleepBudgets.push(budget.maxWorkItems);
        return EMPTY_RESULT;
      },
    }), { scanIntervalMs: 60_000, clock: clock.adapter });

    worker.start();
    await clock.advanceBy(0);
    worker.wakeup();
    await clock.advanceBy(60_000);
    await worker.stop();
    expect(bootstrapInputs).toEqual([
      { limit: 2, stageAdmission: { maximumStage: "organization" } },
      {
        limit: 2,
        continuation: "opaque-page",
        stageAdmission: { maximumStage: "organization" },
      },
    ]);
    expect(sleepBudgets).toEqual([2, 2]);
  });

  test("resolves one stage admission before bootstrap and passes it to Sleep", async () => {
    const events: string[] = [];
    let bootstrapAdmission: unknown;
    let sleepAdmission: unknown;
    const worker = new ReflectionSemanticWorker(baseDeps({
      resolveStageAdmission: async () => {
        events.push("admission");
        return { maximumStage: "authority_projection" };
      },
      bootstrap: {
        bootstrapPage: async (input) => {
          events.push("bootstrap");
          bootstrapAdmission = input.stageAdmission;
          return { admitted: 0 };
        },
      },
      runSleep: async (input) => {
        events.push("sleep");
        sleepAdmission = input.stageAdmission;
        return EMPTY_RESULT;
      },
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    await worker.stop();

    expect(events).toEqual(["admission", "bootstrap", "sleep"]);
    expect(bootstrapAdmission).toBe(sleepAdmission);
    expect(bootstrapAdmission).toEqual({ maximumStage: "authority_projection" });
    expect(Object.isFrozen(bootstrapAdmission)).toBe(true);
  });

  test("a stage-admission failure performs no bootstrap or claim", async () => {
    const events: string[] = [];
    const logged: unknown[] = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      resolveStageAdmission: async () => {
        events.push("admission");
        throw new Error("private policy detail");
      },
      bootstrap: {
        bootstrapPage: async () => {
          events.push("bootstrap");
          return { admitted: 0 };
        },
      },
      runSleep: async () => {
        events.push("sleep");
        return EMPTY_RESULT;
      },
      logger: {
        info: (...args) => logged.push(args),
        warn: (...args) => logged.push(args),
        error: (...args) => logged.push(args),
      },
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    await worker.stop();

    expect(events).toEqual(["admission"]);
    expect(logged).toEqual([[
      "[reflection] semantic poll failed",
      {
        schedulerState: "cooldown",
        pauseReason: null,
        failurePhase: "stage_admission",
        failureCode: "unexpected_failure",
      },
    ]]);
    expect(JSON.stringify(logged)).not.toContain("private policy detail");
  });

  test("bootstrap growth plus durable stage progress never opens backlog pressure", async () => {
    const clock = new VirtualClock();
    let backlog = 10;
    let sleepCalls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      bootstrap: {
        bootstrapPage: async () => {
          backlog += 2;
          return { admitted: 2 };
        },
      },
      readPressure: async () => ({
        backlog,
        ready: backlog,
        oldestDueAt: new Date(clock.nowMs - 1_000),
      }),
      runSleep: async ({ budget }) => {
        sleepCalls += 1;
        expect(budget.maxWorkItems).toBe(2);
        return { ...EMPTY_RESULT, claimed: 1, checkpointed: 1 };
      },
    }), {
      scanIntervalMs: 100,
      catchUpIntervalMs: 100,
      pressure: { backlogGrowthPolls: 2, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(sleepCalls).toBe(3);
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
      lastPoll: { claims: 1 },
    });
    await worker.stop();
  });

  test("durable progress prevents one item failure from tripping the global breaker", async () => {
    const clock = new VirtualClock();
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => ({
        ...EMPTY_RESULT,
        claimed: 2,
        checkpointed: 1,
        failures: { unexpected_failure: 1 },
      }),
    }), {
      scanIntervalMs: 100,
      pressure: { repeatedFailureThreshold: 2, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
    });
    await worker.stop();
  });

  test("does not expose a thrown provider error through health or logs", async () => {
    const health: ReflectionSemanticWorkerHealthEvent[] = [];
    const logged: unknown[] = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => {
        throw new Error("secret prompt and record rec-private");
      },
      onHealth: (event) => health.push(event),
      logger: {
        info: (...args) => logged.push(args),
        warn: (...args) => logged.push(args),
        error: (...args) => logged.push(args),
      },
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    await worker.stop();
    expect(health).toEqual([{
      status: "failed",
      failureCode: "unexpected_failure",
    }]);
    expect(JSON.stringify(logged)).not.toContain("secret prompt");
    expect(logged).toEqual([[
      "[reflection] semantic poll failed",
      {
        schedulerState: "cooldown",
        pauseReason: null,
        failurePhase: "sleep",
        failureCode: "unexpected_failure",
      },
    ]]);
  });

  test("identifies a failed pressure read without exposing its error", async () => {
    const logged: unknown[] = [];
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => EMPTY_RESULT,
      readPressure: async () => {
        throw new Error("secret database response");
      },
      logger: {
        info: (...args) => logged.push(args),
        warn: (...args) => logged.push(args),
        error: (...args) => logged.push(args),
      },
    }), { scanIntervalMs: 60_000 });

    worker.start();
    await flush();
    await worker.stop();
    expect(logged).toEqual([[
      "[reflection] semantic poll failed",
      {
        schedulerState: "cooldown",
        pauseReason: null,
        failurePhase: "pressure_read",
        failureCode: "unexpected_failure",
      },
    ]]);
    expect(JSON.stringify(logged)).not.toContain("secret database response");
  });

  test("opens elapsed pressure without starting a back-to-back poll", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: ({ signal }) => {
        calls += 1;
        return new Promise<DurableSleepRunResult>((resolve) => {
          signal?.addEventListener("abort", () => resolve(EMPTY_RESULT), { once: true });
        });
      },
    }), {
      scanIntervalMs: 20,
      pressure: { maxPollElapsedMs: 100, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    expect(calls).toBe(1);
    worker.wakeup(1);
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "pressure_paused",
      pauseReason: "elapsed_budget",
    });
    await clock.advanceBy(999);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    await worker.stop();
  });

  test("automatically probes after an elapsed provider ignores abort forever", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise<DurableSleepRunResult>(() => {});
        }
        return EMPTY_RESULT;
      },
    }), {
      scanIntervalMs: 20,
      pressure: { maxPollElapsedMs: 100, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(100);
    expect(calls).toBe(1);
    expect(worker.getHealth()).toMatchObject({
      state: "pressure_paused",
      pauseReason: "elapsed_budget",
    });
    await clock.advanceBy(999);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    expect(worker.getHealth().state).toBe("cooldown");
    await worker.stop();
  });

  test("an elapsed stale bootstrap cannot overwrite the active continuation", async () => {
    const clock = new VirtualClock();
    const inputs: Array<Readonly<{
      limit: number;
      continuation?: string;
      stageAdmission: { maximumStage: string };
    }>> = [];
    let releaseStale: ((page: Readonly<{ admitted: number; continuation?: string }>) => void)
      | undefined;
    const stalePage = new Promise<Readonly<{ admitted: number; continuation?: string }>>(
      (resolve) => {
        releaseStale = resolve;
      },
    );
    const worker = new ReflectionSemanticWorker(baseDeps({
      bootstrap: {
        bootstrapPage: async (input) => {
          inputs.push(input);
          if (inputs.length === 1) return await stalePage;
          return { admitted: 0, continuation: "active-page" };
        },
      },
      runSleep: async () => EMPTY_RESULT,
    }), {
      scanIntervalMs: 20,
      pressure: { maxPollElapsedMs: 100, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(1_100);
    expect(inputs).toEqual([
      { limit: 2, stageAdmission: { maximumStage: "organization" } },
      { limit: 2, stageAdmission: { maximumStage: "organization" } },
    ]);
    releaseStale?.({ admitted: 0, continuation: "stale-page" });
    await clock.advanceBy(20);
    expect(inputs[2]).toEqual({
      limit: 2,
      continuation: "active-page",
      stageAdmission: { maximumStage: "organization" },
    });
    await worker.stop();
  });

  test("rate-limits a repeated permanent failure and clears on a healthy probe", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => {
        calls += 1;
        if (calls <= 4) throw new Error("provider configuration unavailable");
        return EMPTY_RESULT;
      },
    }), {
      scanIntervalMs: 100,
      pressure: { repeatedFailureThreshold: 3, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(calls).toBe(3);
    expect(worker.getHealth()).toMatchObject({
      state: "pressure_paused",
      pauseReason: "repeated_failure",
    });
    await clock.advanceBy(999);
    expect(calls).toBe(3);
    await clock.advanceBy(1);
    expect(calls).toBe(4);
    expect(worker.getHealth()).toMatchObject({
      state: "pressure_paused",
      pauseReason: "repeated_failure",
    });
    await clock.advanceBy(1_000);
    expect(calls).toBe(5);
    expect(worker.getHealth()).toMatchObject({ state: "cooldown", pauseReason: null });
    await worker.stop();
  });

  test("opens backlog pressure only after bounded no-progress growth", async () => {
    const clock = new VirtualClock();
    const backlog = [1, 2, 3, 4];
    const oldestDueAt = new Date(clock.nowMs - 1_000);
    const worker = new ReflectionSemanticWorker(baseDeps({
      readPressure: async () => ({
        backlog: backlog.shift() ?? 3,
        ready: 0,
        oldestDueAt,
      }),
      runSleep: async () => EMPTY_RESULT,
    }), {
      scanIntervalMs: 100,
      pressure: { backlogGrowthPolls: 3, pressureProbeIntervalMs: 1_000 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    expect(worker.getHealth().state).toBe("cooldown");
    await clock.advanceBy(100);
    expect(worker.getHealth().state).toBe("cooldown");
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "pressure_paused",
      pauseReason: "backlog_growth",
      backlog: { size: 4, oldestAgeMs: 1_300 },
    });
    expect(Object.keys(worker.getHealth().backlog).sort()).toEqual([
      "oldestAgeMs",
      "size",
    ]);
    await worker.stop();
  });

  test("reports high parent creation without globally pausing queued work", async () => {
    const clock = new VirtualClock();
    const amplifying: DurableSleepRunResult = {
      ...EMPTY_RESULT,
      completed: 1,
      usage: { ...EMPTY_RESULT.usage, createdRecords: 1 },
      operations: { ...EMPTY_RESULT.operations, create_parent: 1 },
    };
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => amplifying,
    }), {
      scanIntervalMs: 100,
      pressure: {
        rollingWindowPolls: 3,
        amplificationMinimumCreated: 3,
        amplificationRatioPercent: 75,
        pressureProbeIntervalMs: 1_000,
      },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
      amplification: "pressure",
      window: { polls: 3, completed: 3, created: 3 },
    });
    await worker.stop();
  });

  test("does not treat immutable parent evolution as recursive amplification", async () => {
    const clock = new VirtualClock();
    const evolving: DurableSleepRunResult = {
      ...EMPTY_RESULT,
      completed: 1,
      usage: { ...EMPTY_RESULT.usage, createdRecords: 1 },
      operations: { ...EMPTY_RESULT.operations, extend_parent: 1 },
    };
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => evolving,
    }), {
      scanIntervalMs: 100,
      pressure: {
        rollingWindowPolls: 3,
        amplificationMinimumCreated: 3,
        amplificationRatioPercent: 75,
      },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
      amplification: "normal",
      window: { polls: 3, completed: 3, created: 0 },
    });
    await worker.stop();
  });

  test("does not globally pause unrelated work for record-local deferrals", async () => {
    const clock = new VirtualClock();
    const deferred: DurableSleepRunResult = {
      ...EMPTY_RESULT,
      deferred: 1,
      failures: { candidate_unavailable: 1 },
    };
    const worker = new ReflectionSemanticWorker(baseDeps({
      runSleep: async () => deferred,
    }), {
      scanIntervalMs: 100,
      pressure: { repeatedFailureThreshold: 2 },
      clock: clock.adapter,
    });

    worker.start();
    await clock.advanceBy(0);
    await clock.advanceBy(100);
    await clock.advanceBy(100);
    expect(worker.getHealth()).toMatchObject({
      state: "cooldown",
      pauseReason: null,
    });
    await worker.stop();
  });

  test("rejects unbounded timer options", () => {
    expect(() => new ReflectionSemanticWorker(baseDeps(), {
      scanIntervalMs: 0,
    })).toThrow("positive safe integer");
    expect(() => new ReflectionSemanticWorker(baseDeps(), {
      catchUpIntervalMs: 0,
    })).toThrow("positive safe integer");
    expect(() => new ReflectionSemanticWorker(baseDeps(), {
      shutdownWaitMs: Number.POSITIVE_INFINITY,
    })).toThrow("positive safe integer");
  });
});
