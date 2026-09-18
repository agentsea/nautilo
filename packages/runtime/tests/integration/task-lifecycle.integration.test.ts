/**
 * M147 (Phase 6) — task lifecycle pause/unpause/stop + time-limit watchdog,
 * against real Postgres + a stub graph.
 *
 * Deterministic blast-radius coverage:
 *  - S3 (stop):  `stopTask` aborts the active run + terminal `cancelled`
 *                (+`cancelledAt`) on task and run, emits `task.status`.
 *  - S2 (pause): `pauseTask` parks the active run + task `paused`, emits event.
 *  - R4 (resume thread reuse — THE critical guard): an unpause re-dispatch
 *                inserts a NEW `task_runs` row that REUSES the prior paused
 *                run's `graphThreadId` (it does NOT re-mint a fresh
 *                `subagent:…:<uuid>` that would orphan the checkpoint).
 *  - S4 (watchdog): a running task whose run overran `time_limit_seconds` is
 *                auto-paused by the observer tick.
 *
 * NOTE on the headline "checkpoint CONTINUE + report-back exactly once": that
 * needs a real mid-aborted LangGraph checkpoint, which the immediate-resolving
 * stub model cannot produce deterministically. This suite proves the
 * thread-REUSE (the documented highest-risk bug surface) deterministically; the
 * full continue-and-report-once behavior is covered by manual QA (issue §7.1).
 *
 * No API keys required: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createTask as dbCreateTask,
  actors,
  groupMembers,
  groups,
  getTaskById,
  getTaskRuns,
  insertTaskRun,
  markTaskCancelled,
  persistJob,
  and,
  eq,
  type DirectDatabase,
} from "@nautilo/db";
import { __setStubModelForTests, setAgentEventSink } from "@nautilo/agent";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  pauseTask,
  stopTask,
  unpauseTask,
  type TaskLifecycleJobManager,
} from "../../src/tasks/lifecycle";
import { reportBackTaskCompletion } from "../../src/tasks/report-back";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";

let userId: string;
let agentId: string;
let db: DirectDatabase;

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("task-lifecycle");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")))
    .limit(1);
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!agentActor || !ownersGroup) {
    throw new Error("canonical Task lifecycle authority fixture missing");
  }
  await db.insert(groupMembers).values({
    groupId: ownersGroup.id,
    userId,
    grantedBy: agentActor.id,
  });
  // NOTE: we deliberately do NOT call `assertCleanTaskTables` here. This suite
  // never runs a GLOBAL claim that fires foreign tasks: the stop/pause tests
  // call the lifecycle fns directly on our own task, and the observer ticks
  // only claim `pending` rows + pause `running`+time_limit rows — both scoped to
  // rows this suite inserts under its own throwaway user. Everything is cleaned
  // via cascade.
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

function collect(): { events: ServerEvent[]; off: () => void } {
  const events: ServerEvent[] = [];
  const h = (e: ServerEvent) => events.push(e);
  eventBus.on(h);
  return { events, off: () => eventBus.off(h) };
}

async function insertRunningTask(opts: {
  thread: string;
  timeLimitSeconds?: number;
  startedAt?: Date;
  withJob?: boolean;
}): Promise<{ taskId: string; runId: string; jobId: string | null }> {
  const task = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "lifecycle test",
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "none",
    status: "running",
    ...(opts.timeLimitSeconds !== undefined
      ? { timeLimitSeconds: opts.timeLimitSeconds }
      : {}),
  });
  // task_runs.job_id has an FK → jobs.id; null models an accepted serialized
  // executor before its concrete Job link has been assigned.
  const jobId = opts.withJob === false
    ? null
    : await persistJob({
        ownerId: userId,
        requestorId: userId,
        laneKey: `task:${task.id}`,
        type: "foreground",
        input: { taskId: task.id },
      });
  const run = await insertTaskRun(db, {
    taskId: task.id,
    graphThreadId: opts.thread,
    status: "running",
    jobId,
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });
  return { taskId: task.id, runId: run.id, jobId };
}

describe("M147 — task lifecycle (stub graph, real PG)", () => {
  test("S3: stopTask aborts + terminal cancelled on task and run + event", async () => {
    const { taskId, runId } = await insertRunningTask({
      thread: `subagent:task:stop:${cryptoId()}`,
    });
    const c = collect();
    try {
      const res = await stopTask({ db, jobManager }, taskId);
      expect(res.ok).toBe(true);
      expect(res.status).toBe("cancelled");

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe("cancelled");
      expect(task?.cancelledAt).toBeTruthy();

      const runs = await getTaskRuns(db, taskId);
      expect(runs.find((r) => r.id === runId)?.status).toBe("cancelled");

      const statusEv = c.events.find(
        (e): e is Extract<ServerEvent, { type: "task.status" }> =>
          e.type === "task.status" && e.taskId === taskId,
      );
      expect(statusEv?.status).toBe("cancelled");
      expect(statusEv?.ownerId).toBe(userId);
    } finally {
      c.off();
    }
  });

  test("S3 idempotent: stopping an already-terminal task is a friendly no-op", async () => {
    const { taskId } = await insertRunningTask({ thread: `subagent:task:stop2:x` });
    await stopTask({ db, jobManager }, taskId);
    const res = await stopTask({ db, jobManager }, taskId);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("cancelled");
    expect(res.message).toContain("already");
  });

  test("S3: Stop cancels an accepted queued run before it has a job id", async () => {
    const { taskId, runId } = await insertRunningTask({
      thread: `subagent:task:queued-stop:${cryptoId()}`,
      withJob: false,
    });
    const abortCalls: Array<Parameters<TaskLifecycleJobManager["abortJob"]>> = [];
    const res = await stopTask(
      { db, jobManager: { abortJob: (...args) => (abortCalls.push(args), true) } },
      taskId,
    );

    expect(res).toMatchObject({ ok: true, status: "cancelled" });
    expect(abortCalls).toEqual([
      ["", "stop", { taskId, taskRunId: runId }],
    ]);
    expect((await getTaskById(db, taskId))?.status).toBe("cancelled");
    expect((await getTaskRuns(db, taskId)).find((run) => run.id === runId)?.status).toBe("cancelled");
  });

  test("S3: Stop aborts the linked concrete job only after it wins durable cancellation", async () => {
    const { taskId, jobId } = await insertRunningTask({
      thread: `subagent:task:linked-stop:${cryptoId()}`,
    });
    if (!jobId) throw new Error("linked stop fixture must persist a Job");
    const abortCalls: Array<{ jobId: string; reason: string | undefined }> = [];
    const res = await stopTask(
      {
        db,
        jobManager: {
          abortJob: (id, reason) => (abortCalls.push({ jobId: id, reason }), true),
        },
      },
      taskId,
    );

    expect(res).toMatchObject({ ok: true, status: "cancelled" });
    expect(abortCalls).toEqual([{ jobId, reason: "stop" }]);
  });

  test("S3: Stop cancels a pending task with no TaskRun", async () => {
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "cancel before dispatch",
      scheduleKind: "one_shot",
      targetChat: "orphan",
      toolsMode: "none",
      status: "pending",
    });
    const abortCalls: string[] = [];
    const res = await stopTask(
      { db, jobManager: { abortJob: (jobId) => (abortCalls.push(jobId), true) } },
      task.id,
    );

    expect(res).toMatchObject({ ok: true, status: "cancelled" });
    expect(abortCalls).toEqual([]);
    expect((await getTaskById(db, task.id))?.status).toBe("cancelled");
    expect(await getTaskRuns(db, task.id)).toEqual([]);
  });

  test("S3: concurrent Stop and completion preserve one matching terminal winner", async () => {
    const { taskId, runId, jobId } = await insertRunningTask({
      thread: `subagent:task:stop-race:${cryptoId()}`,
    });
    if (!jobId) throw new Error("race fixture must persist a Job");
    const abortCalls: Array<{ jobId: string; reason: string | undefined }> = [];
    await Promise.all([
      stopTask(
        {
          db,
          jobManager: {
            abortJob: (id, reason) => (abortCalls.push({ jobId: id, reason }), true),
          },
        },
        taskId,
      ),
      reportBackTaskCompletion(
        { db },
        { taskId, runId, scheduleKind: "now", resultText: "finished" },
      ),
    ]);

    const task = await getTaskById(db, taskId);
    const run = (await getTaskRuns(db, taskId)).find((candidate) => candidate.id === runId);
    if (task?.status === "completed") {
      expect(run?.status ?? "missing").toBe("completed");
      expect(abortCalls).toEqual([]);
    } else {
      expect(task?.status).toBe("cancelled");
      expect(run?.status ?? "missing").toBe("cancelled");
      expect(abortCalls).toEqual([{ jobId, reason: "stop" }]);
    }
  });

  test("S3: Stop loses to an already-completed concrete run without aborting its Job", async () => {
    const { taskId, runId, jobId } = await insertRunningTask({
      thread: `subagent:task:completed-before-stop:${cryptoId()}`,
    });
    if (!jobId) throw new Error("completed-before-stop fixture must persist a Job");
    await reportBackTaskCompletion(
      { db },
      { taskId, runId, scheduleKind: "now", resultText: "finished" },
    );

    const abortCalls: string[] = [];
    const res = await stopTask(
      { db, jobManager: { abortJob: (id) => (abortCalls.push(id), true) } },
      taskId,
    );

    expect(res).toMatchObject({ ok: true, status: "completed" });
    expect(abortCalls).toEqual([]);
    expect((await getTaskRuns(db, taskId)).find((run) => run.id === runId)?.status).toBe("completed");
  });

  test("S2: pauseTask parks run + task paused + event", async () => {
    const { taskId, runId } = await insertRunningTask({ thread: `subagent:task:pause:y` });
    const c = collect();
    try {
      const res = await pauseTask({ db, jobManager }, taskId);
      expect(res.ok).toBe(true);
      expect(res.status).toBe("paused");

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe("paused");
      const runs = await getTaskRuns(db, taskId);
      expect(runs.find((r) => r.id === runId)?.status).toBe("paused");

      const ev = c.events.find(
        (e): e is Extract<ServerEvent, { type: "task.status" }> =>
          e.type === "task.status" && e.taskId === taskId,
      );
      expect(ev?.status).toBe("paused");
    } finally {
      c.off();
    }
    // Park terminally so a stray tick can never re-claim it.
    await markTaskCancelled(db, taskId);
  });

  test("R4: unpause re-dispatch REUSES the prior paused run's graphThreadId (no re-mint)", async () => {
    const priorThread = `subagent:task:resume:${cryptoId()}`;
    // A task with a single PAUSED run on a known thread (the parked checkpoint).
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "resume test",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      status: "paused",
    });
    const pausedRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: priorThread,
      status: "paused",
    });

    const acceptedJobId = `stub-resume-job-${cryptoId()}`;
    const dispatchOnlyJobManager = {
      createForegroundJob: async () => ({
        id: acceptedJobId,
        virtualJobId: acceptedJobId,
      }),
      abortJob: () => false,
    };
    const obs = new TaskObserver({ db, jobManager: dispatchOnlyJobManager, batch: 20 });
    await unpauseTask({ db, jobManager: dispatchOnlyJobManager, observer: obs }, task.id);

    const afterUnpause = await getTaskById(db, task.id);
    expect(afterUnpause?.status).toBe("pending");

    // The observer re-claims the now-pending task and dispatches a resume run.
    // `dispatchTaskRun` is awaited inside the tick, so the new row exists after.
    await obs.tick();

    const runs = await getTaskRuns(db, task.id);
    const newRun = runs.find((r) => r.id !== pausedRun.id);
    expect(newRun).toBeTruthy();
    // THE GUARD: the resume run reused the prior thread, NOT a fresh nanoid.
    expect(newRun?.graphThreadId).toBe(priorThread);

    await obs.stop();
    await markTaskCancelled(db, task.id);
  });

  test("D406: unpausing a DORMANT cron (no parked run) re-arms to the next occurrence, not now", async () => {
    // A recurring task paused while sleeping between fires: no runs at all.
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "dormant cron rearm test",
      scheduleKind: "cron",
      cron: "0 9 * * 1-5", // 09:00 Mon–Fri
      timezone: "UTC",
      targetChat: "orphan",
      toolsMode: "none",
      status: "paused",
    });

    const before = Date.now();
    const res = await unpauseTask({ db, jobManager }, task.id);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("pending");

    const after = await getTaskById(db, task.id);
    expect(after?.status).toBe("pending");
    // The fix: next_fire_at is a FUTURE scheduled occurrence (well beyond the
    // resume instant), NOT ~now — so toggling the schedule on does not fire it
    // immediately. Guard with a generous margin (> 1 minute out).
    const nextFireMs = after?.nextFireAt ? new Date(after.nextFireAt).getTime() : 0;
    expect(nextFireMs).toBeGreaterThan(before + 60_000);

    // No run should have been dispatched by the unpause itself.
    const runs = await getTaskRuns(db, task.id);
    expect(runs.length).toBe(0);

    await markTaskCancelled(db, task.id);
  });

  test("S4: time-limit watchdog auto-pauses an overrunning run", async () => {
    const tenSecAgo = new Date(Date.now() - 10_000);
    const { taskId, runId } = await insertRunningTask({
      thread: `subagent:task:watchdog:z`,
      timeLimitSeconds: 1,
      startedAt: tenSecAgo,
    });

    const obs = new TaskObserver({ db, jobManager, batch: 20 });
    await obs.tick(); // claim pass (nothing pending) → watchdog pass

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("paused");
    const runs = await getTaskRuns(db, taskId);
    expect(runs.find((r) => r.id === runId)?.status).toBe("paused");

    await obs.stop();
    await markTaskCancelled(db, taskId);
  });
});

/** Small UUID-ish helper for unique thread names (avoids importing crypto twice). */
function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
