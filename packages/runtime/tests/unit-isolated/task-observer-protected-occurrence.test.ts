import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  DirectDatabase,
  PrepareClaimedProtectedTaskOccurrenceInput,
  PrepareClaimedProtectedTaskOccurrenceResult,
  ProtectedAwaitingTaskRunCursor,
  Task,
  TaskRun,
} from "@nautilo/db";
import type {
  ProtectedTaskOccurrenceOwner,
  ProtectedTaskOccurrencePort,
} from "../../src/tasks/task-observer";

const database = await import("@nautilo/db");
const claimPlain = mock(async (
  _db: DirectDatabase,
  _now: Date,
  _batch: number,
): Promise<Task[]> => []);
const claimProtected = mock(async (
  _db: DirectDatabase,
  _now: Date,
  _batch: number,
): Promise<Task[]> => []);
const listAwaiting = mock(async (
  _db: DirectDatabase,
  _batch: number,
  _after?: ProtectedAwaitingTaskRunCursor,
): Promise<Array<{ task: Task; run: TaskRun }>> => []);
// These occurrence fixtures contain no delegated executions waiting for a Mac.
const listOfflineWaits = mock(async (
  _db: DirectDatabase,
  _input: { limit: number; afterTaskId?: string },
): ReturnType<typeof database.listTaskLocalExecutionOfflineWaits> => []);
const prepareProtected = mock(async (
  _db: DirectDatabase,
  _input: PrepareClaimedProtectedTaskOccurrenceInput,
): Promise<PrepareClaimedProtectedTaskOccurrenceResult> => ({ status: "stale" }));
const reschedule = mock(async (_db: DirectDatabase, _taskId: string, _next: Date) => {});
const timedOut = mock(async (
  _db: DirectDatabase,
  _now: Date,
): ReturnType<typeof database.findTimedOutRunningTasks> => []);
const interruptedBoundary = mock(async (
  _db: DirectDatabase,
): Promise<{ startedAt: string; runId: string } | undefined> => undefined);
const listInterrupted = mock(async (
  _db: DirectDatabase,
  _options: {
    limit: number;
    through: { startedAt: string; runId: string };
    after?: { startedAt: string; runId: string };
  },
): Promise<Array<{
  task: Task;
  run: TaskRun;
  cursor: { startedAt: string; runId: string };
}>> => []);
const reconcileInterrupted = mock(async (
  _db: DirectDatabase,
  _input: { taskId: string; taskRunId: string },
) => ({ transitioned: true }));
const listWriterReviews = mock(async (
  _db: DirectDatabase,
  _input: Parameters<typeof database.listAwaitingWriterReviewTasks>[1],
): ReturnType<typeof database.listAwaitingWriterReviewTasks> => []);
const listPendingWriterReviews = mock(async (
  _db: DirectDatabase,
  _input: Parameters<typeof database.listPendingWriterReviewVerificationTasks>[1],
): ReturnType<typeof database.listPendingWriterReviewVerificationTasks> => []);
const listRunningWriterReviews = mock(async (
  _db: DirectDatabase,
  _input: Parameters<typeof database.listRunningWriterReviewVerificationTasks>[1],
): ReturnType<typeof database.listRunningWriterReviewVerificationTasks> => []);
mock.module("@nautilo/db", () => ({
  ...database,
  clearStaleFireLocks: async () => 0,
  claimDueTasks: claimPlain,
  claimDueProtectedTasks: claimProtected,
  listProtectedAwaitingTaskRunsForAuthorization: listAwaiting,
  listTaskLocalExecutionOfflineWaits: listOfflineWaits,
  prepareClaimedProtectedTaskOccurrence: prepareProtected,
  rescheduleCron: reschedule,
  findTimedOutRunningTasks: timedOut,
  getCallerFundedRunningTaskRunRestartBoundary: interruptedBoundary,
  listCallerFundedRunningTaskRunsForRestart: listInterrupted,
  reconcileCallerFundedTaskRunAfterRestart: reconcileInterrupted,
  listAwaitingWriterReviewTasks: listWriterReviews,
  listPendingWriterReviewVerificationTasks: listPendingWriterReviews,
  listRunningWriterReviewVerificationTasks: listRunningWriterReviews,
}));

