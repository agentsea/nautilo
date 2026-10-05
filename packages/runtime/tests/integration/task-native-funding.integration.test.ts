/**
 * Native Task funding persistence against an isolated real database. Provider
 * policy and key custody stay behind an installed in-process funding port; no
 * provider or server process is contacted by this suite.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";

import {
  claimCallerTaskRunJob,
  createTask,
  eq,
  getCallerFundedRunningTaskRunRestartBoundary,
  getTaskById,
  getTaskRuns,
  insertTaskRun,
  jobs,
  listCallerFundedRunningTaskRunsForRestart,
  markTaskRunStatus,
  pauseTaskRunForFundingDenial,
  tasks,
  updateTask,
  type DirectDatabase,
  type NewTask,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import { parseTaskFundingBinding, type TaskFundingBinding } from "@nautilo/types";

import {
  installTaskFundingPort,
  TaskFundingError,
  uninstallTaskFundingPort,
  type TaskFundingAdmission,
  type TaskFundingPort,
} from "../../src/task-funding-port";
import {
  dispatchTaskRun,
  type DispatchTaskRunDeps,
  type TaskJobManager,
} from "../../src/tasks/dispatch-task-run";
import { pauseTask, unpauseTask } from "../../src/tasks/lifecycle";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
} from "./helpers";
import { closeAgentDb, setupAgentTestEnv } from "./agent-helpers";

let db: DirectDatabase;
let userId: string;
let agentId: string;
let admit: (task: Task, priorRun?: TaskRun) => Promise<TaskFundingAdmission>;
let admissionCalls: Array<{ taskId: string; priorRunId: string | null }> = [];
let serverFundingChecks = 0;

const jobManager: TaskJobManager = {
  createForegroundJob: async () => {
    const id = `native-funding-job-${randomUUID()}`;
    return { id, virtualJobId: id };
  },
};

const fundingPort: TaskFundingPort = {
  prepareCreation: async () => true,
  admit: async (task, priorRun) => {
    admissionCalls.push({ taskId: task.id, priorRunId: priorRun?.id ?? null });
    return admit(task, priorRun);
  },
  openSession: async () => {
    throw new Error("task-native-funding integration never executes a provider session");
  },
};

function personalBinding(revision: number): TaskFundingBinding {
  return {
    kind: "personal",
    providerRoute: "openai",
    credentialId: "10000000-0000-4000-8000-000000000001",
    credentialRevision: revision,
  };
}

async function insertDefinition(
  overrides: Partial<NewTask> = {},
): Promise<Task> {
  return createTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "Return one short line.",
    preset: "in_background",
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "none",
    targetUserIds: [userId],
    fundingMode: "caller",
    nextFireAt: new Date(),
    status: "pending",
    fireLockId: randomUUID(),
    fireLockedAt: new Date(),
    ...overrides,
  });
}

function dispatchDeps(): DispatchTaskRunDeps {
  return {
    db,
    jobManager,
    assertInvocation: async () => {},
    assertServerFunding: async () => {
      serverFundingChecks += 1;
    },
  };
}

async function dispatchCurrent(taskId: string) {
  await updateTask(db, taskId, { fireLockId: randomUUID(), fireLockedAt: new Date() });
  const task = await getTaskById(db, taskId);
  if (!task) throw new Error(`missing Task ${taskId}`);
  return dispatchTaskRun(task, dispatchDeps());
}

beforeAll(async () => {
  ({ userId, agentId } = await setupAgentTestEnv("task-native-funding"));
  db = getDirectDb();
  installTaskFundingPort(fundingPort);
});

beforeEach(() => {
  admissionCalls = [];
  serverFundingChecks = 0;
  admit = async (task, priorRun) => ({
    modelId: priorRun?.modelId ?? task.requestedModelId ?? "openai:gpt-6-sol",
    binding: priorRun?.fundingBinding
      ? parseTaskFundingBinding(priorRun.fundingBinding)
      : personalBinding(1),
  });
});

afterEach(async () => {
  await db.delete(tasks).where(eq(tasks.ownerId, userId));
});

afterAll(async () => {
  uninstallTaskFundingPort();
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

describe("native Task funding storage and dispatch", () => {
  test("persists the admitted binding beside the actual dispatch model", async () => {
    const task = await insertDefinition({ requestedModelId: "openai:gpt-6-sol" });
    const result = await dispatchCurrent(task.id);
    expect(result.kind).toBe("dispatched");

    const [run] = await getTaskRuns(db, task.id);
    expect(run?.modelId).toBe("openai:gpt-6-sol");
    expect(run?.fundingBinding).toEqual(personalBinding(1));
    expect(admissionCalls).toEqual([{ taskId: task.id, priorRunId: null }]);
    expect(serverFundingChecks).toBe(0);
  });

  test("a checkpoint continuation carries its predecessor binding", async () => {
    const task = await insertDefinition({
      requestedModelId: "openai:gpt-6-sol",
      targetRoomId: null,
    });
    const predecessor = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:${task.id}:checkpoint`,
      status: "paused",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(7),
    });

    const result = await dispatchCurrent(task.id);
    expect(result.kind).toBe("dispatched");
    const runs = await getTaskRuns(db, task.id);
    const continuation = runs.find((run) => run.id !== predecessor.id);
    expect(continuation?.graphThreadId).toBe(predecessor.graphThreadId);
    expect(continuation?.fundingBinding).toEqual(personalBinding(7));
    expect(continuation?.fundingPredecessorRunId).toBe(predecessor.id);
    expect(admissionCalls).toEqual([{
      taskId: task.id,
      priorRunId: predecessor.id,
    }]);
  });

  test("separate recurring occurrences receive fresh funding admissions", async () => {
    let revision = 0;
    admit = async () => ({
      modelId: "openai:gpt-6-sol",
      binding: personalBinding(++revision),
    });
    const task = await insertDefinition({
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
    });

    const first = await dispatchCurrent(task.id);
    expect(first.kind).toBe("dispatched");
    if (first.kind !== "dispatched") throw new Error("first occurrence not dispatched");
    await markTaskRunStatus(db, first.runId, "completed", { completedAt: new Date() });
    await updateTask(db, task.id, {
      status: "pending",
      nextFireAt: new Date(),
      fireLockId: randomUUID(),
      fireLockedAt: new Date(),
    });

    const second = await dispatchCurrent(task.id);
    expect(second.kind).toBe("dispatched");
    const runs = await getTaskRuns(db, task.id);
    expect(runs.map((run) => run.fundingBinding)).toEqual([
      personalBinding(1),
      personalBinding(2),
    ]);
    expect(runs.map((run) => run.fundingPredecessorRunId)).toEqual([null, null]);
    expect(admissionCalls.map((call) => call.priorRunId)).toEqual([null, null]);
  });

  test("an older recurring occurrence claims and settles without changing its newer schedule", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1_000);
    const task = await insertDefinition({
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
      status: "pending",
      nextFireAt: future,
      fireLockId: null,
      fireLockedAt: null,
    });
    const startedAt = Date.now();
    const olderRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(1),
      startedAt: new Date(startedAt - 2_000),
    });
    const newerRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(2),
      startedAt: new Date(startedAt - 1_000),
    });
    const [job] = await db.insert(jobs).values({
      ownerId: userId,
      requestorId: userId,
      laneKey: `task:${task.id}`,
      type: "foreground",
      status: "queued",
      input: { taskId: task.id, taskRunId: olderRun.id },
    }).returning({ id: jobs.id });
    if (!job) throw new Error("older recurring occurrence fixture did not persist its Job");

    expect(await claimCallerTaskRunJob(db, {
      taskId: task.id,
      taskRunId: olderRun.id,
      requestorId: userId,
      graphThreadId: olderRun.graphThreadId,
      jobId: job.id,
    })).toBe(true);
    expect(await pauseTaskRunForFundingDenial(db, {
      taskId: task.id,
      taskRunId: olderRun.id,
      requestorId: userId,
      reason: "personal_credential_unavailable",
    })).toMatchObject({ transitioned: true, task: undefined });

    const runs = await getTaskRuns(db, task.id);
    const settledOlderRun = runs.find((run) => run.id === olderRun.id);
    expect(settledOlderRun).toMatchObject({
      status: "errored",
      jobId: job.id,
      lastError: "personal_credential_unavailable",
    });
    expect(settledOlderRun?.completedAt).toBeInstanceOf(Date);
    expect(runs.find((run) => run.id === newerRun.id)).toMatchObject({
      status: "running",
      lastError: null,
    });
    expect(await getTaskById(db, task.id)).toMatchObject({
      status: "pending",
      nextFireAt: future,
      lastError: null,
    });
  });

  test("a database-timestamped latest occurrence parks with its definition on funding denial", async () => {
    const task = await insertDefinition({
      status: "running",
      nextFireAt: null,
      fireLockId: null,
      fireLockedAt: null,
    });
    const run = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(1),
    });

    expect(await pauseTaskRunForFundingDenial(db, {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: userId,
      reason: "personal_credential_unavailable",
    })).toMatchObject({ transitioned: true });
    expect(await getTaskById(db, task.id)).toMatchObject({
      status: "paused",
      lastError: "personal_credential_unavailable",
    });
    expect((await getTaskRuns(db, task.id)).find((candidate) => candidate.id === run.id))
      .toMatchObject({ status: "paused", lastError: "personal_credential_unavailable" });
  });

  test("a frozen restart boundary excludes a run inserted afterward", async () => {
    const task = await insertDefinition({
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
      status: "pending",
      nextFireAt: new Date(Date.now() + 60 * 60 * 1_000),
      fireLockId: null,
      fireLockedAt: null,
    });
    const interrupted = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(1),
    });
    const boundary = await getCallerFundedRunningTaskRunRestartBoundary(db);
    if (!boundary) throw new Error("restart boundary fixture found no candidate");
    const freshRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(2),
      startedAt: new Date(Date.now() + 1_000),
    });

    const candidates = await listCallerFundedRunningTaskRunsForRestart(db, {
      limit: 10,
      through: boundary,
    });
    expect(candidates.some(({ run }) => run.id === interrupted.id)).toBe(true);
    expect(candidates.some(({ run }) => run.id === freshRun.id)).toBe(false);
  });

  test("a safe funding denial pauses the exact claimed definition before a run", async () => {
    admit = async () => {
      throw new TaskFundingError("personal_credential_missing");
    };
    const task = await insertDefinition({
      fireLockId: randomUUID(),
      fireLockedAt: new Date(),
    });

    expect((await dispatchCurrent(task.id)).kind).toBe("authorization_paused");
    expect(await getTaskRuns(db, task.id)).toEqual([]);
    expect(await getTaskById(db, task.id)).toMatchObject({
      status: "paused",
      lastError: "personal_credential_missing",
      fireLockId: null,
      fireLockedAt: null,
    });
  });

  test("legacy definitions keep server admission and a null binding", async () => {
    const task = await insertDefinition({
      fundingMode: "legacy_server",
      requestedModelId: "openai:gpt-6-sol",
    });
    expect((await dispatchCurrent(task.id)).kind).toBe("dispatched");
    const [run] = await getTaskRuns(db, task.id);
    expect(run?.fundingBinding).toBeNull();
    expect(admissionCalls).toEqual([]);
    expect(serverFundingChecks).toBe(1);
  });

  test("funding repair clears its banner, while Stop wins a concurrent resume", async () => {
    const repair = await insertDefinition({ status: "paused", lastError: "personal_provider_unavailable" });
    await insertTaskRun(db, { taskId: repair.id, graphThreadId: `subagent:${repair.id}:repair`,
      status: "paused", modelId: "openai:gpt-6-sol", fundingBinding: personalBinding(1) });
    const lifecycle = { db, jobManager: { abortJob: () => false }, observer: null };
    expect(await unpauseTask(lifecycle, repair.id)).toMatchObject({ ok: true, status: "pending" });
    expect(await getTaskById(db, repair.id)).toMatchObject({ status: "pending", lastError: null });

    const raced = await insertDefinition({ status: "paused", lastError: "personal_provider_unavailable" });
    admit = async () => {
      await updateTask(db, raced.id, { status: "cancelled", cancelledAt: new Date() });
      return { modelId: "openai:gpt-6-sol", binding: personalBinding(1) };
    };
    expect(await unpauseTask(lifecycle, raced.id)).toMatchObject({ ok: false, status: "changed" });
    expect(await getTaskById(db, raced.id)).toMatchObject({ status: "cancelled" });

    const uncertain = await insertDefinition({ status: "paused", lastError: "funding_interrupted_uncertain" });
    const before = admissionCalls.length;
    expect(await unpauseTask(lifecycle, uncertain.id)).toMatchObject({ ok: false, status: "paused" });
    expect(admissionCalls.length).toBe(before);
  });

  test("startup settles only orphaned caller-funded runs and preserves future cron state", async () => {
    const interrupted = await insertDefinition({ status: "running", nextFireAt: null });
    const interruptedRun = await insertTaskRun(db, {
      taskId: interrupted.id,
      graphThreadId: `subagent:task:${interrupted.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(3),
    });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const recurring = await insertDefinition({
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
      status: "pending",
      nextFireAt: future,
    });
    const recurringNow = Date.now();
    const olderRecurringRun = await insertTaskRun(db, {
      taskId: recurring.id,
      graphThreadId: `subagent:task:${recurring.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(4),
      startedAt: new Date(recurringNow - 2_000),
    });
    const recurringRun = await insertTaskRun(db, {
      taskId: recurring.id,
      graphThreadId: `subagent:task:${recurring.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: personalBinding(5),
      startedAt: new Date(recurringNow - 1_000),
    });
    const legacy = await insertDefinition({
      fundingMode: "legacy_server",
      status: "running",
      nextFireAt: null,
    });
    const legacyRun = await insertTaskRun(db, {
      taskId: legacy.id,
      graphThreadId: `subagent:task:${legacy.id}:${randomUUID()}`,
      status: "running",
      modelId: "openai:gpt-6-sol",
      fundingBinding: null,
    });
    const pendingWithoutRun = await insertDefinition({ nextFireAt: future });

    let failedRestartTransaction = false;
    let restartTransactionAttempts = 0;
    const failOnceDb = new Proxy<DirectDatabase>(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (...args: Parameters<DirectDatabase["transaction"]>) => {
            restartTransactionAttempts += 1;
            if (!failedRestartTransaction) {
              failedRestartTransaction = true;
              throw new Error("synthetic transient restart transaction failure");
            }
            return target.transaction(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown
          : value;
      },
    });
    const observer = new TaskObserver({
      db: failOnceDb,
      jobManager: { ...jobManager, abortJob: () => false },
      maintenanceGate: {
        isAcceptingWork: async () => false,
        assertAcceptingNewWork: async () => { throw new Error("not accepting"); },
      },
      batch: 1,
      intervalMs: 60_000,
    });
    await observer.start();
    await observer.stop();

    expect(failedRestartTransaction).toBe(true);
    expect(restartTransactionAttempts).toBeGreaterThan(1);

    expect(await getTaskById(db, interrupted.id)).toMatchObject({
      status: "paused",
      lastError: "funding_interrupted_uncertain",
    });
    expect((await getTaskRuns(db, interrupted.id)).find((run) => run.id === interruptedRun.id))
      .toMatchObject({ status: "errored", lastError: "funding_interrupted_uncertain" });
    expect(await getTaskById(db, recurring.id)).toMatchObject({
      status: "pending",
      nextFireAt: future,
      lastError: "funding_interrupted_uncertain",
    });
    expect((await getTaskRuns(db, recurring.id)).find((run) => run.id === recurringRun.id))
      .toMatchObject({ status: "errored", lastError: "funding_interrupted_uncertain" });
    expect((await getTaskRuns(db, recurring.id)).find((run) => run.id === olderRecurringRun.id))
      .toMatchObject({ status: "errored", lastError: "funding_interrupted_uncertain" });
    expect(await getTaskById(db, legacy.id)).toMatchObject({ status: "running", lastError: null });
    expect((await getTaskRuns(db, legacy.id)).find((run) => run.id === legacyRun.id))
      .toMatchObject({ status: "running", lastError: null });
    expect(await getTaskById(db, pendingWithoutRun.id)).toMatchObject({
      status: "pending",
      nextFireAt: future,
      lastError: null,
    });

    const lifecycle = { db, jobManager: { abortJob: () => false }, observer: null };
    expect(await pauseTask(lifecycle, recurring.id)).toMatchObject({ ok: true, status: "paused" });
    expect(await unpauseTask(lifecycle, recurring.id)).toMatchObject({ ok: true, status: "pending" });
    const rearmed = await getTaskById(db, recurring.id);
    expect(rearmed).toMatchObject({ status: "pending", lastError: null });
    expect(rearmed?.nextFireAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
