import { beforeEach, expect, mock, test } from "bun:test";

import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "20000000-0000-4000-8000-000000000002";
const REQUEST_ID = "30000000-0000-4000-8000-000000000003";
const RUN_A = "40000000-0000-4000-8000-000000000004";
const RUN_B = "50000000-0000-4000-8000-000000000005";
const JOB_A = "60000000-0000-4000-8000-000000000006";
const JOB_B = "70000000-0000-4000-8000-000000000007";

const database = await import("@nautilo/db");
let task: Task;
let requested: Parameters<typeof database.requestProtectedTaskCheckpointPause>[1][];
let finalized: Parameters<typeof database.finalizeProtectedTaskCheckpointPause>[1][];
let resumed: Parameters<typeof database.resumeProtectedTaskCheckpointPause>[1][];
let protectedRequestResult: Awaited<ReturnType<typeof database.requestProtectedTaskCheckpointPause>>;
let protectedFinalizeResult: Awaited<ReturnType<typeof database.finalizeProtectedTaskCheckpointPause>>;
let protectedResumeResult: Awaited<ReturnType<typeof database.resumeProtectedTaskCheckpointPause>>;
let transitionCalls: number;
let updateCalls: number;
let resumableRun: TaskRun | undefined;
let taskReads: Task[];
let contentReads: number;
let fundingChecks: number;
let beforeProtectedResume: (() => void) | null;
let transitionOverride: Awaited<ReturnType<
  typeof database.transitionTaskLifecyclePaused
>> | null;

mock.module("@nautilo/db", () => ({
  ...database,
  getTaskLifecycleState: async () => {
    const current = taskReads.shift() ?? task;
    return {
      id: current.id, ownerId: current.ownerId, requestorId: current.requestorId,
      agentId: current.agentId, targetRoomId: current.targetRoomId,
      status: current.status, contentRepresentation: current.contentRepresentation,
      scheduleKind: current.scheduleKind, pauseRequestId: current.pauseRequestId,
      pauseRequestedAt: current.pauseRequestedAt, pauseReason: current.pauseReason,
      localExecutionRecaptureRequired: database.taskRequiresLocalExecutionRecapture(current),
      fundingOutcomeUncertain: current.lastError === "funding_interrupted_uncertain",
      latestRunPaused: resumableRun?.status === "paused",
    };
  },
  getTaskById: async () => {
    contentReads += 1;
    if (task.contentRepresentation !== "ordinary") throw new Error("Protected content read");
    return task;
  },
  getTaskByIdWithMutationVersion: async () => {
    contentReads += 1;
    if (task.contentRepresentation !== "ordinary") throw new Error("Protected content read");
    return task;
  },
  getLatestResumableTaskRun: async () => {
    contentReads += 1;
    if (task.contentRepresentation !== "ordinary") throw new Error("Protected result read");
    return resumableRun;
  },
  requestProtectedTaskCheckpointPause: async (
    _db: DirectDatabase,
    input: Parameters<typeof database.requestProtectedTaskCheckpointPause>[1],
  ) => {
    requested.push(input);
    return protectedRequestResult;
  },
  finalizeProtectedTaskCheckpointPause: async (
    _db: DirectDatabase,
    input: Parameters<typeof database.finalizeProtectedTaskCheckpointPause>[1],
  ) => {
    finalized.push(input);
    return protectedFinalizeResult;
  },
  resumeProtectedTaskCheckpointPause: async (
    _db: DirectDatabase,
    input: Parameters<typeof database.resumeProtectedTaskCheckpointPause>[1],
  ) => {
    resumed.push(input);
    beforeProtectedResume?.();
    if (protectedResumeResult === "resumed") {
      task = { ...task, status: "awaiting", pauseRequestId: null,
        pauseRequestedAt: null, pauseReason: null };
    }
    return protectedResumeResult;
  },
  transitionTaskLifecyclePaused: async () => {
    transitionCalls += 1;
    if (transitionOverride !== null) return transitionOverride;
    task = { ...task, status: "paused" };
    return {
      task,
      run: { id: RUN_A, taskId: TASK_ID, jobId: JOB_A, status: "paused" },
      transitioned: true,
      outcome: "transitioned",
    };
  },
  updateTaskIfCurrent: async () => {
    updateCalls += 1;
    return task;
  },
}));

mock.module("../../src/tasks/security-report-recovery", () => ({
  holdSecurityResearchDesktop: async () => {},
  recoverSecurityResearchContextFailure: async () => false,
}));