const ordinaryDispatch = mock(async (_task: Task, _deps: unknown) => ({
  kind: "dispatched" as const,
}));
mock.module("../../src/tasks/dispatch-task-run", () => ({
  dispatchTaskRun: ordinaryDispatch,
}));

const dispatchError = mock(async () => {});
const taskError = mock(async () => {});
mock.module("../../src/tasks/report-back", () => ({
  reportBackTaskDispatchError: dispatchError,
  reportBackTaskError: taskError,
  reportBackTaskWriterReviewVerificationLostOnRestart: async () => {},
  SAFE_WRITER_REVIEW_FAILED_RESULT: "Writer review failed",
  SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT: "Writer verification lost",
}));
mock.module("../../src/tasks/security-report-recovery", () => ({
  resumeReconnectedSecurityResearch: async () => {},
}));
const pause = mock(async (_deps: unknown, _taskId: string, _reason: string) => ({
  ok: true,
  status: "paused",
  message: "Task paused.",
}));
mock.module("../../src/tasks/lifecycle", () => ({ pauseTask: pause }));

const { TaskObserver } = await import("../../src/tasks/task-observer");

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const TASK_ID = "40000000-0000-4000-8000-000000000004";
const NAMESPACE_ID = "50000000-0000-4000-8000-000000000005";
const EXISTING_RUN_ID = "60000000-0000-4000-8000-000000000006";
const SENTINEL = "PROTECTED_TASK_PLAINTEXT_SENTINEL";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    ownerId: OWNER_ID,
    requestorId: REQUESTOR_ID,
    agentId: AGENT_ID,
    prompt: SENTINEL,
    expectedOutput: SENTINEL,
    scheduleKind: "cron",
    cron: "0 9 * * *",
    timezone: "UTC",
    callingRoomId: null,
    status: "pending",
    nextFireAt: new Date("2026-09-01T09:00:00.000Z"),
    fireLockId: "70000000-0000-4000-8000-000000000007",
    metadata: { sentinel: SENTINEL },
    contentRepresentation: "dual",
    contentNamespaceId: NAMESPACE_ID,
    contentRevision: 3,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 4,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(8),
    cryptoMappingState: "verified",
    fundingMode: "legacy_server",
    ...overrides,
  } as Task;
}

function run(id = EXISTING_RUN_ID): TaskRun {
  return {
    id,
    taskId: TASK_ID,
    jobId: null,
    graphThreadId: `subagent:task:${TASK_ID}:${id}`,
    status: "awaiting",
    fundingBinding: null,
    fundingPredecessorRunId: null,
    startedAt: new Date("2026-09-01T09:00:01.000Z"),
  } as TaskRun;
}

function restartCursor(candidate: TaskRun): { startedAt: string; runId: string } {
  return { startedAt: candidate.startedAt.toISOString(), runId: candidate.id };
}

function currentOwner(port: ProtectedTaskOccurrencePort) {
  const withCurrentSpy = mock(() => {});
  const owner: ProtectedTaskOccurrenceOwner = {
    async withCurrent<Result>(
      use: (current: ProtectedTaskOccurrencePort) => Promise<Result>,
    ): Promise<Result | null> {
      withCurrentSpy();
      return use(port);
    },
  };
  return { owner, withCurrentSpy };
}

const acceptingGate = {
  isAcceptingWork: async () => true,
  assertAcceptingNewWork: async () => {},
};
const jobManager = {
  createForegroundJob: async () => ({ id: randomUUID(), virtualJobId: randomUUID() }),
  abortJob: () => false,
};

