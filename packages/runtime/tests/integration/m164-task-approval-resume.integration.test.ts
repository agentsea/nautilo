/**
 * M164 — Task/subagent approval surfacing + owner-only resume, end-to-end
 * against real Postgres + the real LangGraph (stub model).
 *
 * Unlike the unit coverage (which asserts the pure mapping + auth contracts),
 * this drives the ACTUAL `taskRunExecutor` so a real `approval_ask` checkpoint
 * is parked, then resumes it through `runTaskApprovalResume`. The reply verb is
 * `deny` throughout so the gated tool never executes. The fixture uses the
 * cloud `file` tool with `zone: "workspace"`: unlike relay-only tools it is
 * eligible without a connected workstation, while the existing test policy's
 * file approval route still parks before any write can execute. This exercises
 * the full emit → resume → finalize / repark machinery without creating files.
 *
 * Dispatch is driven DIRECTLY via `taskRunExecutor` (NOT the `TaskObserver`), so
 * the suite is safe against a populated instance. Tasks use a far-future
 * `next_fire_at` and are never `pending`, so a live observer never claims them.
 *
 * Covers (Blast Radius MV1/MV3/MV4):
 *  - Task `approval_ask` → owner-scoped, Task-tagged `approval.ask`; orphan task
 *    drops the `room` verb (R13).
 *  - Owner `deny` resumes the exact checkpoint and finalizes (task completed).
 *  - Another user cannot resume (404 fail-closed).
 *  - A chained approval keeps the task `awaiting` and emits the next
 *    Task-originated `approval.ask` instead of completing.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { setConfigOverrides } from "@nautilo/config";
import {
  actors,
  groupMembers,
  groups,
  tasks,
  taskRuns,
  createTask as dbCreateTask,
  insertTaskRun,
  getTaskById,
  getTaskRuns,
  getActiveTaskRun,
  getLatestResumableTaskRun,
  transitionTaskLifecyclePaused,
  transitionTaskLifecycleTerminal,
  transitionTaskApprovalExecution,
  recordTaskPreparation,
  eq,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { __setStubModelForTests, setAgentEventSink } from "@nautilo/agent";
import { initPolicyResolver, type MemoryAccessEnvelope } from "@nautilo/trust";
import type { ServerEvent, ApprovalAskEvent } from "@nautilo/types";
import { eventBus } from "../../src/event-bus";
import { pauseTask } from "../../src/tasks/lifecycle";
import { jobManager } from "../../src/job-manager";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";
import { taskRunExecutor } from "../../src/tasks/task-run-executor";
import {
  authorizeTaskApprovalResume,
  runTaskApprovalResume,
} from "../../src/tasks/resume-task-approval";
import {
  setTaskRunDb,
  setTaskRunJobManager,
} from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  collectEvents,
  createTestUser,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";
import { createApprovalVerbTestPolicy } from "./helpers/approval-verb-test-policy";

let userId: string;
let agentId: string;
let ownerActorId: string;
let db: DirectDatabase;
let strangerUserId: string;

const createdTaskIds: string[] = [];

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setConfigOverrides({ nautilo_security_level: "standard" });

  await setupTestDb();
  const env = await setupAgentTestEnv("m164-approval");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  // The gating policy's existing `file` route resolves writes to approval.
  initPolicyResolver(createApprovalVerbTestPolicy(userId));

  const [ua] = await db
    .insert(actors)
    .values({ ownerId: userId, kind: "user", displayName: "Owner", trustState: "verified" })
    .returning({ id: actors.id });
  ownerActorId = ua!.id;
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("canonical owners group missing");
  await db.insert(groupMembers).values({
    groupId: ownersGroup.id,
    userId,
    grantedBy: ownerActorId,
  });

  const stranger = await createTestUser("m164-stranger");
  strangerUserId = stranger.userId;
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  setTaskRunJobManager(null);
  setConfigOverrides({});
  if (!db) return;
  if (createdTaskIds.length > 0) {
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  // Subagent transcripts persist under a NULL-room session owned by the user;
  // cleanupTestUser sweeps the user's sessions + messages.
  await db.delete(actors).where(eq(actors.id, ownerActorId));
  await cleanupTestUser(strangerUserId);
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

function setStub(
  responses: Array<
    | { type: "text"; content: string }
    | { type: "tool_call"; name: string; args: Record<string, unknown>; id: string }
  >,
): void {
  const provider = createStubProvider({ responses });
  __setStubModelForTests(provider.asChatModel());
}

function orphanEnvelope(): MemoryAccessEnvelope {
  return {
    ownerId: userId,
    actorId: ownerActorId,
    agentId,
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
}

/** Seed an orphan in_background task + a running run row; return ids + thread. */
async function seedRunningTask(): Promise<{
  taskId: string;
  runId: string;
  graphThreadId: string;
}> {
  const task = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "Propose a workspace file write and report back.",
    preset: "in_background",
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "auto",
    status: "running",
    nextFireAt: new Date(Date.now() + 3_600_000),
  });
  createdTaskIds.push(task.id);
  const graphThreadId = `subagent:m164:${randomUUID()}`;
  const run = await insertTaskRun(db, {
    taskId: task.id,
    graphThreadId,
    status: "running",
    modelId: process.env["NAUTILO_MODEL"]!,
  });
  return { taskId: task.id, runId: run.id, graphThreadId };
}

