/**
 * D420 (Wave 2 task 2.2.3) — `JobManager.terminalizeExecutableWorkForMaintenance`.
 *
 * Hermetic: injects recording acceptance sinks (no DB), a recording task-stop
 * sink (no task lifecycle), and white-box access to the live `active` job map +
 * the per-thread pending queue. Asserts the deadline cancellation terminalizes
 * running foreground/background Jobs, routes task-run Jobs through the task
 * lifecycle sink, drops queued turns + buffered lanes, and terminalizes the
 * durable accepted ledger — while preserving work that is not executable
 * (paused/awaiting tasks are not running Jobs, so they are never in `active`).
 *
 * The live-DB behavior of the acceptance sweep itself is covered by the db
 * integration suite; this test pins the runtime orchestration + fail-closed
 * propagation.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Job, type JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { jobInputToCoalescedInput } from "../../src/lane-coalescer";
import { WORK_ACCEPTANCE_REASONS } from "@nautilo/db";

/** White-box access to the manager's live job map (mirrors the summary test). */
function activeJobs(manager: JobManager): Map<string, Job> {
  return (manager as unknown as { active: Map<string, Job> }).active;
}
function pendingByThread(manager: JobManager): Map<string, unknown[]> {
  return (manager as unknown as { pendingByThread: Map<string, unknown[]> }).pendingByThread;
}

function makeJob(
  type: "foreground" | "background",
  input: Record<string, unknown>,
  id: string,
  updateStatus: (jobId: string, status: string, fields?: { message?: string }) => Promise<void>,
): Job {
  return new Job({
    ownerId: "owner",
    requestorId: "requestor",
    laneKey: type === "foreground" ? "lane-fg" : null,
    type,
    input,
    executor: (async function* () {
      yield* [] as never[];
    }) as JobExecutor,
    persist: async () => id,
    updateStatus,
  });
}