beforeEach(() => {
  for (const fn of [
    claimPlain,
    claimProtected,
    listAwaiting,
    listOfflineWaits,
    prepareProtected,
    reschedule,
    timedOut,
    interruptedBoundary,
    listInterrupted,
    reconcileInterrupted,
    listWriterReviews,
    listPendingWriterReviews,
    listRunningWriterReviews,
    ordinaryDispatch,
    dispatchError,
    taskError,
    pause,
  ]) fn.mockClear();
  claimPlain.mockImplementation(async () => []);
  claimProtected.mockImplementation(async () => []);
  listAwaiting.mockImplementation(async () => []);
  listOfflineWaits.mockImplementation(async () => []);
  prepareProtected.mockImplementation(async () => ({ status: "stale" as const }));
  timedOut.mockImplementation(async () => []);
  pause.mockImplementation(async () => ({
    ok: true,
    status: "paused",
    message: "Task paused.",
  }));
  interruptedBoundary.mockImplementation(async () => undefined);
  ordinaryDispatch.mockImplementation(async () => ({ kind: "dispatched" as const }));
  listInterrupted.mockImplementation(async () => []);
  reconcileInterrupted.mockImplementation(async () => ({ transitioned: true }));
  listWriterReviews.mockImplementation(async () => []);
  listPendingWriterReviews.mockImplementation(async () => []);
  listRunningWriterReviews.mockImplementation(async () => []);
});

test("startup reconciles caller-funded running runs in bounded keyset pages", async () => {
  const firstRun = {
    ...run("60000000-0000-4000-8000-000000000006"),
    status: "running",
    startedAt: new Date("2026-09-01T09:00:01.000Z"),
  } as TaskRun;
  const secondRun = {
    ...run("60000000-0000-4000-8000-000000000007"),
    status: "running",
    startedAt: new Date("2026-09-01T09:00:02.000Z"),
  } as TaskRun;
  const callerTask = task({ status: "running", fundingMode: "caller" });
  interruptedBoundary.mockImplementation(async () => restartCursor(secondRun));
  listInterrupted.mockImplementation(async (_db, options) => {
    if (!options.after) return [
      { task: callerTask, run: firstRun, cursor: restartCursor(firstRun) },
      { task: callerTask, run: secondRun, cursor: restartCursor(secondRun) },
    ];
    return [];
  });
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    batch: 2,
    intervalMs: 60_000,
  });

  await observer.start();
  await observer.stop();

  expect(reconcileInterrupted.mock.calls.map((call) => call[1])).toEqual([
    { taskId: TASK_ID, taskRunId: firstRun.id },
    { taskId: TASK_ID, taskRunId: secondRun.id },
  ]);
  expect(listInterrupted).toHaveBeenCalledTimes(2);
  expect(listInterrupted.mock.calls[1]?.[1]).toMatchObject({
    limit: 2,
    through: restartCursor(secondRun),
    after: restartCursor(secondRun),
  });
  expect(interruptedBoundary).toHaveBeenCalledTimes(1);
});

test("startup retries a failed caller-funded reconciliation before claiming fresh work", async () => {
  const interruptedRun = {
    ...run("60000000-0000-4000-8000-000000000006"),
    status: "running",
    startedAt: new Date("2026-09-01T09:00:01.000Z"),
  } as TaskRun;
  const callerTask = task({ status: "running", fundingMode: "caller" });
  interruptedBoundary.mockImplementation(async () => restartCursor(interruptedRun));
  listInterrupted.mockImplementation(async (_db, options) => options.after
    ? []
    : [{ task: callerTask, run: interruptedRun, cursor: restartCursor(interruptedRun) }]);
  let attempts = 0;
  const order: string[] = [];
  reconcileInterrupted.mockImplementation(async () => {
    attempts += 1;
    order.push(`reconcile-${attempts}`);
    if (attempts === 1) throw new Error("transient restart reconciliation failure");
    return { transitioned: true };
  });
  claimPlain.mockImplementation(async () => {
    order.push("claim");
    return [];
  });
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    intervalMs: 60_000,
  });

  await observer.start();
  await observer.stop();

  expect(order).toEqual(["reconcile-1", "reconcile-2", "claim"]);
  expect(reconcileInterrupted).toHaveBeenCalledTimes(2);
  expect(listInterrupted.mock.calls[0]?.[1].through)
    .toBe(listInterrupted.mock.calls[1]?.[1].through);
  expect(interruptedBoundary).toHaveBeenCalledTimes(1);
});

