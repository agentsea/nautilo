import { beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import type { RuntimePolicyContext } from "@nautilo/trust";
import type { StreamEventProcessor } from "@nautilo/agent";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";

// Real Task approval wrapper, Job registration and lifecycle cancellation;
// only graph/provider work and durable queries are replaced in this process.
const database = await import("@nautilo/db");
const agent = await import("@nautilo/agent");
let task: Task;
let run: TaskRun;
let finish: () => void;
let started: Promise<void>;
let announce: () => void;
let observedSignal: AbortSignal | undefined;
let reparked = false;
let rejectOnAbort = false;
let beforePauseRunWrite: (() => Promise<void>) | undefined;
let processor: StreamEventProcessor;
const baseProcess = mock(async (_event: unknown) => {});
const baseEmit = mock((_event: unknown) => {});
const completion = mock(async (..._args: unknown[]) => {});
const failure = mock(async (..._args: unknown[]) => {});
const inspect = mock(async () => ({ reparked, finalText: "Late model completion" }));
mock.module("@nautilo/db", () => ({ ...database,
  getTaskById: async () => task,
  transitionTaskLifecyclePaused: async () => {
    await beforePauseRunWrite?.();
    if (task.status === "completed" || task.status === "cancelled" || task.status === "errored") {
      return { task, run: undefined, transitioned: false, outcome: "task_terminal" };
    }
    task = { ...task, status: "paused" };
    run = { ...run, status: "paused" };
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
async function resume(signal?: AbortSignal) {
  observedSignal = signal; announce();
  await new Promise<void>((resolve, reject) => {
    finish = resolve;
    if (rejectOnAbort) signal?.addEventListener("abort", () => reject(new Error("aborted provider")), { once: true });
  });
}
mock.module("@nautilo/agent", () => ({ ...agent,
  resumeGraphWithAskReply: async (...args: unknown[]) => { processor = args[2] as StreamEventProcessor; return resume(args[5] as AbortSignal); },
  resumeGraphWithApproval: async (...args: unknown[]) => { processor = args[2] as StreamEventProcessor; return resume(args[5] as AbortSignal); },
  resumeGraphWithIdentity: async (...args: unknown[]) => { processor = args[3] as StreamEventProcessor; return resume(args[7] as AbortSignal); },
  inspectTaskResumeOutcome: inspect,
}));
mock.module("../../src/executors/persisting-processor", () => ({
  createPersistingProcessor: () => ({ process: baseProcess, flush: async () => {}, emit: baseEmit }),
}));
mock.module("../../src/tasks/report-back", () => ({
  reportBackTaskCompletion: completion, reportBackTaskError: failure,
  reportBackTaskCancellation: async () => {}, SAFE_BACKGROUND_TASK_FAILURE_RESULT: "Task failed",
}));
const { JobManager } = await import("../../src/job-manager");
const { runTaskApprovalResume } = await import("../../src/tasks/resume-task-approval");
const { pauseTask, stopTask } = await import("../../src/tasks/lifecycle");
// Ordinary approval fixtures have no Desktop-wait marker. The recovery hold's
// filtered metadata update therefore affects no rows; reject other SQL writes.
const db = { update: (table: unknown) => {
  expect(table).toBe(database.tasks);
  return { set: (patch: Record<string, unknown>) => {
    expect(Object.keys(patch).sort()).toEqual(["lastError", "updatedAt"]);
    expect(patch["lastError"]).toBe("Paused by you. Research saved; Resume continues the audit.");
    return { where: async (condition: unknown) => { expect(condition).toBeDefined(); } };
  } };
} } as unknown as DirectDatabase;
const authority = createAcceptedInvocationAuthority("owner");
const maintenance = createMaintenanceAcceptanceAuthority();
const manager = () => new JobManager({ persist: async () => randomUUID(), updateStatus: async () => {} });
function resetStream() {
  started = new Promise<void>((resolve) => { announce = resolve; });
  observedSignal = undefined;
}
beforeEach(() => {
  task = { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", targetChat: "orphan", status: "awaiting",
    scheduleKind: "now", metadata: {} } as Task;
  run = { id: "run", taskId: task.id, jobId: "completed-original-job", graphThreadId: "subagent:approval", status: "awaiting" } as TaskRun;
  completion.mockClear(); failure.mockClear(); inspect.mockClear(); baseProcess.mockClear(); baseEmit.mockClear();
  reparked = false; rejectOnAbort = false; beforePauseRunWrite = undefined; resetStream();
});
function start(manager: InstanceType<typeof JobManager>, kind: "ask" | "prove_it" | "identity") {
  return runTaskApprovalResume({ task, run, kind, verb: "once", approved: true,
    policyContext: {} as RuntimePolicyContext, invocationAuthority: authority, maintenanceAuthority: maintenance }, { db, jobManager: manager });
}

test("pause and stop reach all three approval-resumed workers after the original Job completed", async () => {
  for (const kind of ["ask", "prove_it", "identity"] as const) for (const action of ["pause", "stop"] as const) {
    task = { ...task, status: "awaiting" }; run = { ...run, status: "awaiting" }; resetStream();
    const jobs = manager(); const work = start(jobs, kind); await started;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    const active = jobs.getActiveJobs(); expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(run.jobId!);
    expect(active[0]!.input).toMatchObject({ taskId: task.id, taskRunId: run.id, graphThreadId: run.graphThreadId });
    const result = action === "pause" ? await pauseTask({ db, jobManager: jobs }, task.id) : await stopTask({ db, jobManager: jobs }, task.id);
    expect(result.status).toBe(action === "pause" ? "paused" : "cancelled");
    expect(observedSignal!.aborted).toBe(true);
    await processor.process({ event: "on_chat_model_stream" });
    processor.emit!({ type: "task.progress", taskId: task.id, taskRunId: run.id, ownerId: "owner", detail: "Late progress" });
    expect(baseProcess).not.toHaveBeenCalled(); expect(baseEmit).not.toHaveBeenCalled();
    expect(jobs.getAbortReason(active[0]!.id)).toBe(action);
    // A provider resolving normally after cancellation must not finalize.
    finish(); await work;
    expect(jobs.getActiveJobs()).toHaveLength(0);
    expect(task.status).toBe(action === "pause" ? "paused" : "cancelled");
  }
  expect(inspect).not.toHaveBeenCalled(); expect(completion).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
});

test("aborted provider rejection cannot overwrite pause or emit failure", async () => {
  rejectOnAbort = true; const jobs = manager(); const work = start(jobs, "ask"); await started;
  await pauseTask({ db, jobManager: jobs }, task.id); await work;
  expect(task.status).toBe("paused"); expect(run.status).toBe("paused");
  expect(failure).not.toHaveBeenCalled(); expect(completion).not.toHaveBeenCalled(); expect(jobs.getActiveJobs()).toHaveLength(0);
});

test("pause cancels a null-job approval worker admitted before its atomic durable fence", async () => {
  const jobs = manager();
  const atWrite = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  beforePauseRunWrite = async () => { atWrite.resolve(); await releaseWrite.promise; };
  run = { ...run, jobId: null };
  const pausing = pauseTask({ db, jobManager: jobs }, task.id); await atWrite.promise;
  const work = start(jobs, "ask"); await started;
  expect(observedSignal!.aborted).toBe(false); expect(task.status).toBe("running");
  releaseWrite.resolve(); await pausing;
  expect(observedSignal!.aborted).toBe(true); expect(task.status).toBe("paused"); expect(run.status).toBe("paused");
  finish(); await work; expect(completion).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
});

test("chained approvals register a fresh cancellable worker and an old run cannot cancel it", async () => {
  const jobs = manager(); reparked = true;
  const first = start(jobs, "ask"); await started; const firstId = jobs.getActiveJobs()[0]!.id; finish();
  expect(await first).toEqual({ reparked: true }); expect(task.status).toBe("awaiting"); expect(jobs.getActiveJobs()).toHaveLength(0);
  resetStream(); const second = start(jobs, "prove_it"); await started;
  expect(jobs.getActiveJobs()[0]!.id).not.toBe(firstId);
  expect(jobs.abortJob(firstId, "pause", { taskId: task.id, taskRunId: "different-run" })).toBe(false);
  expect(observedSignal!.aborted).toBe(false);
  await pauseTask({ db, jobManager: jobs }, task.id); finish(); await second;
  expect(jobs.getActiveJobs()).toHaveLength(0); expect(completion).not.toHaveBeenCalled();
});

test("ordinary foreground Task jobs still abort through the exact persisted TaskRun input", async () => {
  const jobs = new JobManager({ persist: async () => randomUUID(), updateStatus: async () => {}, coalescerWindowMs: 0, coalescerFirstSegmentQuietMs: 0 });
  const settled = Promise.withResolvers<void>();
  await jobs.createForegroundJob("owner", "owner", "task:task", {
    taskId: task.id, taskRunId: run.id, graphThreadId: run.graphThreadId, message: "Ordinary task",
  }, async function* (_input, _jobId, _lane, signal) {
    observedSignal = signal; announce();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    settled.resolve(); yield* [];
  }, maintenance, undefined, authority);
  await started;
  const active = jobs.getActiveJobs()[0]!;
  run = { ...run, status: "running", jobId: active.id }; task = { ...task, status: "running" };
  await pauseTask({ db, jobManager: jobs }, task.id);
  expect(observedSignal!.aborted).toBe(true); await settled.promise;
});


test("a stale invalid paid-media reply cannot error the exact pair after Pause", async () => {
  const jobs = manager();
  const staleArgs = { task, run, kind: "ask" as const, verb: "once" as const, approved: true,
    mediaGenerationApprovalId: "partial-echo", policyContext: {} as RuntimePolicyContext,
    invocationAuthority: authority, maintenanceAuthority: maintenance };
  await pauseTask({ db, jobManager: jobs }, task.id);
  await runTaskApprovalResume(staleArgs, { db, jobManager: jobs });
  expect(task.status).toBe("paused"); expect(run.status).toBe("paused");
  expect(observedSignal).toBeUndefined(); expect(failure).not.toHaveBeenCalled();
  expect(completion).not.toHaveBeenCalled(); expect(jobs.getActiveJobs()).toHaveLength(0);
});

test("an admitted invalid paid-media reply fails only the running pair without invoking the graph", async () => {
  const jobs = manager();
  await runTaskApprovalResume({ task, run, kind: "ask", verb: "once", approved: true,
    mediaGenerationApprovalId: "partial-echo", policyContext: {} as RuntimePolicyContext,
    invocationAuthority: authority, maintenanceAuthority: maintenance }, { db, jobManager: jobs });
  expect(observedSignal).toBeUndefined(); expect(failure).toHaveBeenCalledTimes(1);
  expect(failure.mock.calls[0]![1]).toMatchObject({ taskId: task.id, runId: run.id, requireRunningPair: true });
  expect(completion).not.toHaveBeenCalled(); expect(jobs.getActiveJobs()).toHaveLength(0);
});
