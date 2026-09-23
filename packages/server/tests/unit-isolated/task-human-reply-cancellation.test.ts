import { beforeEach, expect, mock, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";
import { randomUUID } from "node:crypto";
import type { StreamEventProcessor } from "@nautilo/agent";

const database = await import("@nautilo/db");
const agent = await import("@nautilo/agent");
const trust = await import("@nautilo/trust");
let task: Task;
let run: TaskRun;
let signal: AbortSignal;
let finish: () => void;
let announce: () => void;
let started: Promise<void>;
let reparked = false;
let allowed = true;
let graphFailure = false;
let processor: StreamEventProcessor;
const completion = mock(async (..._args: unknown[]) => {});
const failure = mock(async (..._args: unknown[]) => { task = { ...task, status: "errored" }; run = { ...run, status: "errored" }; });
const baseProcess = mock(async (_event: unknown) => {});
const baseEmit = mock((_event: unknown) => {});
const chain = { from: () => chain, where: () => chain, limit: async () => [{ ownerId: "owner", kind: "room" }] };
// These ordinary reply fixtures have no Desktop-wait marker. Its guarded
// metadata update affects no rows; all lifecycle mutations use the doubles below.
const db = { select: () => chain, update: (table: unknown) => {
  expect(table).toBe(database.tasks);
  return { set: (patch: Record<string, unknown>) => {
    expect(Object.keys(patch).sort()).toEqual(["lastError", "updatedAt"]);
    expect(patch["lastError"]).toBe("Paused by you. Research saved; Resume continues the audit.");
    return { where: async (condition: unknown) => { expect(condition).toBeDefined(); } };
  } };
} };
mock.module("@nautilo/db", () => ({ ...database,
  getSharedDirectDb: () => db,
  findAwaitingTaskForRoom: async () => task.status === "awaiting" ? { task, runId: run.id, graphThreadId: run.graphThreadId } : undefined,
  getTaskById: async () => task,
  transitionTaskLifecyclePaused: async () => {
    task = { ...task, status: "paused" }; run = { ...run, status: "paused" };
    return { task, run, transitioned: true, outcome: "transitioned" };
  },
  transitionTaskApprovalExecution: async (_db: unknown, input: { from: string; to: TaskRun["status"] }) => {
    if (task.status !== input.from || run.status !== input.from) return false;
    task = { ...task, status: input.to as Task["status"] }; run = { ...run, status: input.to }; return true;
  },
  transitionTaskLifecycleTerminal: async () => {
    task = { ...task, status: "cancelled" }; run = { ...run, status: "cancelled" };
    return { transitioned: true, task, run };
  },
}));
mock.module("@nautilo/agent", () => ({ ...agent,
  resumeGraphWithHumanReply: async (...args: unknown[]) => {
    processor = args[3] as StreamEventProcessor;
    signal = args[5] as AbortSignal; announce(); await new Promise<void>((resolve) => { finish = resolve; });
    if (graphFailure) throw new Error("Provider failed after resume");
    return { reparked, finalText: "Late reply" };
  },
}));
mock.module("@nautilo/trust", () => ({ ...trust,
  assertCanInvokeAgent: async (input: Parameters<typeof trust.assertCanInvokeAgent>[0]) => {
    if (!allowed) throw new trust.AgentInvocationDeniedError(input);
  },
  assertCanUseServerProviderCredentials: async (humanUserId: string) => {
    expect(humanUserId).toBe("owner");
  },
}));
const runtime = await import("@nautilo/runtime");
let jobs: InstanceType<typeof runtime.JobManager>;
mock.module("@nautilo/runtime", () => ({ ...runtime,
  jobManager: { runResumeJobLifecycle: (...args: Parameters<typeof runtime.jobManager.runResumeJobLifecycle>) => jobs.runResumeJobLifecycle(...args) },
  createPersistingProcessor: () => ({ process: baseProcess, flush: async () => {}, emit: baseEmit }),
  reportBackTaskCompletion: completion,
  reportBackTaskError: failure,
}));
const { maybeResumeAwaitingTask } = await import("../../src/messaging/await-resume");
function resetStream() { started = new Promise<void>((resolve) => { announce = resolve; }); }
beforeEach(() => {
  task = { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", targetRoomId: "room", status: "awaiting", scheduleKind: "now" } as Task;
  run = { id: "run", taskId: task.id, graphThreadId: "subagent:human-reply", jobId: "completed-original", status: "awaiting" } as TaskRun;
  jobs = new runtime.JobManager({ persist: async () => randomUUID(), updateStatus: async () => {} });
  completion.mockClear(); failure.mockClear(); baseProcess.mockClear(); baseEmit.mockClear();
  reparked = false; allowed = true; graphFailure = false; resetStream();
});

test("human reply resumes use the canonical Job abort signal for pause and stop", async () => {
  for (const action of ["pause", "stop"] as const) {
    task = { ...task, status: "awaiting" }; run = { ...run, status: "awaiting" }; resetStream();
    const work = maybeResumeAwaitingTask("room", "owner", "Continue the saved audit"); await started;
    expect(signal).toBeInstanceOf(AbortSignal); expect(task.status).toBe("running");
    expect(jobs.getActiveJobs()[0]!.input).toMatchObject({ taskId: task.id, taskRunId: run.id });
    if (action === "pause") await runtime.pauseTask({ db: db as never, jobManager: jobs }, task.id);
    else await runtime.stopTask({ db: db as never, jobManager: jobs, reportBackCancellation: async () => {} }, task.id);
    expect(signal.aborted).toBe(true);
    await processor.process({ event: "on_chat_model_stream" });
    processor.emit!({ type: "task.progress", taskId: task.id, taskRunId: run.id, ownerId: "owner", detail: "Late progress" });
    expect(baseProcess).not.toHaveBeenCalled(); expect(baseEmit).not.toHaveBeenCalled();
    finish(); await work;
    expect(task.status).toBe(action === "pause" ? "paused" : "cancelled");
    expect(jobs.getActiveJobs()).toHaveLength(0); expect(completion).not.toHaveBeenCalled();
  }
});

test("a thrown resumed graph fails the active pair, while an aborted throw preserves paused state", async () => {
  graphFailure = true;
  const work = maybeResumeAwaitingTask("room", "owner", "Reply"); await started; finish(); await work;
  expect(failure).toHaveBeenCalledWith({ db }, expect.objectContaining({ taskId: task.id, runId: run.id,
    requireRunningPair: true, failureResultText: runtime.SAFE_BACKGROUND_TASK_FAILURE_RESULT }));
  expect(task.status).toBe("errored"); expect(jobs.getActiveJobs()).toHaveLength(0);
  failure.mockClear(); task = { ...task, status: "awaiting" }; run = { ...run, status: "awaiting" }; resetStream();
  const next = maybeResumeAwaitingTask("room", "owner", "Reply"); await started;
  await runtime.pauseTask({ db: db as never, jobManager: jobs }, task.id); finish(); await next;
  expect(failure).not.toHaveBeenCalled(); expect(task.status).toBe("paused");
});

test("human reply chained waits repark before another cancellable resume", async () => {
  reparked = true;
  const first = maybeResumeAwaitingTask("room", "owner", "First reply"); await started; finish(); await first;
  expect(task.status).toBe("awaiting"); expect(run.status).toBe("awaiting"); expect(jobs.getActiveJobs()).toHaveLength(0);
  resetStream(); reparked = false;
  const next = maybeResumeAwaitingTask("room", "owner", "Next reply"); await started; finish(); await next;
  expect(completion).toHaveBeenCalledWith({ db }, { taskId: task.id, runId: run.id, scheduleKind: "now", resultText: "Late reply", requireRunningPair: true });
  expect(jobs.getActiveJobs()).toHaveLength(0);
});