test("strict policy defers ordinary restart repair until fallback and drains it before claims", async () => {
  let ordinaryAllowed = false;
  let ordinaryCurrent = false;
  const order: string[] = [];
  const ordinaryOwner = {
    async withCurrent<Result>(use: () => Promise<Result>): Promise<Result | null> {
      if (!ordinaryAllowed) return null;
      ordinaryCurrent = true;
      try { return await use(); } finally { ordinaryCurrent = false; }
    },
  };
  interruptedBoundary.mockImplementation(async () => {
    expect(ordinaryCurrent).toBeTrue();
    order.push("caller-recovery");
    return undefined;
  });
  listWriterReviews.mockImplementation(async () => {
    expect(ordinaryCurrent).toBeTrue();
    order.push("writer-awaiting-recovery");
    return [];
  });
  listPendingWriterReviews.mockImplementation(async () => {
    expect(ordinaryCurrent).toBeTrue();
    order.push("writer-pending-recovery");
    return [];
  });
  listRunningWriterReviews.mockImplementation(async () => {
    expect(ordinaryCurrent).toBeTrue();
    order.push("writer-running-recovery");
    return [];
  });
  claimPlain.mockImplementation(async () => {
    expect(ordinaryCurrent).toBeTrue();
    order.push("ordinary-claim");
    return [];
  });
  const protectedOwner = currentOwner({ observeProtectedTaskOccurrence: async () => {} });
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    intervalMs: 60_000,
    ordinaryOccurrencePort: ordinaryOwner,
    protectedOccurrencePort: protectedOwner.owner,
  });

  await observer.start();
  expect(interruptedBoundary).not.toHaveBeenCalled();
  expect(listWriterReviews).not.toHaveBeenCalled();
  expect(claimPlain).not.toHaveBeenCalled();
  expect(claimProtected).toHaveBeenCalledTimes(1);

  ordinaryAllowed = true;
  await observer.tick();
  await observer.tick();
  await observer.stop();

  expect(order).toEqual([
    "caller-recovery",
    "writer-awaiting-recovery",
    "writer-pending-recovery",
    "writer-running-recovery",
    "ordinary-claim",
    "ordinary-claim",
  ]);
  expect(interruptedBoundary).toHaveBeenCalledTimes(1);
  expect(listWriterReviews).toHaveBeenCalledTimes(1);
  expect(listPendingWriterReviews).toHaveBeenCalledTimes(1);
  expect(listRunningWriterReviews).toHaveBeenCalledTimes(1);
});

test("without a protected port the ordinary observer is unchanged", async () => {
  const ordinary = task({
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
    scheduleKind: "now",
    cron: null,
  });
  claimPlain.mockImplementation(async () => [ordinary]);
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
  });

  await observer.tick();

  expect(ordinaryDispatch).toHaveBeenCalledTimes(1);
  expect(ordinaryDispatch.mock.calls[0]?.[0]).toBe(ordinary);
  expect(listOfflineWaits).toHaveBeenCalledTimes(1);
  expect(claimProtected).not.toHaveBeenCalled();
  expect(listAwaiting).not.toHaveBeenCalled();
  expect(prepareProtected).not.toHaveBeenCalled();
});

