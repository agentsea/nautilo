/**
 * M147 (R1/R3) — `JobManager.abortJob` shared abort seam.
 *
 * Runs fully in-process (no DB, no server): injected no-op `persist` /
 * `updateStatus` sinks + a controllable coalescer timer, plus a gated mock
 * executor so a foreground job stays live in `active` long enough to abort.
 *
 * Scenario subset (issue §6 unit #1):
 *  - `abortJob` aborts a live job (controller fires, job → cancelled) + true
 *  - `getAbortReason` reports the reason while live; cleared on terminal
 *  - unknown / already-terminal id → false
 *  - `cancelJob` still works (shared cancel path)
 */
import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";

function makeHarness(opts?: { taskStopSink?: (taskId: string) => Promise<void> }) {
  const persist = async (): Promise<string> => `job-${randomUUID()}`;
  const statusUpdates: Array<{ jobId: string; status: string; message?: string }> = [];
  const updateStatus = async (
    jobId: string,
    status: string,
    fields?: { message?: string },
  ): Promise<void> => {
    statusUpdates.push({ jobId, status, ...fields });
  };

  const dispatched: string[] = [];
  let capturedSignal: AbortSignal | null = null;
  const gate = Promise.withResolvers<void>();

  const executor: JobExecutor = async function* (_input, jobId, laneKey, signal) {
    capturedSignal = signal;
    dispatched.push(jobId);
    await gate.promise;
    // Mimic the real executor: bail out silently once aborted.
    if (signal.aborted) return;
    yield {
      type: "message.tokens",
      laneKey: laneKey ?? "",
      content: ".",
      chunkSequence: 1,
      done: true,
    };
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
    setTimer,
    clearTimer,
    ...(opts?.taskStopSink ? { taskStopSink: opts.taskStopSink } : {}),
  });

  return {
    jm,
    executor,
    dispatched,
    gate,
    fireTimers,
    statusUpdates,
    getSignal: () => capturedSignal,
  };
}

