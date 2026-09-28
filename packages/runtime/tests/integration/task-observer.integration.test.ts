/**
 * M142 — TaskObserver claim/dispatch loop against real Postgres + a stub graph.
 *
 * Exercises the Phase-2a blast-radius minimal subset:
 *  - S3 now-task dispatches + runs as its own job (subagent: thread, output)
 *  - S4 cron reschedule across a timezone boundary + past-due catch-up
 *  - S5 concurrent ticks claim disjoint rows (FOR UPDATE SKIP LOCKED)
 *  - S6 a task run does NOT hold a human room lane
 *  - S2 clean shutdown stops the interval
 *  - S7 stale fire-locks recovered on start
 *
 * No API keys required: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  markTaskCancelled,
  serverAdmission,
  type DirectDatabase,
} from "@nautilo/db";
import {
  __setStubModelForTests,
  deepResearchTaskMetadata,
  setAgentEventSink,
} from "@nautilo/agent";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { laneLock } from "../../src/lane-lock";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  type TaskExecutionRouteSelector,
} from "../../src/tasks/dispatch-task-run";
import { taskRunExecutor } from "../../src/tasks/task-run-executor";
import { stopTask } from "../../src/tasks/lifecycle";
import { _setDeepResearchReportStreamForTests } from "../../src/executors/deep-research-executor";
import { nextCronOccurrence } from "../../src/tasks/cron";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
  taskTablesCleanStatus,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

let userId: string;
let agentId: string;
let db: DirectDatabase;

await setupTestDb();
db = getDirectDb();
const taskTableStatus = await taskTablesCleanStatus(db);
const taskSuiteSkipReason = taskTableStatus.clean
  ? null
  : taskTableStatus.reason;
if (taskSuiteSkipReason) {
  console.warn(`Skipping task-observer integration suite: ${taskSuiteSkipReason}`);
  await closeDirectDb();
}

beforeAll(async () => {
  if (taskSuiteSkipReason) return;
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("task-observer");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  // The production JobManager rechecks current server admission before work.
  await db.insert(serverAdmission).values({ userId, admitted: true });
  setTaskRunDb(db);
});

beforeEach(() => {
  __setStubModelForTests(null);
  _setDeepResearchReportStreamForTests(null);
});

afterAll(async () => {
  if (taskSuiteSkipReason) return;
  __setStubModelForTests(null);
  _setDeepResearchReportStreamForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  // tasks/task_runs cascade off the user delete (tasks.owner_id ON DELETE CASCADE).
  if (userId) await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

/** Set a stub model with `count` identical text responses (one per dispatched
 * run, so a test that fires N tasks doesn't exhaust the script). */
function stub(line: string, count = 1): void {
  __setStubProviderResponses(line, count);
}

function __setStubProviderResponses(line: string, count: number): void {
  __setStubModelForTests(
    createStubProvider({
      responses: Array.from({ length: count }, () => ({
        type: "text" as const,
        content: line,
      })),
    }).asChatModel(),
  );
}

/** Poll until every run for a task reaches a terminal status — so no job
 * lingers into the next test and consumes its stub. */
async function pollAllRunsTerminal(
  taskId: string,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof getTaskRuns>>> {
  return pollTaskRun(
    taskId,
    (rs) =>
      rs.length >= 1 &&
      rs.every((r) => ["completed", "errored", "cancelled"].includes(r.status)),
    timeoutMs,
  );
}

async function insertNowTask(prompt: string): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt,
    scheduleKind: "now",
    targetChat: "orphan",
    // `none` → empty tool whitelist → a single deterministic model.invoke,
    // matching the proven scope-subagent stub path.
    toolsMode: "none",
    nextFireAt: new Date(),
    status: "pending",
  });
  return row.id;
}

async function insertDeepResearchTask(prompt: string): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt,
    preset: "in_background",
    scheduleKind: "now",
    targetChat: "orphan",
    resultDelivery: "raw_and_wake",
    toolsMode: "none",
    metadata: deepResearchTaskMetadata({
      reportLanguage: "English",
      modelPlan: {
        version: 1,
        supervisorModel: "test:supervisor",
        researchModel: "test:research",
        summarizationModel: "test:summarization",
        compressionModel: "test:compression",
        finalReportModel: "test:report",
      },
      invokingModelId: process.env["NAUTILO_MODEL"] ?? null,
    }),
    nextFireAt: new Date(),
    status: "pending",
  });
  return row.id;
}

function makeObserver(
  now?: () => Date,
  executionRouteSelector?: TaskExecutionRouteSelector,
): TaskObserver {
  return new TaskObserver({
    db,
    jobManager,
    batch: 20,
    assertInvocation: async () => {},
    ...(now ? { now } : {}),
    ...(executionRouteSelector ? { executionRouteSelector } : {}),
  });
}