test("a recovery-only protected port never claims or prepares due initial work", async () => {
  const ordinary = task({
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
    scheduleKind: "now",
    cron: null,
  });
  const dueProtected = task();
  const existingTask = task({
    status: "awaiting",
    fireLockId: null,
    nextFireAt: null,
  });
  const existingRun = run();
  claimPlain.mockImplementation(async () => [ordinary]);
  claimProtected.mockImplementation(async () => [dueProtected]);
  listAwaiting.mockImplementation(async () => [{
    task: existingTask,
    run: existingRun,
  }]);
  const recoveryPort = {
    recoverBeforeObservation: mock(async (_limit: number) => {
      expect(listAwaiting).not.toHaveBeenCalled();
    }),
    observeProtectedTaskOccurrence: mock(async (_occurrence: unknown) => {}),
  };
  const recoveryOwner = currentOwner(recoveryPort);
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    protectedOccurrenceRecoveryPort: recoveryOwner.owner,
  });

  await observer.tick();

  expect(ordinaryDispatch).toHaveBeenCalledTimes(1);
  expect(ordinaryDispatch.mock.calls[0]?.[0]).toBe(ordinary);
  expect(listAwaiting).toHaveBeenCalledTimes(1);
  expect(recoveryOwner.withCurrentSpy).toHaveBeenCalledTimes(1);
  expect(recoveryPort.recoverBeforeObservation).toHaveBeenCalledTimes(1);
  expect(recoveryPort.recoverBeforeObservation.mock.calls[0]?.[0]).toBeGreaterThan(0);
  expect(recoveryPort.observeProtectedTaskOccurrence).toHaveBeenCalledTimes(1);
  expect(recoveryPort.observeProtectedTaskOccurrence.mock.calls[0]?.[0])
    .toMatchObject({ task: { id: TASK_ID }, run: { id: EXISTING_RUN_ID } });
  expect(claimProtected).not.toHaveBeenCalled();
  expect(prepareProtected).not.toHaveBeenCalled();
});

test("ordinary policy refusal leaves ordinary claims untouched and still observes protected work", async () => {
  const { owner } = currentOwner({ observeProtectedTaskOccurrence: async () => {} });
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    ordinaryOccurrencePort: { withCurrent: () => Promise.resolve(null) },
    protectedOccurrencePort: owner,
  });
  await observer.tick();
  expect(listOfflineWaits).not.toHaveBeenCalled();
  expect(claimPlain).not.toHaveBeenCalled();
  expect(ordinaryDispatch).not.toHaveBeenCalled();
  expect(claimProtected).toHaveBeenCalledTimes(1);
});

test("ordinary claims and dispatch remain inside their current owner", async () => {
  let current = false;
  claimPlain.mockImplementation(async () => {
    expect(current).toBeTrue();
    return [task({ contentRepresentation: "ordinary" })];
  });
  ordinaryDispatch.mockImplementation(async () => {
    expect(current).toBeTrue();
    return { kind: "dispatched" as const };
  });
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    ordinaryOccurrencePort: {
      async withCurrent<Result>(use: () => Promise<Result>): Promise<Result> {
        current = true;
        try { return await use(); } finally { current = false; }
      },
    },
  });
  await observer.tick();
  expect(current).toBeFalse();
  expect(claimPlain).toHaveBeenCalledTimes(1);
  expect(ordinaryDispatch).toHaveBeenCalledTimes(1);
  expect(reschedule).toHaveBeenCalledTimes(1);
  expect(claimProtected).not.toHaveBeenCalled();
});