/**
 * Run the real executor (via the job manager so the run gets a real job UUID)
 * until it parks on the approval and emits the event.
 */
async function runExecutorToPark(ids: {
  taskId: string;
  runId: string;
  graphThreadId: string;
}): Promise<void> {
  const input: Record<string, unknown> = {
    taskId: ids.taskId,
    taskRunId: ids.runId,
    scheduleKind: "now",
    memoryAccessEnvelope: orphanEnvelope(),
    ownerId: userId,
    requestorId: userId,
    agentId,
    roomId: "",
    transcriptOwnerId: userId,
    graphThreadId: ids.graphThreadId,
    turnId: ids.runId,
    actorRole: "owner",
    message: "Propose a workspace file write and report back.",
    parentThreadId: `task:${ids.taskId}`,
    modelId: process.env["NAUTILO_MODEL"]!,
    assistantName: "Genie",
    soulFile: "",
    subagentDepth: 1,
    subagentMaxDepth: 5,
  };
  await jobManager.createForegroundJob(
    userId,
    userId,
    `task:${ids.taskId}`,
    input,
    taskRunExecutor,
  );
  await pollTask(ids.taskId, (s) => s === "awaiting");
}

function taskApprovalEvents(events: ServerEvent[], taskId: string): ApprovalAskEvent[] {
  return events.filter(
    (e): e is ApprovalAskEvent => e.type === "approval.ask" && e.taskId === taskId,
  );
}