async function pollTaskRun(
  taskId: string,
  predicate: (runs: Awaited<ReturnType<typeof getTaskRuns>>) => boolean,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof getTaskRuns>>> {
  const start = Date.now();
  for (;;) {
    const runs = await getTaskRuns(db, taskId);
    if (predicate(runs)) return runs;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pollTaskRun timeout for task ${taskId}; runs=${JSON.stringify(
          runs.map((r) => ({ status: r.status, thread: r.graphThreadId })),
        )}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(taskSuiteSkipReason !== null)(
  `M142 — TaskObserver claim/dispatch (stub graph, real PG)${
    taskSuiteSkipReason ? ` — ${taskSuiteSkipReason}` : ""
  }`,
  () => {
  test("S3: now-task dispatches + runs as its own job on a subagent: thread", async () => {
    stub("TASK_STUB_OUTPUT_S3");
    const taskId = await insertNowTask("Reply briefly for S3.");

    const obs = makeObserver();
    await obs.tick();

    const runs = await pollTaskRun(taskId, (rs) => rs.some((r) => r.status === "completed"));
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    expect(run.graphThreadId.startsWith("subagent:")).toBe(true);
    expect(run.jobId).toBeTruthy(); // executor linked the real job id
    expect(run.resultText ?? "").toContain("TASK_STUB_OUTPUT_S3");

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("completed");

    await obs.stop();
  });

  test("M293: Deep Research runs through the ordinary Task/TaskRun/Job lifecycle", async () => {
    _setDeepResearchReportStreamForTests(async function* (_input, runId) {
      expect(runId).toBeTruthy();
      yield { phase: "Researching sources" };
      return "M293_INTEGRATION_REPORT";
    });
    const progress: ServerEvent[] = [];
    const onEvent = (event: ServerEvent) => {
      if (event.type === "task.progress") progress.push(event);
    };
    eventBus.on(onEvent);
    const taskId = await insertDeepResearchTask("Investigate the integration seam.");
    const obs = makeObserver();
    try {
      await obs.tick();
      const runs = await pollTaskRun(taskId, (rows) =>
        rows.some((row) => row.status === "completed"),
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "completed",
        resultText: "M293_INTEGRATION_REPORT",
      });
      expect(runs[0]?.jobId).toBeTruthy();
      expect((await getTaskById(db, taskId))?.status).toBe("completed");
      expect(progress.some((event) =>
        event.type === "task.progress" &&
        event.taskId === taskId &&
        event.taskRunId === runs[0]?.id &&
        event.ownerId === userId &&
        event.detail === "Researching sources"
      )).toBe(true);
    } finally {
      eventBus.off(onEvent);
      _setDeepResearchReportStreamForTests(null);
      await obs.stop();
    }
  });

  test("M293: stopping a Deep Research Task aborts its linked Job and stays cancelled", async () => {
    _setDeepResearchReportStreamForTests(async function* (_input, _runId, signal) {
      yield { phase: "Waiting to be stopped" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "MUST_NOT_BE_DELIVERED";
    });
    const taskId = await insertDeepResearchTask("Keep researching until cancelled.");
    const obs = makeObserver();
    try {
      await obs.tick();
      const running = await pollTaskRun(taskId, (rows) =>
        rows.some((row) => row.status === "running" && Boolean(row.jobId)),
      );
      expect(running[0]?.jobId).toBeTruthy();

      expect(await stopTask({ db, jobManager, observer: obs }, taskId)).toMatchObject({
        ok: true,
        status: "cancelled",
      });
      const terminal = await pollTaskRun(taskId, (rows) =>
        rows.some((row) => row.status === "cancelled"),
      );
      expect(terminal[0]?.status).toBe("cancelled");
      expect(terminal[0]?.resultText).toBeNull();
      expect((await getTaskById(db, taskId))?.status).toBe("cancelled");
    } finally {
      _setDeepResearchReportStreamForTests(null);
      await obs.stop();
    }
  });

  test("D453: selects an external execution route only after the durable TaskRun exists", async () => {
    stub("TASK_ROUTE_SELECTOR_OUTPUT");
    const taskId = await insertNowTask("Run through the selected route.");
    let selectorCalls = 0;
    let selectedExecutorCalls = 0;

    const selector: TaskExecutionRouteSelector = async (facts) => {
      selectorCalls += 1;
      expect(facts.taskId).toBe(taskId);
      expect(facts.laneKey).toBe(`task:${taskId}`);
      expect(facts.roomId).toBeTruthy();
      expect(Object.isFrozen(facts)).toBe(true);
      expect((await getTaskById(db, taskId))?.targetRoomId).toBe(facts.roomId);

      // Selection receives a real, persisted TaskRun before Job creation.
      const runs = await getTaskRuns(db, taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: facts.taskRunId,
        status: "running",
        jobId: null,
        graphThreadId: facts.graphThreadId,
      });

      return {
        coalescing: "separate",
        contention: "serialize",
        modelAttribution: "external",
        async *executor(input, jobId, laneKey, signal) {
          selectedExecutorCalls += 1;
          yield* taskRunExecutor(input, jobId, laneKey, signal);
        },
      };
    };

    const obs = makeObserver(undefined, selector);
    await obs.tick();

    const runs = await pollTaskRun(taskId, (rs) => rs.some((r) => r.status === "completed"));
    expect(selectorCalls).toBe(1);
    expect(selectedExecutorCalls).toBe(1);
    expect(runs[0]?.jobId).toBeTruthy();
    expect(runs[0]?.modelId).toBeNull();
    expect(runs[0]?.resultText ?? "").toContain("TASK_ROUTE_SELECTOR_OUTPUT");
    expect((await getTaskById(db, taskId))?.status).toBe("completed");

    await obs.stop();
  });

  test("S4: cron task fires once (catch-up) then reschedules in its timezone", async () => {
    stub("TASK_STUB_OUTPUT_S4");
    // Past-due cron in New York; every minute.
    const pastDue = new Date(Date.now() - 5 * 60_000);
    const row = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "cron tick",
      scheduleKind: "cron",
      cron: "* * * * *",
      timezone: "America/New_York",
      targetChat: "orphan",
      toolsMode: "none",
      nextFireAt: pastDue,
      status: "pending",
    });

    const tickNow = new Date();
    const obs = makeObserver(() => tickNow);
    await obs.tick();

    // Dispatched once, and the run reaches a terminal state before we move on
    // (so the job does not linger into the next test).
    const runs = await pollAllRunsTerminal(row.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("completed");

    // Rescheduled forward, still pending, fire-lock cleared.
    const task = await getTaskById(db, row.id);
    expect(task?.status).toBe("pending");
    expect(task?.fireLockId).toBeNull();
    const expectedNext = nextCronOccurrence("* * * * *", "America/New_York", tickNow);
    expect(task?.nextFireAt?.toISOString()).toBe(expectedNext.toISOString());
    expect(task!.nextFireAt!.getTime()).toBeGreaterThan(tickNow.getTime());

    await obs.stop();
    // Park the recurring task so a later test's tick can't re-claim it once
    // its next occurrence comes due mid-suite (it would steal the stub).
    await markTaskCancelled(db, row.id);
  });

  test("S5: concurrent ticks across two observers claim disjoint rows (no double-dispatch)", async () => {
    stub("TASK_STUB_OUTPUT_S5", 2);
    const t1 = await insertNowTask("S5 task one.");
    const t2 = await insertNowTask("S5 task two.");

    const obsA = makeObserver();
    const obsB = makeObserver();
    await Promise.all([obsA.tick(), obsB.tick()]);

    // Each task dispatched exactly once (no double-dispatch), and both runs
    // reach a terminal state before the next test.
    const runs1 = await pollAllRunsTerminal(t1);
    const runs2 = await pollAllRunsTerminal(t2);
    expect(runs1.length).toBe(1);
    expect(runs2.length).toBe(1);
    expect(runs1[0]!.status).toBe("completed");
    expect(runs2[0]!.status).toBe("completed");

    await Promise.all([obsA.stop(), obsB.stop()]);
  });

  test("S6: a task run does NOT hold a human room lane", async () => {
    stub("TASK_STUB_OUTPUT_S6");

    // Hold a human room lane for the entire task run.
    const humanLane = `room:${randomUUID()}:bot:${agentId}`;
    const release = await laneLock.acquire(humanLane);
    try {
      const taskId = await insertNowTask("S6 lane isolation.");
      const obs = makeObserver();
      await obs.tick();
      // The task completes even though a human lane is held → it never needed it.
      const runs = await pollTaskRun(taskId, (rs) =>
        rs.some((r) => r.status === "completed"),
      );
      expect(runs[0]!.status).toBe("completed");
      await obs.stop();
    } finally {
      await release();
    }
  });

  test("S7: stale fire-locks are cleared on start", async () => {
    stub("TASK_STUB_OUTPUT_S7");
    const staleLockedAt = new Date(Date.now() - 10 * 60_000);
    const row = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "S7 stale lock recovery.",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      nextFireAt: new Date(Date.now() - 60_000),
      status: "pending",
      fireLockId: randomUUID(),
      fireLockedAt: staleLockedAt,
    });

    const obs = makeObserver();
    await obs.start(); // clears stale locks → immediate tick → dispatch

    const runs = await pollTaskRun(row.id, (rs) =>
      rs.some((r) => r.status === "completed"),
    );
    expect(runs[0]!.status).toBe("completed");

    await obs.stop();
  });

  test("S2: stop() halts the interval (no dispatch after stop)", async () => {
    const obs = makeObserver();
    await obs.start();
    await obs.stop();

    // Insert a due task AFTER stop; without a running interval it must not fire.
    stub("TASK_STUB_OUTPUT_S2");
    const taskId = await insertNowTask("S2 should not run after stop.");

    await new Promise((r) => setTimeout(r, 1_500));
    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(0);

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("pending");

    // Clean up: dispatch it once so it doesn't linger pending.
    await obs.tick();
    await pollAllRunsTerminal(taskId);
    await obs.stop();
  });
  },
);