test.each(["dual", "protected"] as const)(
  "%s occurrences preserve fire identity, skip downtime backlog, and retry only through the current port",
  async (contentRepresentation) => {
    const scheduledFor = new Date("2026-09-01T09:00:00.000Z");
    const claimed = task({ contentRepresentation, nextFireAt: scheduledFor });
    const existingTask = task({
      contentRepresentation,
      status: "awaiting",
      fireLockId: null,
      nextFireAt: null,
    });
    const existingRun = run();
    let protectedClaims = 0;
    claimProtected.mockImplementation(async () => {
      protectedClaims += 1;
      return protectedClaims === 1 ? [claimed] : [];
    });
    listAwaiting.mockImplementation(async () => [{ task: existingTask, run: existingRun }]);
    prepareProtected.mockImplementation(async (_db, input) => ({
      status: "prepared" as const,
      task: task({
        status: "pending",
        fireLockId: null,
        nextFireAt: input.cronNextFireAt!,
        lastFiredAt: input.scheduledFor,
      }),
      run: run(input.taskRunId),
    }));
    const observed: unknown[] = [];
    let existingAttempts = 0;
    const port = {
      observeProtectedTaskOccurrence: mock(async (occurrence: unknown) => {
        observed.push(occurrence);
        const candidate = occurrence as { run: { id: string } };
        if (candidate.run.id === EXISTING_RUN_ID && existingAttempts++ === 0) {
          throw new Error(SENTINEL);
        }
      }),
    };
    const owner = currentOwner(port);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const observer = new TaskObserver({
      db: {} as never,
      jobManager: jobManager as never,
      maintenanceGate: acceptingGate,
      now: () => new Date("2026-09-23T12:00:00.000Z"),
      protectedOccurrencePort: owner.owner,
    });

    try {
      await observer.tick();
      await observer.tick();

      expect(prepareProtected).toHaveBeenCalledTimes(1);
      expect(owner.withCurrentSpy).toHaveBeenCalledTimes(4);
      const preparation = prepareProtected.mock.calls[0]?.[1];
      expect(preparation).toMatchObject({
        taskId: TASK_ID,
        scheduledFor,
        cronNextFireAt: new Date("2026-09-24T09:00:00.000Z"),
      });
      expect(preparation?.taskRunId).toMatch(/^[0-9a-f-]{36}$/);
      expect(preparation?.graphThreadId).toMatch(
        new RegExp(`^subagent:task:${TASK_ID}:[0-9a-f-]{36}$`),
      );
      expect(existingAttempts).toBe(2);
      expect(observed).toHaveLength(3);
      expect(JSON.stringify(observed)).not.toContain(SENTINEL);
      expect(Object.keys((observed[0] as { task: object }).task).sort()).toEqual([
        "agentId",
        "callingRoomId",
        "contentNamespaceId",
        "contentRepresentation",
        "contentRevision",
        "cryptoAccessRevision",
        "cryptoObjectId",
        "cryptoRequiredNamespaceFingerprint",
        "id",
        "ownerId",
        "requestorId",
        "scheduleKind",
      ]);
      expect(ordinaryDispatch).not.toHaveBeenCalled();
      expect(dispatchError).not.toHaveBeenCalled();
      expect(taskError).not.toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SENTINEL);
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("PROTECTED_PORT_RETRY")))
        .toBeTrue();
    } finally {
      errorSpy.mockRestore();
    }
  },
);

test("inactive current policy leaves retained protected rows untouched", async () => {
  const retainedTask = task();
  const retainedRun = run();
  const port = {
    recoverBeforeObservation: mock(async (_limit: number) => {}),
    observeProtectedTaskOccurrence: mock(async (_occurrence: unknown) => {}),
  };
  const owner = {
    withCurrent: mock(async (_use: (current: typeof port) => Promise<unknown>) => null),
  };
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    protectedOccurrencePort: owner,
  });

  await observer.tick();

  expect(owner.withCurrent).toHaveBeenCalledTimes(2);
  expect(claimProtected).not.toHaveBeenCalled();
  expect(listAwaiting).not.toHaveBeenCalled();
  expect(prepareProtected).not.toHaveBeenCalled();
  expect(port.recoverBeforeObservation).not.toHaveBeenCalled();
  expect(port.observeProtectedTaskOccurrence).not.toHaveBeenCalled();
  expect(retainedTask.status).toBe("pending");
  expect(retainedRun.status).toBe("awaiting");
});

test("current policy failure denies protected discovery and claim before durable access", async () => {
  const owner = {
    withCurrent: mock(async (_use: (current: never) => Promise<unknown>) => {
      throw new Error("policy unavailable");
    }),
  };
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    protectedOccurrencePort: owner,
  });

  try {
    await observer.tick();

    expect(owner.withCurrent).toHaveBeenCalledTimes(2);
    expect(claimProtected).not.toHaveBeenCalled();
    expect(listAwaiting).not.toHaveBeenCalled();
    expect(prepareProtected).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("PROTECTED_RECOVERY_QUERY_RETRY")
    )).toBeTrue();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("PROTECTED_CLAIM_RETRY")
    )).toBeTrue();
  } finally {
    errorSpy.mockRestore();
  }
});