const fundingPort = await import("../../src/task-funding-port");
mock.module("../../src/task-funding-port", () => ({
  ...fundingPort,
  assertTaskFundingAdmission: async (candidate: Parameters<typeof fundingPort.assertTaskFundingAdmission>[0]) => {
    fundingChecks += 1;
    if (candidate.contentRepresentation !== "ordinary") throw new Error("Protected funding without grant");
    return null;
  },
}));

const { pauseTask, unpauseTask } = await import("../../src/tasks/lifecycle");

const db = {} as DirectDatabase;

function protectedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    ownerId: OWNER_ID,
    requestorId: OWNER_ID,
    agentId: "agent",
    targetChat: "room",
    status: "running",
    contentRepresentation: "protected",
    scheduleKind: "now",
    fundingMode: "legacy_server",
    metadata: {},
    mutationVersion: 7,
    contentRevision: 1,
    pauseRequestId: null,
    pauseRequestedAt: null,
    pauseReason: null,
    nextFireAt: new Date("2030-01-01T09:00:00.000Z"),
    lastError: null,
    ...overrides,
  } as Task;
}

function requestResult(
  runs: readonly { taskRunId: string; jobId: string | null; graphThreadId: string;
    status: "running" | "awaiting" }[],
  status: "requested" | "exact_replay" = "requested",
): Awaited<ReturnType<typeof database.requestProtectedTaskCheckpointPause>> {
  return {
    status,
    request: {
      taskId: TASK_ID,
      pauseRequestId: REQUEST_ID,
      reason: "manual_pause",
      requestedAt: new Date("2030-01-01T08:00:00.000Z"),
      requesterUserId: OWNER_ID,
      agentId: "agent",
    },
    runs,
  };
}

beforeEach(() => {
  task = protectedTask();
  requested = [];
  finalized = [];
  resumed = [];
  protectedRequestResult = requestResult([]);
  protectedFinalizeResult = "paused";
  protectedResumeResult = "resumed";
  transitionCalls = 0;
  updateCalls = 0;
  resumableRun = undefined;
  taskReads = [];
  contentReads = 0;
  fundingChecks = 0;
  beforeProtectedResume = null;
  transitionOverride = null;
});

test("protected pause requests every live Job with one durable request and finalizes only after they drain", async () => {
  protectedRequestResult = requestResult([
    { taskRunId: RUN_A, jobId: JOB_A, graphThreadId: "thread:a", status: "running" },
    { taskRunId: RUN_B, jobId: JOB_B, graphThreadId: "thread:b", status: "awaiting" },
  ]);
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const bothEntered = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const aborts: unknown[] = [];
  const resultPromise = pauseTask({
    db,
    jobManager: {
      abortJob: (...args) => { aborts.push(args); return false; },
      requestProtectedTaskCheckpointPauseAndWait: async input => {
        calls.push(input);
        if (calls.length === 2) bothEntered.resolve();
        await (input.jobId === JOB_A ? releaseA.promise : releaseB.promise);
        return { status: "settled" };
      },
    },
  }, TASK_ID);

  await bothEntered.promise;
  expect(finalized).toEqual([]);
  releaseB.resolve();
  await Promise.resolve();
  expect(finalized).toEqual([]);
  releaseA.resolve();

  expect(await resultPromise).toEqual({ ok: true, status: "paused", message: "Task paused." });
  expect(calls).toEqual([
    { taskId: TASK_ID, taskRunId: RUN_A, jobId: JOB_A,
      pauseRequestId: REQUEST_ID, reason: "manual_pause" },
    { taskId: TASK_ID, taskRunId: RUN_B, jobId: JOB_B,
      pauseRequestId: REQUEST_ID, reason: "manual_pause" },
  ]);
  expect(finalized).toEqual([{ taskId: TASK_ID, pauseRequestId: REQUEST_ID }]);
  expect(aborts).toEqual([]);
  expect(transitionCalls).toBe(0);
});

test("an unavailable process owner leaves protected pause pending and wakes durable recovery", async () => {
  protectedRequestResult = requestResult([
    { taskRunId: RUN_A, jobId: JOB_A, graphThreadId: "thread:a", status: "running" },
  ]);
  protectedFinalizeResult = "pending";
  let kicks = 0;
  let aborts = 0;
  const result = await pauseTask({
    db,
    observer: { kick: () => { kicks += 1; } },
    jobManager: {
      abortJob: () => { aborts += 1; return false; },
      requestProtectedTaskCheckpointPauseAndWait: async () => ({ status: "unavailable" }),
    },
  }, TASK_ID, "time_limit");

  expect(result).toEqual({
    ok: true,
    status: "running",
    message: "Task pause requested; waiting for a safe checkpoint.",
  });
  expect(kicks).toBe(1);
  expect(aborts).toBe(0);
  expect(requested[0]).toMatchObject({ reason: "time_limit", requesterUserId: OWNER_ID });
});