function makeHarness(opts?: { terminalizeError?: Error }) {
  const statusUpdates: Array<{ jobId: string; status: string; message?: string }> = [];
  const updateStatus = async (
    jobId: string,
    status: string,
    fields?: { message?: string },
  ): Promise<void> => {
    statusUpdates.push({ jobId, status, ...fields });
  };
  const persist = async (): Promise<string> => `job-${randomUUID()}`;

  const terminalizeCalls: Array<{ reason: string }> = [];
  const acceptanceSinks = {
    insertAcceptance: async () => `acc-${randomUUID()}`,
    linkAcceptancesToJob: async (ids: readonly string[]) => ids.length,
    terminalizeAllAcceptedWork: async (reason: string): Promise<number> => {
      terminalizeCalls.push({ reason });
      if (opts?.terminalizeError) throw opts.terminalizeError;
      return 2;
    },
    userCancelAcceptedWork: async () => 0,
  };

  const taskStopCalls: string[] = [];
  const taskStopSink = async (taskId: string): Promise<void> => {
    taskStopCalls.push(taskId);
  };

  const timers: { id: number; fn: () => void }[] = [];
  let timerId = 0;
  const setTimer = ((fn: () => void) => {
    const id = ++timerId;
    timers.push({ id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: ReturnType<typeof setTimeout>) => {
    const i = timers.findIndex((t) => t.id === (id as unknown as number));
    if (i >= 0) timers.splice(i, 1);
  }) as unknown as typeof clearTimeout;
  const fireTimers = (): void => {
    const fns = timers.splice(0).map((t) => t.fn);
    for (const fn of fns) fn();
  };

  const jm = new JobManager({
    laneLock: new InMemoryLaneLock(),
    persist,
    updateStatus,
    acceptanceSinks,
    taskStopSink,
    setTimer,
    clearTimer,
  });

  return { jm, statusUpdates, terminalizeCalls, taskStopCalls, acceptanceSinks, fireTimers };
}

describe("D420 terminalizeExecutableWorkForMaintenance", () => {
  test("cancels running fg/bg jobs, routes task-run jobs through stopTask, drops queued/buffered, terminalizes ledger", async () => {
    const h = makeHarness();
    const fg = makeJob("foreground", { message: "fg" }, "fg-1", async (jobId, status, fields) => {
      h.statusUpdates.push({ jobId, status, ...fields });
    });
    const bg = makeJob("background", { message: "bg" }, "bg-1", async (jobId, status, fields) => {
      h.statusUpdates.push({ jobId, status, ...fields });
    });
    const taskJob = makeJob(
      "foreground",
      { message: "task", taskId: "task-1", taskRunId: "run-1" },
      "task-job-1",
      async (jobId, status, fields) => {
        h.statusUpdates.push({ jobId, status, ...fields });
      },
    );
    await fg.persist();
    await bg.persist();
    await taskJob.persist();
    activeJobs(h.jm).set(fg.id, fg);
    activeJobs(h.jm).set(bg.id, bg);
    activeJobs(h.jm).set(taskJob.id, taskJob);

    // A queued turn parked on a thread (not yet dispatched).
    const queuedMerged = jobInputToCoalescedInput(
      { message: "queued", turnId: randomUUID(), graphThreadId: "thread-q" },
      "lane-q",
      "owner",
      "requestor",
    );
    pendingByThread(h.jm).set("thread-q", [
      { laneKey: "lane-q", merged: queuedMerged, virtualIds: ["vq"] },
    ]);

    // A buffered lane (coalescer buffer, not yet flushed).
    await h.jm.createForegroundJob("owner", "requestor", "lane-buf", {
      message: "buffered",
      turnId: randomUUID(),
      graphThreadId: "thread-buf",
      agentId: "bot",
      roomId: "room-1",
    });

    expect(h.jm.getExecutableJobWorkSummary()).toEqual({
      runningForegroundJobs: 1,
      runningBackgroundJobs: 1,
      queuedTurns: 1,
      bufferedLanes: 1,
    });

    const result = await h.jm.terminalizeExecutableWorkForMaintenance();

    expect(result).toEqual({
      cancelledJobs: 3,
      cancelledTaskRuns: 1,
      droppedQueuedTurns: 1,
      droppedBufferedLanes: 1,
      terminalizedAcceptances: 2,
    });
    // Task-run Job routed through the task lifecycle sink (durable task run
    // terminalization), not a direct job cancel.
    expect(h.taskStopCalls).toEqual(["task-1"]);
    // Non-task running Jobs cancelled with the maintenance reason.
    expect(h.statusUpdates).toContainEqual({
      jobId: "fg-1",
      status: "cancelled",
      message: "Cancelled by maintenance drain",
    });
    expect(h.statusUpdates).toContainEqual({
      jobId: "bg-1",
      status: "cancelled",
      message: "Cancelled by maintenance drain",
    });
    // The task-run Job was NOT cancelled directly by the manager (stopTask owns
    // it); no maintenance-drain cancel status for it.
    expect(
      h.statusUpdates.some(
        (s) => s.jobId === "task-job-1" && s.message === "Cancelled by maintenance drain",
      ),
    ).toBe(false);
    // Accepted ledger terminalized durably as maintenance_cancelled.
    expect(h.terminalizeCalls).toEqual([
      { reason: WORK_ACCEPTANCE_REASONS.maintenanceDrain },
    ]);
    // All executable categories reach zero after cancellation.
    expect(h.jm.getExecutableJobWorkSummary()).toEqual({
      runningForegroundJobs: 0,
      runningBackgroundJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
  });

  test("falls back to a direct cancel when the task-stop sink is not wired (hermetic default)", async () => {
    const statusUpdates: Array<{ jobId: string; status: string; message?: string }> = [];
    const updateStatus = async (jobId: string, status: string, fields?: { message?: string }) => {
      statusUpdates.push({ jobId, status, ...fields });
    };
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      persist: async () => `job-${randomUUID()}`,
      updateStatus,
      acceptanceSinks: {
        insertAcceptance: async () => `acc-${randomUUID()}`,
        linkAcceptancesToJob: async (ids: readonly string[]) => ids.length,
        terminalizeAllAcceptedWork: async () => 0,
        userCancelAcceptedWork: async () => 0,
      },
      // no taskStopSink
    });
    const taskJob = makeJob(
      "foreground",
      { message: "task", taskId: "task-1", taskRunId: "run-1" },
      "task-job-1",
      updateStatus,
    );
    await taskJob.persist();
    activeJobs(jm).set(taskJob.id, taskJob);

    const result = await jm.terminalizeExecutableWorkForMaintenance();
    expect(result.cancelledJobs).toBe(1);
    expect(result.cancelledTaskRuns).toBe(0);
    expect(statusUpdates).toContainEqual({
      jobId: "task-job-1",
      status: "cancelled",
      message: "Cancelled by maintenance drain",
    });
  });

  test("propagates an acceptance terminalization failure (fail closed)", async () => {
    const h = makeHarness({ terminalizeError: new Error("ledger unavailable") });
    const fg = makeJob("foreground", { message: "fg" }, "fg-1", async (jobId, status, fields) => {
      h.statusUpdates.push({ jobId, status, ...fields });
    });
    await fg.persist();
    activeJobs(h.jm).set(fg.id, fg);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(h.jm.terminalizeExecutableWorkForMaintenance()).rejects.toThrow(
      /ledger unavailable/,
    );
  });

  test("preserves paused/awaiting tasks by never touching work that is not a running Job", async () => {
    // A paused/awaiting task has no live Job in `active` (its executor returned
    // when the graph parked). The cancellation iterates `active` running Jobs
    // only, so a non-running (terminal) job is left untouched — modeling a
    // preserved parked task.
    const h = makeHarness();
    const parked = makeJob("foreground", { message: "parked" }, "parked-1", async () => {});
    await parked.persist();
    // Mark the job terminal (completed) so it is not "running" — mirrors a
    // task whose run parked and whose Job already emitted its terminal status.
    (parked as unknown as { _status: string })._status = "completed";
    activeJobs(h.jm).set(parked.id, parked);

    const result = await h.jm.terminalizeExecutableWorkForMaintenance();
    expect(result.cancelledJobs).toBe(0);
    // The preserved job is still in `active` (not cancelled).
    expect(activeJobs(h.jm).has(parked.id)).toBe(true);
  });
});