async function pollTask(
  taskId: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const t = await getTaskById(db, taskId);
    if (predicate(t?.status)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pollTask timeout for ${taskId}: status=${(await getTaskById(db, taskId))?.status}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("M164 — Task approval surfacing + owner resume (stub graph, real PG)", () => {
  test("executor parks → owner-scoped Task approval.ask (orphan drops `room`); owner deny resumes to completion", async () => {
    const ids = await seedRunningTask();
    setStub([
      {
        type: "tool_call",
        name: "file",
        args: {
          command: "write",
          zone: "workspace",
          path: "m164-denied-write-mv1.txt",
          content: "This write must remain denied.",
        },
        id: "tc-mv1",
      },
      { type: "text", content: "Understood — I won't write that file." },
    ]);

    const { events, cleanup } = collectEvents(eventBus);
    try {
      await runExecutorToPark(ids);

      // MV1 — the parked interrupt surfaced as an owner-scoped, Task-tagged event.
      const asks = taskApprovalEvents(events, ids.taskId);
      expect(asks.length).toBe(1);
      const ask = asks[0]!;
      const awaitingIndex = events.findIndex((event) =>
        event.type === "task.status" &&
        event.taskId === ids.taskId &&
        event.ownerId === userId &&
        event.status === "awaiting"
      );
      const askIndex = events.indexOf(ask);
      expect(awaitingIndex).toBeGreaterThanOrEqual(0);
      expect(awaitingIndex).toBeLessThan(askIndex);
      expect(ask.origin).toBe("task");
      expect(ask.userId).toBe(userId);
      expect(ask.taskRunId).toBe(ids.runId);
      expect(ask.laneKey).toBe(`task:${ids.taskId}`);
      // R13 — orphan task (no room) must not offer the `room` verb.
      expect(ask.allowedVerbs).not.toContain("room");
      expect(ask.allowedVerbs).toContain("once");
      expect(ask.allowedVerbs).toContain("deny");

      // Task parked awaiting.
      await pollTask(ids.taskId, (s) => s === "awaiting");

      // MV4 — owner deny resumes the exact checkpoint and finalizes.
      const auth = await authorizeTaskApprovalResume(
        { taskId: ids.taskId, threadId: ids.graphThreadId, sessionUserId: userId },
        { db },
      );
      expect(auth.ok).toBe(true);
      if (!auth.ok) return;
      const result = await runTaskApprovalResume(
        {
          task: auth.task,
          run: auth.run,
          invocationAuthority: createAcceptedInvocationAuthority(auth.task.requestorId),
          maintenanceAuthority: createMaintenanceAcceptanceAuthority(),
          kind: "ask",
          verb: "deny",
        },
        { db },
      );
      expect(result.reparked).toBe(false);
      await pollTask(ids.taskId, (s) => s === "completed");
      const [completedRun] = await getTaskRuns(db, ids.taskId);
      expect(completedRun?.resultText).toBe("Understood — I won't write that file.");
      expect(events.filter((event) => event.type === "task.status" && event.taskId === ids.taskId)
        .map((event) => (event as { status: string }).status)).toContain("running");
    } finally {
      cleanup();
    }
  }, 60_000);

  test("another user cannot resume the Task approval (404 fail-closed)", async () => {
    const ids = await seedRunningTask();
    setStub([
      {
        type: "tool_call",
        name: "file",
        args: {
          command: "write",
          zone: "workspace",
          path: "m164-denied-write-mv3.txt",
          content: "This write must remain denied.",
        },
        id: "tc-mv3",
      },
      { type: "text", content: "ok" },
    ]);
    const { cleanup } = collectEvents(eventBus);
    try {
      await runExecutorToPark(ids);
      await pollTask(ids.taskId, (s) => s === "awaiting");

      const intruder = await authorizeTaskApprovalResume(
        { taskId: ids.taskId, threadId: ids.graphThreadId, sessionUserId: strangerUserId },
        { db },
      );
      expect(intruder).toEqual({ ok: false, status: 404, error: "task_approval_not_found" });

      // The real owner is still authorized (defense-in-depth: the row is intact).
      const owner = await authorizeTaskApprovalResume(
        { taskId: ids.taskId, threadId: ids.graphThreadId, sessionUserId: userId },
        { db },
      );
      expect(owner.ok).toBe(true);
    } finally {
      cleanup();
    }
  }, 60_000);

  test("chained approval: deny re-parks on the next gated tool, emits the next Task approval.ask, task stays awaiting", async () => {
    const ids = await seedRunningTask();
    setStub([
      {
        type: "tool_call",
        name: "file",
        args: {
          command: "write",
          zone: "workspace",
          path: "m164-denied-write-chain-1.txt",
          content: "First denied write.",
        },
        id: "tc-chain-1",
      },
      {
        type: "tool_call",
        name: "file",
        args: {
          command: "write",
          zone: "workspace",
          path: "m164-denied-write-chain-2.txt",
          content: "Second denied write.",
        },
        id: "tc-chain-2",
      },
      { type: "text", content: "All done — both declined." },
    ]);

    const { events, cleanup } = collectEvents(eventBus);
    try {
      await runExecutorToPark(ids);
      expect(taskApprovalEvents(events, ids.taskId).length).toBe(1);
      await pollTask(ids.taskId, (s) => s === "awaiting");

      // First deny → the resumed turn requests a second gated tool → re-park.
      const auth1 = await authorizeTaskApprovalResume(
        { taskId: ids.taskId, threadId: ids.graphThreadId, sessionUserId: userId },
        { db },
      );
      expect(auth1.ok).toBe(true);
      if (!auth1.ok) return;
      const first = await runTaskApprovalResume(
        {
          task: auth1.task,
          run: auth1.run,
          invocationAuthority: createAcceptedInvocationAuthority(auth1.task.requestorId),
          maintenanceAuthority: createMaintenanceAcceptanceAuthority(),
          kind: "ask",
          verb: "deny",
        },
        { db },
      );
      expect(first.reparked).toBe(true);

      // The chained interrupt was emitted as a SECOND Task-originated approval.
      const asks = taskApprovalEvents(events, ids.taskId);
      expect(asks.length).toBeGreaterThanOrEqual(2);
      expect(asks[asks.length - 1]!.origin).toBe("task");
      // Task is still awaiting (no premature completion).
      const mid = await getTaskById(db, ids.taskId);
      expect(mid?.status).toBe("awaiting");

      // Second deny → terminal.
      const auth2 = await authorizeTaskApprovalResume(
        { taskId: ids.taskId, threadId: ids.graphThreadId, sessionUserId: userId },
        { db },
      );
      expect(auth2.ok).toBe(true);
      if (!auth2.ok) return;
      const second = await runTaskApprovalResume(
        {
          task: auth2.task,
          run: auth2.run,
          invocationAuthority: createAcceptedInvocationAuthority(auth2.task.requestorId),
          maintenanceAuthority: createMaintenanceAcceptanceAuthority(),
          kind: "ask",
          verb: "deny",
        },
        { db },
      );
      expect(second.reparked).toBe(false);
      await pollTask(ids.taskId, (s) => s === "completed");
    } finally {
      cleanup();
    }
  }, 90_000);
});


test("approval claims and durable progress obey exact run, owner, and terminal state", async () => {
  const ids = await seedRunningTask();
  await db.update(tasks).set({ status: "awaiting" }).where(eq(tasks.id, ids.taskId));
  await db.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, ids.runId));
  const claim = { ...ids, runId: ids.runId, ownerId: userId, from: "awaiting" as const, to: "running" as const };
  expect(await transitionTaskApprovalExecution(db, { ...claim, ownerId: strangerUserId })).toBe(false);
  expect(await transitionTaskApprovalExecution(db, { ...claim, graphThreadId: "wrong-checkpoint" })).toBe(false);
  expect(await transitionTaskApprovalExecution(db, claim)).toBe(true);
  expect(await transitionTaskApprovalExecution(db, claim)).toBe(false);
  const progress = { taskId: ids.taskId, taskRunId: ids.runId, ownerId: userId,
    preparation: { stage: "waiting_model", privateText: "must not persist" }, updatedAt: new Date().toISOString() };
  await recordTaskPreparation(db, progress);
  expect((await getTaskById(db, ids.taskId))?.metadata?.["preparation"]).toEqual({
    stage: "waiting_model", taskRunId: ids.runId, updatedAt: progress.updatedAt,
  });
  await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, ids.taskId));
  expect(await transitionTaskApprovalExecution(db, { ...claim, from: "running", to: "awaiting" })).toBe(false);
  await recordTaskPreparation(db, { ...progress, preparation: { stage: "model_responding" } });
  expect((await getTaskById(db, ids.taskId))?.metadata?.["preparation"]).toMatchObject({ stage: "waiting_model" });
});


