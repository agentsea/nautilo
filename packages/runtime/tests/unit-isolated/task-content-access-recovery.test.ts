import { beforeEach, expect, mock, test } from "bun:test";
import type { DirectDatabase, Task, TaskRun, PersistedJobRecord } from "@nautilo/db";
import type { OrdinaryContentAccessRecoveryCoordinate } from "@nautilo/agent";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";
import { InMemoryLaneLock } from "../../src/lane-lock";

const database = await import("@nautilo/db");
const agent = await import("@nautilo/agent");
let task: Task;
let run: TaskRun;
let available = true;
let advance: (() => Promise<void>) | undefined;
let reparked = false;
let liveWorker = false;
let originalStatus: PersistedJobRecord["status"] = "failed";
const completed = mock(async () => { task.status = "completed"; run.status = "completed"; });
const failure = mock(async () => {});
const transitions = mock(async (_db: unknown, input: { taskId: string; runId: string; from: string; to: TaskRun["status"]; requireLatestRun?: boolean }) => {
  if (task.status !== input.from || run.status !== input.from || run.id !== input.runId) return false;
  task.status = input.to as Task["status"]; run.status = input.to;
  return true;
});
const repair = mock(async () => {
  if (task.status !== "running" || run.status !== "running" || run.id !== "run") return false;
  task.status = "awaiting"; run.status = "awaiting"; return true;
});
mock.module("@nautilo/db", () => ({ ...database, getTaskById: async () => task, transitionTaskApprovalExecution: transitions,
  markTaskRunStatus: async (_db: unknown, _runId: string, status: TaskRun["status"], patch: { jobId?: string }) => {
    run.status = status; if (patch.jobId) run.jobId = patch.jobId;
  },
  repairTaskContentAccessRecovery: repair }));
const read = mock(async (scope: OrdinaryContentAccessRecoveryCoordinate) => available ? {
  ...scope, checkpointId: "checkpoint", turnId: run.id, toolCallId: "share",
} : null);
const resume = mock(async () => { await advance?.(); });
mock.module("@nautilo/agent", () => ({ ...agent, readOrdinaryContentAccessRecovery: read,
  resumeOrdinaryContentAccessRecovery: resume,
  inspectTaskResumeOutcome: async () => ({ reparked, finalText: "Task done" }),
}));
mock.module("../../src/executors/persisting-processor", () => ({ createPersistingProcessor: () => ({ process() {}, emit() {}, flush() {} }) }));
const reportBack = await import("../../src/tasks/report-back");
mock.module("../../src/tasks/report-back", () => ({ ...reportBack, reportBackTaskCompletion: completed,
  reportBackTaskError: failure, reportBackTaskCancellation: async () => {}, SAFE_BACKGROUND_TASK_FAILURE_RESULT: "Task failed" }));
const { discoverTaskContentAccessRecovery, runTaskContentAccessRecovery, parkTaskContentAccessRecovery } = await import("../../src/tasks/ordinary-content-access-recovery");
const { taskRunExecutor, _setTaskRunExecutorRunnerForTests } = await import("../../src/tasks/task-run-executor");
const { setTaskRunDb } = await import("../../src/tasks/task-runtime-context");
const db = { select: () => ({ from: (table: unknown) => {
  const rows = () => table === database.rooms ? [{ ownerId: "human", kind: "private" }] : [run];
  const query = { where: () => query, orderBy: () => query, limit: async () => rows() };
  return query;
} }) } as unknown as DirectDatabase;
const lock = new InMemoryLaneLock();
const admission = mock(async () => {});
const deps = { db, lock, assertInvocation: admission,
  actorForOwner: async () => ({ id: "actor" } as NonNullable<Awaited<ReturnType<typeof import("@nautilo/trust")["findActorByOwnerId"]>>>),
  graph: { ordinaryContentAccessForState: () => ({ mode: "plaintext_only" as const }) },
  manager: { hasTaskContentAccessRecoveryWorker: () => liveWorker,
    runResumeJobLifecycle: async (_scope: unknown, execute: (signal: AbortSignal) => Promise<void>) => execute(new AbortController().signal) },
  originalJob: async (): Promise<PersistedJobRecord> => ({ id: "original-job", ownerId: "human", requestorId: "human", status: originalStatus,
    laneKey: "task:task", type: "foreground", result: null, message: null, createdAt: new Date(), startedAt: new Date(), completedAt: new Date(),
    input: { taskId: "task", taskRunId: "run", graphThreadId: "thread", roomId: "room", agentId: "agent", ownerId: "human" } }),
};
const expected = { taskId: "task", taskRunId: "run", checkpointId: "checkpoint", toolCallId: "share" };
const authorities = { invocation: createAcceptedInvocationAuthority("human"), maintenance: createMaintenanceAcceptanceAuthority() };
beforeEach(() => {
  task = { id: "task", ownerId: "human", requestorId: "human", agentId: "agent", targetRoomId: "room",
    targetChat: "last_dm", status: "awaiting", metadata: {}, scheduleKind: "now" } as Task;
  run = { id: "run", taskId: "task", status: "awaiting", graphThreadId: "thread", jobId: "original-job" } as TaskRun;
  available = true; advance = undefined; reparked = false; liveWorker = false; originalStatus = "failed";
  for (const fn of [read, resume, completed, failure, transitions, admission, repair]) fn.mockClear();
});