test("current ownership stays live through discovery, preparation, and observation", async () => {
  let current = false;
  const claimed = task();
  claimProtected.mockImplementation(async () => {
    expect(current).toBeTrue();
    return [claimed];
  });
  listAwaiting.mockImplementation(async () => {
    expect(current).toBeTrue();
    return [];
  });
  prepareProtected.mockImplementation(async (_db, input) => {
    expect(current).toBeTrue();
    return {
      status: "prepared" as const,
      task: task({ status: "awaiting", fireLockId: null, nextFireAt: null }),
      run: run(input.taskRunId),
    };
  });
  const port = {
    recoverBeforeObservation: mock(async (_limit: number) => {
      expect(current).toBeTrue();
    }),
    observeProtectedTaskOccurrence: mock(async (_occurrence: unknown) => {
      expect(current).toBeTrue();
    }),
  };
  const withCurrentSpy = mock(() => {});
  const owner: ProtectedTaskOccurrenceOwner = {
    async withCurrent<Result>(
      use: (currentPort: ProtectedTaskOccurrencePort) => Promise<Result>,
    ): Promise<Result | null> {
      withCurrentSpy();
      expect(current).toBeFalse();
      current = true;
      try {
        return await use(port);
      } finally {
        current = false;
      }
    },
  };
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
    protectedOccurrencePort: owner,
  });

  await observer.tick();

  expect(current).toBeFalse();
  expect(withCurrentSpy).toHaveBeenCalledTimes(2);
  expect(prepareProtected).toHaveBeenCalledTimes(1);
  expect(port.observeProtectedTaskOccurrence).toHaveBeenCalledTimes(1);
});

test.each(["dual", "protected"] as const)(
  "%s timeout failure never inspects raw error diagnostics",
  async (contentRepresentation) => {
    const protectedTask = task({ contentRepresentation, status: "running" });
    timedOut.mockImplementation(async () => [{ task: protectedTask, run: run() }]);
    let diagnosticInspected = false;
    const failure = new Error();
    Object.defineProperty(failure, "message", {
      get() {
        diagnosticInspected = true;
        return SENTINEL;
      },
    });
    pause.mockImplementation(async () => { throw failure; });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const observer = new TaskObserver({
      db: {} as never,
      jobManager: jobManager as never,
      maintenanceGate: acceptingGate,
    });
    try {
      await observer.tick();
      expect(pause).toHaveBeenCalledWith(expect.anything(), TASK_ID, "time_limit");
      expect(diagnosticInspected).toBe(false);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SENTINEL);
      expect(errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("PROTECTED_TIME_LIMIT_PAUSE_RETRY"))).toBeTrue();
    } finally {
      errorSpy.mockRestore();
    }
  },
);

test("protected timeout reports pending until durable settlement is complete", async () => {
  timedOut.mockImplementation(async () => [{
    task: task({ contentRepresentation: "protected", status: "running" }),
    run: run(),
  }]);
  pause.mockImplementation(async () => ({
    ok: true,
    status: "running",
    message: "Task pause requested; waiting for a safe checkpoint.",
  }));
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
  });
  try {
    await observer.tick();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("PROTECTED_TIME_LIMIT_SETTLEMENT_PENDING"))).toBeTrue();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("time-limit reached → paused"))).toBeFalse();
  } finally {
    errorSpy.mockRestore();
  }
});

test("ordinary timeout failure preserves its existing diagnostic", async () => {
  timedOut.mockImplementation(async () => [{
    task: task({ contentRepresentation: "ordinary", status: "running" }),
    run: run(),
  }]);
  pause.mockImplementation(async () => { throw new Error("ordinary failure"); });
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const observer = new TaskObserver({
    db: {} as never,
    jobManager: jobManager as never,
    maintenanceGate: acceptingGate,
  });
  try {
    await observer.tick();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes(
        `time-limit pause failed for task=${TASK_ID}: ordinary failure`,
      ))).toBeTrue();
    expect(errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("PROTECTED_TIME_LIMIT_PAUSE_RETRY"))).toBeFalse();
  } finally {
    errorSpy.mockRestore();
  }
});