test("protected pause retries the first immutable request identity", async () => {
  const requestedAt = new Date("2029-12-31T23:59:00.000Z");
  task = protectedTask({ pauseRequestId: REQUEST_ID, pauseRequestedAt: requestedAt,
    pauseReason: "time_limit" });
  protectedRequestResult = { status: "exact_replay", runs: [], request: {
    taskId: TASK_ID, pauseRequestId: REQUEST_ID, reason: "time_limit", requestedAt,
    requesterUserId: OWNER_ID, agentId: "agent",
  } };
  protectedFinalizeResult = "exact_replay";

  expect(await pauseTask({ db, jobManager: { abortJob: () => false } }, TASK_ID)).toEqual({
    ok: true,
    status: "paused",
    message: "Task is already paused.",
  });
  expect(requested).toEqual([{
    taskId: TASK_ID,
    requesterUserId: OWNER_ID,
    pauseRequestId: REQUEST_ID,
    reason: "time_limit",
    requestedAt,
  }]);
});

test("protected resume clears only the settled request and preserves the occurrence schedule", async () => {
  const nextFireAt = new Date("2030-01-02T09:00:00.000Z");
  task = protectedTask({ status: "paused", scheduleKind: "cron", cron: "0 9 * * *",
    nextFireAt, pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  resumableRun = { id: RUN_A, taskId: TASK_ID, jobId: JOB_A,
    graphThreadId: "thread:a", status: "awaiting" } as TaskRun;
  let kicks = 0;
  let aborts = 0;

  const result = await unpauseTask({
    db,
    observer: { kick: () => { kicks += 1; } },
    jobManager: { abortJob: () => { aborts += 1; return false; } },
  }, TASK_ID);

  expect(result).toEqual({ ok: true, status: "awaiting", message: "Task resumed." });
  expect(resumed).toEqual([{
    taskId: TASK_ID,
    requesterUserId: OWNER_ID,
    pauseRequestId: REQUEST_ID,
  }]);
  expect(task.nextFireAt).toEqual(nextFireAt);
  expect(task.pauseRequestId).toBeNull();
  expect(updateCalls).toBe(0);
  expect(aborts).toBe(0);
  expect(kicks).toBe(1);
  expect(contentReads).toBe(0);
  expect(fundingChecks).toBe(0);
});

test("resume during checkpoint drain reports the durable current status without clearing the request", async () => {
  task = protectedTask({ pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  let kicks = 0;
  const result = await unpauseTask({ db, observer: { kick: () => { kicks += 1; } },
    jobManager: { abortJob: () => false } }, TASK_ID);
  expect(result).toEqual({ ok: false, status: "running",
    message: "Task is still waiting for its safe checkpoint before it can resume." });
  expect(resumed).toEqual([]);
  expect(task.pauseRequestId).toBe(REQUEST_ID);
  expect(kicks).toBe(1);
});

test("caller-funded protected resume requests fresh admission without reading content or funding outside a grant", async () => {
  task = protectedTask({ status: "paused", fundingMode: "caller", pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  let kicks = 0;
  const result = await unpauseTask({ db, observer: { kick: () => { kicks += 1; } },
    jobManager: { abortJob: () => false } }, TASK_ID);
  expect(result).toEqual({ ok: true, status: "awaiting", message: "Task resumed." });
  expect(resumed).toHaveLength(1);
  expect(kicks).toBe(1);
  expect(contentReads).toBe(0);
  expect(fundingChecks).toBe(0);
});

test("protected resume retains local recapture and uncertain-outcome controls without exposing content", async () => {
  task = protectedTask({ status: "paused", pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause",
    localExecutionDelegation: null, lastError: database.TASK_LOCAL_EXECUTION_RECREATE_TEXT });
  expect((await unpauseTask({ db, jobManager: { abortJob: () => false } }, TASK_ID)).ok).toBe(false);
  expect(resumed).toEqual([]);
  task = { ...task, lastError: "funding_interrupted_uncertain" };
  expect((await unpauseTask({ db, jobManager: { abortJob: () => false } }, TASK_ID)).ok).toBe(false);
  expect(resumed).toEqual([]);
  expect(contentReads).toBe(0);
  expect(fundingChecks).toBe(0);
});

test("a protected resume race cannot clear a pause request that is no longer settled", async () => {
  task = protectedTask({ status: "paused", pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  protectedResumeResult = "pending";
  let kicks = 0;
  const result = await unpauseTask({ db, observer: { kick: () => { kicks += 1; } },
    jobManager: { abortJob: () => false } }, TASK_ID);
  expect(result).toEqual({ ok: false, status: "paused",
    message: "Task is still waiting for its safe checkpoint before it can resume." });
  expect(resumed).toEqual([{ taskId: TASK_ID, requesterUserId: OWNER_ID,
    pauseRequestId: REQUEST_ID }]);
  expect(task.pauseRequestId).toBe(REQUEST_ID);
  expect(updateCalls).toBe(0);
  expect(kicks).toBe(1);
});

test("a locked recapture race keeps the protected pause intent and returns the recapture message", async () => {
  task = protectedTask({ status: "paused", pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  protectedResumeResult = "recapture_required";
  beforeProtectedResume = () => {
    task = { ...task, localExecutionDelegation: null,
      lastError: database.TASK_LOCAL_EXECUTION_RECREATE_TEXT };
  };

  expect(await unpauseTask({ db, jobManager: { abortJob: () => false } }, TASK_ID)).toEqual({
    ok: false,
    status: "paused",
    message: database.TASK_LOCAL_EXECUTION_RECREATE_TEXT,
  });
  expect(task.pauseRequestId).toBe(REQUEST_ID);
  expect(contentReads).toBe(0);
  expect(fundingChecks).toBe(0);
});

test("a locked uncertain-funding race keeps the protected pause intent and returns the funding message", async () => {
  task = protectedTask({ status: "paused", pauseRequestId: REQUEST_ID,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"), pauseReason: "manual_pause" });
  protectedResumeResult = "funding_uncertain";
  beforeProtectedResume = () => {
    task = { ...task, lastError: "funding_interrupted_uncertain" };
  };

  expect(await unpauseTask({ db, jobManager: { abortJob: () => false } }, TASK_ID)).toEqual({
    ok: false,
    status: "paused",
    message: "The previous provider outcome is uncertain. Review its saved result and start a fresh Task.",
  });
  expect(task.pauseRequestId).toBe(REQUEST_ID);
  expect(contentReads).toBe(0);
  expect(fundingChecks).toBe(0);
});

test("ordinary pause keeps the existing atomic transition and abort path", async () => {
  task = protectedTask({ contentRepresentation: "ordinary" });
  const aborts: unknown[] = [];
  const protectedPauses: unknown[] = [];
  expect(await pauseTask({ db, jobManager: {
    abortJob: (...args) => { aborts.push(args); return true; },
    requestProtectedTaskCheckpointPauseAndWait: async input => {
      protectedPauses.push(input);
      return { status: "settled" };
    },
  } }, TASK_ID)).toEqual({ ok: true, status: "paused", message: "Task paused." });
  expect(transitionCalls).toBe(1);
  expect(aborts).toEqual([[JOB_A, "pause", { taskId: TASK_ID, taskRunId: RUN_A }]]);
  expect(protectedPauses).toEqual([]);
  expect(requested).toEqual([]);
});

test("an ordinary read racing a protected conversion falls through to cooperative checkpoint pause", async () => {
  const lockedProtected = protectedTask();
  task = lockedProtected;
  taskReads.push(protectedTask({
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
  }));
  transitionOverride = {
    task: undefined,
    run: undefined,
    protectedTask: lockedProtected,
    transitioned: false,
    outcome: "protected_checkpoint_required",
  };
  protectedRequestResult = requestResult([
    { taskRunId: RUN_A, jobId: JOB_A, graphThreadId: "thread:a", status: "running" },
  ]);
  const checkpointCalls: unknown[] = [];
  let aborts = 0;

  expect(await pauseTask({ db, jobManager: {
    abortJob: () => { aborts += 1; return false; },
    requestProtectedTaskCheckpointPauseAndWait: async input => {
      checkpointCalls.push(input);
      return { status: "settled" };
    },
  } }, TASK_ID)).toEqual({ ok: true, status: "paused", message: "Task paused." });
  expect(transitionCalls).toBe(1);
  expect(requested).toHaveLength(1);
  expect(checkpointCalls).toEqual([{
    taskId: TASK_ID,
    taskRunId: RUN_A,
    jobId: JOB_A,
    pauseRequestId: REQUEST_ID,
    reason: "manual_pause",
  }]);
  expect(finalized).toEqual([{ taskId: TASK_ID, pauseRequestId: REQUEST_ID }]);
  expect(aborts).toBe(0);
});