test("restart discovery uses exact durable TaskRun and no public command/token", async () => {
  expect(await discoverTaskContentAccessRecovery("task", "human", deps)).toEqual(expected);
  expect(read.mock.calls[0]?.[0]).toMatchObject({ originalJobId: "original-job", graphThreadId: "thread", humanActorId: "actor",
    executionOwner: { kind: "task", taskId: "task", taskRunId: "run" } });
  expect(await discoverTaskContentAccessRecovery("task", "foreign", deps)).toBeNull();
  for (const status of ["completed", "cancelled", "errored", "paused"] as const) {
    task.status = status;
    expect(await discoverTaskContentAccessRecovery("task", "human", deps)).toBeNull();
  }
});

test("initial Task executor parks the typed uncertain failure before terminal reporting", async () => {
  task.status = "running"; run.status = "running";
  setTaskRunDb(db);
  _setTaskRunExecutorRunnerForTests(async () => { throw new agent.OrdinaryContentAccessRetryRequiredError(); });
  try {
    const events = [];
    for await (const event of taskRunExecutor({ taskId: "task", taskRunId: "run", ownerId: "human", graphThreadId: "thread",
      memoryAccessEnvelope: {}, roomId: "room", turnId: "run" }, "original-job", "task:task", new AbortController().signal)) events.push(event);
    expect(task.status as string).toBe("awaiting"); expect(run.status as string).toBe("awaiting");
    expect(run.id).toBe("run"); expect(run.jobId).toBe("original-job");
    expect(failure).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("worker.complete");
  } finally { _setTaskRunExecutorRunnerForTests(null); setTaskRunDb(null); }
});

test("same-Run worker claims exact latest pair, resumes once and uses existing completion owner", async () => {
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("completed");
  expect(resume).toHaveBeenCalledTimes(1);
  expect(completed).toHaveBeenCalledTimes(1);
  expect(failure).not.toHaveBeenCalled();
  expect(transitions.mock.calls[0]?.[1]).toMatchObject({ runId: "run", requireLatestRun: true, from: "awaiting", to: "running" });
  expect(run.id).toBe("run");
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("unavailable");
});

test("busy and supersession never execute; lock released after either result", async () => {
  const held = await lock.tryAcquire("thread");
  if (!held.acquired) throw new Error("fixture lock");
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("busy");
  await held.release();
  read.mockImplementationOnce(async () => null);
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("unavailable");
  expect(resume).not.toHaveBeenCalled();
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("completed");
});

test("crash after checkpoint before parking repairs only exact inactive running pair", async () => {
  task.status = "running"; run.status = "running";
  expect(await discoverTaskContentAccessRecovery("task", "human", deps)).toEqual(expected);
  expect(repair).not.toHaveBeenCalled();
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("completed");
  expect(repair).toHaveBeenCalledTimes(1); expect(run.id).toBe("run");
});

test("running repair rejects active worker, nonterminal original Job, Stop and newer Run", async () => {
  task.status = "running"; run.status = "running";
  liveWorker = true;
  expect(await discoverTaskContentAccessRecovery("task", "human", deps)).toBeNull();
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("busy");
  liveWorker = false; originalStatus = "running";
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("unavailable");
  originalStatus = "failed"; run.id = "newer";
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("unavailable");
  run.id = "run"; task.status = "cancelled";
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("unavailable");
  expect(repair).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
});

test("infrastructure failure during exact replay keeps unknown outcome recoverable", async () => {
  advance = async () => { throw new Error("checkpoint transport unavailable"); };
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("retry_required");
  expect(task.status).toBe("awaiting"); expect(failure).not.toHaveBeenCalled();
});

test("typed uncertainty reparks original run; explicit retry remains exact and generic failure never fires", async () => {
  advance = async () => { throw new agent.OrdinaryContentAccessRetryRequiredError(); };
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("retry_required");
  expect(task.status).toBe("awaiting"); expect(run.status).toBe("awaiting");
  expect(completed).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  advance = undefined;
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("completed");
  expect(run.id).toBe("run");
});

test("ordinary recovery can reach chained approval without claiming Task completion", async () => {
  reparked = true;
  expect(await runTaskContentAccessRecovery(expected, "human", authorities, deps)).toBe("completed");
  expect(task.status).toBe("awaiting"); expect(completed).not.toHaveBeenCalled();
});

test("parking suppresses generic terminalization when Stop already won; unrelated errors are not parked", async () => {
  task.status = "cancelled"; run.status = "cancelled";
  const input = { taskId: "task", taskRunId: "run", graphThreadId: "thread", ownerId: "human", error: new agent.OrdinaryContentAccessRetryRequiredError() };
  expect(await parkTaskContentAccessRecovery(db, input)).toEqual({ handled: true, parked: false });
  expect(task.status).toBe("cancelled");
  expect(await parkTaskContentAccessRecovery(db, { ...input, error: new Error("unrelated") })).toEqual({ handled: false, parked: false });
});