async function waitFor(
  pred: () => boolean,
  { tries = 300, ms = 2 }: { tries?: number; ms?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor: condition not met in time");
}

async function dispatchLiveJob(
  h: ReturnType<typeof makeHarness>,
  inputOverrides: Record<string, unknown> = {},
): Promise<string> {
  const room = randomUUID();
  const bot = randomUUID();
  const user = randomUUID();
  const thread = `room:${room}:bot:${bot}`;
  await h.jm.createForegroundJob(
    user,
    user,
    `room:${room}:user:${user}:bot:${bot}`,
    {
      message: "m",
      turnId: randomUUID(),
      graphThreadId: thread,
      agentId: bot,
      roomId: room,
      ownerId: user,
      requestorId: user,
      ...inputOverrides,
    },
    h.executor,
  );
  h.fireTimers(); // flush the coalescer → dispatch
  await waitFor(() => h.dispatched.length === 1);
  return h.dispatched[0]!;
}

describe("M147 — JobManager.abortJob shared seam", () => {
  test("aborts a live job, fires its signal, returns true, records the reason", async () => {
    const h = makeHarness();
    const jobId = await dispatchLiveJob(h);

    expect(h.getSignal()?.aborted).toBe(false);
    expect(h.jm.abortJob(jobId, "stop")).toBe(true);
    expect(h.getSignal()?.aborted).toBe(true);
    expect(h.jm.getAbortReason(jobId)).toBe("stop");

    // Let the gated executor unwind; the job leaves `active` and the reason clears.
    h.gate.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
    expect(h.jm.getAbortReason(jobId)).toBeUndefined();
    // Already-terminal / removed id → false.
    expect(h.jm.abortJob(jobId)).toBe(false);
  });

  test("returns false for an unknown job id", () => {
    const h = makeHarness();
    expect(h.jm.abortJob("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(h.jm.abortJob("00000000-0000-4000-8000-000000000000", "pause")).toBe(false);
  });

  test("cancelJob still cancels via the shared path", async () => {
    const h = makeHarness();
    const jobId = await dispatchLiveJob(h);

    expect(await h.jm.cancelJob(jobId)).toBe(true);
    expect(h.getSignal()?.aborted).toBe(true);

    h.gate.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
    expect(await h.jm.cancelJob(jobId)).toBe(false);
  });

  test("planned shutdown terminalizes foreground jobs and drops queued/buffered work", async () => {
    const h = makeHarness();
    const jobId = await dispatchLiveJob(h);
    const room = randomUUID();
    const bot = randomUUID();
    const user = randomUUID();
    const thread = `room:${room}:bot:${bot}`;

    // A system turn stays queued behind the active main turn.
    await h.jm.createSystemForegroundJob(
      user,
      user,
      `room:${room}:user:${user}:bot:${bot}`,
      {
        message: "queued",
        turnId: randomUUID(),
        graphThreadId: (h.jm.getJob(jobId)?.input["graphThreadId"] as string) ?? thread,
        agentId: bot,
        roomId: room,
      },
      h.executor,
    );
    await waitFor(() => h.jm.getForegroundWorkSummary().queuedTurns === 1);

    // A separate lane remains in the coalescer until its timer fires.
    await h.jm.createForegroundJob(
      user,
      user,
      `room:${room}:user:${user}:bot:other`,
      {
        message: "buffered",
        turnId: randomUUID(),
        graphThreadId: `${thread}:other`,
        agentId: "other",
        roomId: room,
      },
      h.executor,
    );

    expect(h.jm.getForegroundWorkSummary()).toEqual({
      runningJobs: 1,
      queuedTurns: 1,
      bufferedLanes: 1,
    });

    const result = await h.jm.cancelForegroundJobsForPlannedShutdown();
    expect(result).toEqual({
      runningJobs: 1,
      queuedTurns: 1,
      bufferedLanes: 1,
      cancelledJobs: 1,
    });
    expect(h.getSignal()?.aborted).toBe(true);
    expect(h.jm.getForegroundWorkSummary()).toEqual({
      runningJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
    expect(h.statusUpdates).toContainEqual({
      jobId,
      status: "cancelled",
      message: "Cancelled because the server is shutting down for planned maintenance",
    });

    h.gate.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
  });

  test("planned shutdown delegates a task-backed foreground Job to the canonical task lifecycle", async () => {
    const stoppedTaskIds: string[] = [];
    const ref: { current: ReturnType<typeof makeHarness> | null } = { current: null };
    const h = makeHarness({
      taskStopSink: async (taskId) => {
        stoppedTaskIds.push(taskId);
        const taskJob = ref.current?.jm.getActiveJobs().find(
          (job) => job.input["taskId"] === taskId,
        );
        if (taskJob) ref.current?.jm.abortJob(taskJob.id, "stop");
      },
    });
    ref.current = h;
    const taskId = randomUUID();
    const jobId = await dispatchLiveJob(h, { taskId, taskRunId: randomUUID() });

    const result = await h.jm.cancelForegroundJobsForPlannedShutdown();

    expect(result.cancelledJobs).toBe(1);
    expect(stoppedTaskIds).toEqual([taskId]);
    expect(h.getSignal()?.aborted).toBe(true);
    expect(h.statusUpdates).not.toContainEqual({
      jobId,
      status: "cancelled",
      message: "Cancelled because the server is shutting down for planned maintenance",
    });

    h.gate.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
  });

  test("planned shutdown directly cancels a task-backed Job when the task lifecycle sink fails", async () => {
    const stoppedTaskIds: string[] = [];
    const h = makeHarness({
      taskStopSink: async (taskId) => {
        stoppedTaskIds.push(taskId);
        throw new Error("task store unavailable");
      },
    });
    const taskId = randomUUID();
    const jobId = await dispatchLiveJob(h, { taskId, taskRunId: randomUUID() });

    const result = await h.jm.cancelForegroundJobsForPlannedShutdown();

    expect(result.cancelledJobs).toBe(1);
    expect(stoppedTaskIds).toEqual([taskId]);
    expect(h.getSignal()?.aborted).toBe(true);
    expect(h.statusUpdates).toContainEqual({
      jobId,
      status: "cancelled",
      message: "Cancelled because the server is shutting down for planned maintenance",
    });

    h.gate.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
  });
});