test("ordinary recovery claims only the latest exact TaskRun and preserves superseded work", async () => {
  const ids = await seedRunningTask();
  await db.update(tasks).set({ status: "awaiting" }).where(eq(tasks.id, ids.taskId));
  await db.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, ids.runId));
  const newer = await insertTaskRun(db, {
    taskId: ids.taskId, graphThreadId: `subagent:m322-newer:${randomUUID()}`,
    status: "completed", modelId: process.env["NAUTILO_MODEL"]!,
    startedAt: new Date(Date.now() + 1_000),
  });
  const claim = { ...ids, ownerId: userId, from: "awaiting" as const,
    to: "running" as const, requireLatestRun: true };
  expect(await transitionTaskApprovalExecution(db, claim)).toBe(false);
  expect((await getTaskById(db, ids.taskId))?.status).toBe("awaiting");
  expect((await getTaskRuns(db, ids.taskId)).find((run) => run.id === ids.runId)?.status).toBe("awaiting");
  await db.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, newer.id));
  expect(await transitionTaskApprovalExecution(db, {
    ...claim, runId: newer.id, graphThreadId: newer.graphThreadId,
  })).toBe(true);
  expect((await getTaskById(db, ids.taskId))?.status).toBe("running");
  expect((await getTaskRuns(db, ids.taskId)).find((run) => run.id === ids.runId)?.status).toBe("awaiting");
});

