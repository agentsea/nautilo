import { beforeEach, expect, mock, test } from "bun:test";

const transitionInputs: unknown[] = [];
const task: {
  id: string;
  ownerId: string;
  requestorId: string;
  status: string;
  metadata: Record<string, unknown>;
  contentRepresentation: "ordinary" | "dual" | "protected";
} = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "40000000-0000-4000-8000-000000000004",
  requestorId: "40000000-0000-4000-8000-000000000004",
  status: "cancelled",
  metadata: {},
  contentRepresentation: "ordinary",
};
let transitionTask = task;
let transitionRun: typeof run | undefined;
let transitioned: boolean;
let transitionOutcome: string;
const run = {
  id: "20000000-0000-4000-8000-000000000002",
  taskId: task.id,
  jobId: "30000000-0000-4000-8000-000000000003",
  status: "cancelled",
};

const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  getLatestResumableTaskRun: async () => undefined,
  getTaskById: async () => undefined,
  getTaskByIdWithMutationVersion: async () => undefined,
  updateTaskIfCurrent: async () => undefined,
  transitionTaskLifecyclePaused: async () => ({
    task: undefined,
    run: undefined,
    transitioned: false,
    outcome: "not_found",
  }),
  transitionTaskLifecycleTerminal: async (_db: unknown, input: unknown) => {
    transitionInputs.push(input);
    return {
      task: transitionTask,
      run: transitionRun,
      transitioned,
      outcome: transitionOutcome,
    };
  },
  updateTask: async () => undefined,
}));

const { stopTask } = await import("../../src/tasks/lifecycle");

beforeEach(() => {
  transitionInputs.length = 0;
  transitionTask = task;
  transitionRun = run;
  transitioned = true;
  transitionOutcome = "transitioned";
});

test("stopTask forwards the exact Job authority and aborts only the transitioned run", async () => {
  const aborts: unknown[] = [];
  let observerKicks = 0;
  const result = await stopTask(
    {
      db: {} as never,
      jobManager: {
        abortJob: (jobId, reason, taskRun) => {
          aborts.push({ jobId, reason, taskRun });
          return false;
        },
      },
      observer: { kick: () => { observerKicks += 1; } },
      reportBackCancellation: async () => undefined,
    },
    task.id,
    {
      humanUserId: task.requestorId,
      taskRunId: run.id,
      jobId: run.jobId,
    },
  );

  expect(result).toMatchObject({ ok: true, status: "cancelled" });
  expect(transitionInputs).toEqual([expect.objectContaining({
    taskId: task.id,
    runId: run.id,
    expectedInvocation: {
      humanUserId: task.requestorId,
      taskRunId: run.id,
      jobId: run.jobId,
    },
  })]);
  expect(aborts).toEqual([{
    jobId: run.jobId,
    reason: "stop",
    taskRun: { taskId: task.id, taskRunId: run.id },
  }]);
  expect(observerKicks).toBe(0);
});

test("stopTask awaits exact protected process quiescence without ordinary report-back", async () => {
  transitionTask = {
    ...task,
    contentRepresentation: "protected",
  };
  const aborts: unknown[] = [];
  const protectedAborts: unknown[] = [];
  const reports: unknown[] = [];
  const order: string[] = [];

  const result = await stopTask(
    {
      db: {} as never,
      jobManager: {
        abortJob: (...args) => {
          aborts.push(args);
          return true;
        },
        abortProtectedTaskRunAndWait: async (input) => {
          order.push("abort");
          await Promise.resolve();
          protectedAborts.push(input);
          return { status: "stopped" };
        },
      },
      observer: { kick: () => { order.push("kick"); } },
      reportBackCancellation: async (...args) => {
        reports.push(args);
      },
    },
    task.id,
    {
      humanUserId: task.requestorId,
      taskRunId: run.id,
      jobId: run.jobId,
    },
  );

  expect(result).toMatchObject({ ok: true, status: "cancelled" });
  expect(protectedAborts).toEqual([{
    taskId: task.id,
    taskRunId: run.id,
    jobId: run.jobId,
  }]);
  expect(aborts).toEqual([]);
  expect(reports).toEqual([]);
  expect(order).toEqual(["kick", "abort"]);
});

test("stopTask kicks protected cancellation recovery on canonical cancelled replay", async () => {
  transitionTask = { ...task, contentRepresentation: "dual" };
  transitioned = false;
  transitionOutcome = "same_terminal";
  let observerKicks = 0;
  const aborts: unknown[] = [];

  const result = await stopTask({
    db: {} as never,
    jobManager: {
      abortJob: (...args) => {
        aborts.push(args);
        return true;
      },
      abortProtectedTaskRunAndWait: async (...args) => {
        aborts.push(args);
        return { status: "stopped" };
      },
    },
    observer: { kick: () => { observerKicks += 1; } },
  }, task.id, {
    humanUserId: task.requestorId,
    taskRunId: run.id,
    jobId: run.jobId,
  });

  expect(result).toEqual({
    ok: true,
    status: "cancelled",
    message: "Task is already cancelled.",
  });
  expect(observerKicks).toBe(1);
  expect(aborts).toEqual([]);
});

test("stopTask does not kick protected cancellation recovery after rejected authority", async () => {
  transitionTask = { ...task, contentRepresentation: "protected", status: "running" };
  transitionRun = undefined;
  transitioned = false;
  transitionOutcome = "authority_changed";
  let observerKicks = 0;

  const result = await stopTask({
    db: {} as never,
    jobManager: { abortJob: () => true },
    observer: { kick: () => { observerKicks += 1; } },
  }, task.id, {
    humanUserId: task.requestorId,
    taskRunId: run.id,
    jobId: run.jobId,
  });

  expect(result).toEqual({
    ok: false,
    status: "authority_changed",
    message: "Task invocation changed.",
  });
  expect(observerKicks).toBe(0);
});