test("Pause preserves an awaiting null-job checkpoint and fences stale approval admission", async () => {
  const ids = await seedRunningTask();
  await db.update(tasks).set({ status: "awaiting" }).where(eq(tasks.id, ids.taskId));
  await db.update(taskRuns).set({ status: "awaiting", jobId: null }).where(eq(taskRuns.id, ids.runId));
  // Existing running-job query intentionally cannot represent this worker.
  expect(await getActiveTaskRun(db, ids.taskId)).toBeUndefined();
  const aborts: unknown[][] = [];
  expect((await pauseTask({ db, jobManager: { abortJob: (...args) => { aborts.push(args); return false; } } }, ids.taskId)).status).toBe("paused");
  expect(aborts).toEqual([["", "pause", { taskId: ids.taskId, taskRunId: ids.runId }]]);
  expect((await getLatestResumableTaskRun(db, ids.taskId))?.id).toBe(ids.runId);
  expect((await getTaskById(db, ids.taskId))?.status).toBe("paused");
  expect(await transitionTaskApprovalExecution(db, { ...ids, ownerId: userId, from: "awaiting", to: "running" })).toBe(false);
});

test("Pause and guarded completion serialize on the same parent lock without overwriting the winner", async () => {
  for (const winner of ["pause", "complete"] as const) {
    const ids = await seedRunningTask();
    const complete = (connection: DirectDatabase) => transitionTaskLifecycleTerminal(connection, {
      taskId: ids.taskId, runId: ids.runId, taskStatus: "completed", runStatus: "completed", requireRunningPair: true,
    });
    let losing: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(tasks).where(eq(tasks.id, ids.taskId)).for("update");
      // The losing operation is started against a separate connection while
      // this transaction holds the same row lock used by both transitions.
      losing = winner === "pause" ? complete(db) : transitionTaskLifecyclePaused(db, ids.taskId);
      if (winner === "pause") await transitionTaskLifecyclePaused(tx as unknown as DirectDatabase, ids.taskId);
      else await complete(tx as unknown as DirectDatabase);
    });
    const result = await losing as { transitioned: boolean; outcome: string };
    expect(result.transitioned).toBe(false);
    expect(result.outcome).toBe(winner === "pause" ? "not_running" : "task_terminal");
    expect((await getTaskById(db, ids.taskId))?.status).toBe(winner === "pause" ? "paused" : "completed");
    expect((await getTaskRuns(db, ids.taskId))[0]?.status).toBe(winner === "pause" ? "paused" : "completed");
  }
});

test("Pause selects newest first and does not pause an older run behind a completed run", async () => {
  const ids = await seedRunningTask();
  await db.update(taskRuns).set({ startedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(taskRuns.id, ids.runId));
  const latest = await insertTaskRun(db, { taskId: ids.taskId, graphThreadId: `subagent:m164:${randomUUID()}`,
    status: "completed", modelId: process.env["NAUTILO_MODEL"]! });
  const result = await transitionTaskLifecyclePaused(db, ids.taskId);
  expect(result.run).toBeUndefined(); expect(result.task?.status).toBe("paused");
  const runs = await getTaskRuns(db, ids.taskId);
  expect(runs.find((run) => run.id === ids.runId)?.status).toBe("running");
  expect(runs.find((run) => run.id === latest.id)?.status).toBe("completed");
  expect(await getLatestResumableTaskRun(db, ids.taskId)).toBeUndefined();
});


test("atomic Pause handles pending Tasks without a run and preserves external Writer waits", async () => {
  const pending = await seedRunningTask();
  await db.delete(taskRuns).where(eq(taskRuns.id, pending.runId));
  await db.update(tasks).set({ status: "pending", fireLockId: randomUUID(), fireLockedAt: new Date() })
    .where(eq(tasks.id, pending.taskId));
  const paused = await transitionTaskLifecyclePaused(db, pending.taskId);
  expect(paused.transitioned).toBe(true); expect(paused.run).toBeUndefined();
  expect(paused.task).toMatchObject({ status: "paused", fireLockId: null, fireLockedAt: null });
  expect((await transitionTaskLifecyclePaused(db, pending.taskId)).outcome).toBe("already_paused");
  const writer = await seedRunningTask();
  await db.update(tasks).set({ status: "awaiting", metadata: { writerReviewAwaiting: {
    version: 1, taskRunId: writer.runId, proposalId: "external-review",
  } } }).where(eq(tasks.id, writer.taskId));
  await db.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, writer.runId));
  const waiting = await transitionTaskLifecyclePaused(db, writer.taskId);
  expect(waiting.outcome).toBe("writer_review_pending"); expect(waiting.transitioned).toBe(false);
  expect((await getTaskById(db, writer.taskId))?.status).toBe("awaiting");
  expect((await getTaskRuns(db, writer.taskId))[0]?.status).toBe("awaiting");
});
