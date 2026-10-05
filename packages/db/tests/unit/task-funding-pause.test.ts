import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  claimCallerTaskRunJob,
  getCallerFundedRunningTaskRunRestartBoundary,
  listCallerFundedRunningTaskRunsForRestart,
  pauseClaimedTaskForFundingDenial,
  pauseTaskRunForFundingDenial,
  recordTaskWakeFundingFailure,
  reconcileCallerFundedTaskRunAfterRestart,
  startClaimedCallerTaskRun,
} from "../../src/queries/tasks";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const task = {
  id: "10000000-0000-4000-8000-000000000001",
  requestorId: "20000000-0000-4000-8000-000000000002",
  status: "running",
  fundingMode: "caller",
  fireLockId: null,
  fireLockedAt: null,
} as Task;

const run = {
  id: "40000000-0000-4000-8000-000000000004",
  taskId: task.id,
  status: "running",
  jobId: null,
  graphThreadId: "subagent:task:10000000-0000-4000-8000-000000000001:run",
  modelId: "openai:gpt-6-sol",
  fundingBinding: { kind: "server", providerRoute: "openai" },
  fundingPredecessorRunId: null,
  startedAt: new Date("2026-10-03T12:00:00.000Z"),
  resultText: null,
  lastError: null,
} as TaskRun;

function aggregateHarness(input: {
  task?: Task;
  run?: TaskRun;
  latestRunId?: string;
}) {
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const tx = {
    select: (shape?: unknown) => ({
      from: (table: unknown) => {
        const rows = shape
          ? (input.latestRunId ? [{ id: input.latestRunId }] : [])
          : table === tasks
            ? (input.task ? [input.task] : [])
            : (input.run ? [input.run] : []);
        const query = {
          where: (_condition: unknown) => query,
          orderBy: (..._order: unknown[]) => query,
          limit: (_limit: number) => query,
          for: async (_kind: string) => rows,
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            writes.push({ table, patch });
            if (table === tasks && input.task) return [{ ...input.task, ...patch }];
            if (table === taskRuns && input.run) return [{ ...input.run, ...patch }];
            return [];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: (operation: (handle: typeof tx) => unknown) => operation(tx),
  } as unknown as DirectDatabase;
  return { db, writes };
}

function callerStartHarness(input: { task?: Task; predecessor?: TaskRun }) {
  const inserted: Record<string, unknown>[] = [];
  const taskPatches: Record<string, unknown>[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === tasks
          ? (input.task ? [input.task] : [])
          : (input.predecessor ? [input.predecessor] : []);
        const query = {
          where: (_condition: unknown) => query,
          orderBy: (..._order: unknown[]) => query,
          limit: (_limit: number) => query,
          for: async (_kind: string) => rows,
        };
        return query;
      },
    }),
    insert: (table: unknown) => {
      expect(table).toBe(taskRuns);
      return {
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            inserted.push(values);
            return [{
              id: "80000000-0000-4000-8000-000000000008",
              jobId: null,
              startedAt: new Date("2026-10-03T12:00:00.000Z"),
              completedAt: null,
              resultText: null,
              lastError: null,
              ...values,
            }];
          },
        }),
      };
    },
    update: (table: unknown) => {
      expect(table).toBe(tasks);
      return {
        set: (patch: Record<string, unknown>) => ({
          where: (_condition: unknown) => ({
            returning: async () => {
              taskPatches.push(patch);
              return input.task ? [{ ...input.task, ...patch }] : [];
            },
          }),
        }),
      };
    },
  };
  const db = {
    transaction: (operation: (handle: typeof tx) => unknown) => operation(tx),
  } as unknown as DirectDatabase;
  return { db, inserted, taskPatches };
}

describe("funding-denied Task claim pause", () => {
  test("atomically consumes an exact caller claim without clearing observer-owned fields", async () => {
    const claimed = {
      ...task,
      status: "pending",
      fireLockId: "30000000-0000-4000-8000-000000000003",
      fireLockedAt: new Date("2026-10-03T11:59:00.000Z"),
      nextFireAt: new Date("2026-10-03T12:00:00.000Z"),
    } as Task;
    const harness = callerStartHarness({ task: claimed });
    const started = await startClaimedCallerTaskRun(harness.db, {
      taskId: claimed.id,
      requestorId: claimed.requestorId,
      fireLockId: claimed.fireLockId!,
      graphThreadId: run.graphThreadId,
      modelId: run.modelId!,
      fundingBinding: run.fundingBinding!,
    });
    expect(started).toMatchObject({
      taskId: claimed.id,
      status: "running",
      fundingPredecessorRunId: null,
    });
    expect(harness.inserted).toHaveLength(1);
    expect(harness.taskPatches).toHaveLength(1);
    expect(harness.taskPatches[0]).toMatchObject({ status: "running", lastError: null });
    expect(harness.taskPatches[0]).not.toHaveProperty("fireLockId");
    expect(harness.taskPatches[0]).not.toHaveProperty("fireLockedAt");
    expect(harness.taskPatches[0]).not.toHaveProperty("nextFireAt");
  });

  test("rejects a stale, stopped, foreign, or legacy caller claim before writes", async () => {
    const fireLockId = "30000000-0000-4000-8000-000000000003";
    const candidates = [
      { ...task, status: "pending", fireLockId: "different" },
      { ...task, status: "cancelled", fireLockId },
      { ...task, status: "pending", fireLockId, requestorId: "foreign" },
      { ...task, status: "pending", fireLockId, fundingMode: "legacy_server" },
    ] as Task[];
    for (const candidate of candidates) {
      const harness = callerStartHarness({ task: candidate });
      expect(await startClaimedCallerTaskRun(harness.db, {
        taskId: task.id,
        requestorId: task.requestorId,
        fireLockId,
        graphThreadId: run.graphThreadId,
        modelId: run.modelId!,
        fundingBinding: run.fundingBinding!,
      })).toBeUndefined();
      expect(harness.inserted).toEqual([]);
      expect(harness.taskPatches).toEqual([]);
    }
  });

  test("continues only the exact latest paused run with identical funding facts", async () => {
    const claimed = {
      ...task,
      status: "pending",
      fireLockId: "30000000-0000-4000-8000-000000000003",
    } as Task;
    const predecessor = { ...run, status: "paused" } as TaskRun;
    const base = {
      taskId: claimed.id,
      requestorId: claimed.requestorId,
      fireLockId: claimed.fireLockId!,
      graphThreadId: predecessor.graphThreadId,
      modelId: predecessor.modelId!,
      fundingBinding: predecessor.fundingBinding!,
      fundingPredecessorRunId: predecessor.id,
    };
    const accepted = callerStartHarness({ task: claimed, predecessor });
    expect(await startClaimedCallerTaskRun(accepted.db, base)).toMatchObject({
      fundingPredecessorRunId: predecessor.id,
    });

    for (const different of [
      { ...predecessor, id: "90000000-0000-4000-8000-000000000009" },
      { ...predecessor, status: "awaiting" as const },
      { ...predecessor, graphThreadId: "different" },
      { ...predecessor, modelId: "openai:different" },
      { ...predecessor, fundingBinding: { kind: "server" as const, providerRoute: "anthropic" } },
    ]) {
      const harness = callerStartHarness({ task: claimed, predecessor: different as TaskRun });
      expect(await startClaimedCallerTaskRun(harness.db, base)).toBeUndefined();
      expect(harness.inserted).toEqual([]);
    }
  });

  test("pages only bounded caller-funded running restart candidates", async () => {
    const cursorStartedAt = "2026-10-03 12:00:00.123456+00";
    const rawRows = [{ task, run, cursorStartedAt }];
    const expectedRows = [{
      task,
      run,
      cursor: { startedAt: cursorStartedAt, runId: run.id },
    }];
    let limit: number | undefined;
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    const query = {
      innerJoin: () => query,
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => { whereSql = condition; return query; },
      orderBy: () => query,
      limit: (value: number) => { limit = value; return Promise.resolve(rawRows); },
    };
    const db = { select: () => ({ from: () => query }) } as unknown as DirectDatabase;
    expect(await listCallerFundedRunningTaskRunsForRestart(db, {
      limit: 7,
      through: {
        startedAt: "2026-10-03 13:00:00.654321+00",
        runId: "f0000000-0000-4000-8000-00000000000f",
      },
      after: { startedAt: cursorStartedAt, runId: run.id },
    })).toEqual(expectedRows);
    expect(limit).toBe(7);
    const rendered = new PgDialect().sqlToQuery(whereSql!);
    expect(rendered.sql).toContain('"tasks"."funding_mode" =');
    expect(rendered.sql).toContain('"task_runs"."status" =');
    expect(rendered.sql).toContain('"task_runs"."started_at" >');
    expect(rendered.sql).toContain('"task_runs"."started_at" <');
    expect(rendered.sql).toContain('"task_runs"."id" <=');
    expect(rendered.params).toContain("caller");
    expect(rendered.params).toContain("running");
    expect(await listCallerFundedRunningTaskRunsForRestart(db, {
      limit: 0,
      through: { startedAt: cursorStartedAt, runId: run.id },
    })).toEqual([]);
  });

  test("freezes the newest restart candidate using database-authored ordering", async () => {
    const boundary = {
      startedAt: "2026-10-03 12:00:00.123456+00",
      runId: run.id,
    };
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    const query = {
      innerJoin: () => query,
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        whereSql = condition;
        return query;
      },
      orderBy: () => query,
      limit: async () => [boundary],
    };
    const db = { select: () => ({ from: () => query }) } as unknown as DirectDatabase;

    expect(await getCallerFundedRunningTaskRunRestartBoundary(db)).toEqual(boundary);
    const rendered = new PgDialect().sqlToQuery(whereSql!);
    expect(rendered.params).toContain("caller");
    expect(rendered.params).toContain("running");
  });

  test("terminalizes a latest interrupted run and parks a non-recurring Task", async () => {
    const harness = aggregateHarness({ task, run });
    const result = await reconcileCallerFundedTaskRunAfterRestart(harness.db, {
      taskId: task.id,
      taskRunId: run.id,
    });
    expect(result.transitioned).toBe(true);
    expect(harness.writes.find((write) => write.table === taskRuns)?.patch).toMatchObject({
      status: "errored",
      lastError: "funding_interrupted_uncertain",
    });
    expect(harness.writes.find((write) => write.table === tasks)?.patch).toMatchObject({
      status: "paused",
      lastError: "funding_interrupted_uncertain",
      fireLockId: null,
      fireLockedAt: null,
    });
  });

  test("keeps a cron definition pending at its future fire while settling its interrupted run", async () => {
    const cronTask = {
      ...task,
      status: "pending",
      scheduleKind: "cron",
      nextFireAt: new Date("2026-10-04T09:00:00.000Z"),
    } as Task;
    const harness = aggregateHarness({ task: cronTask, run });
    const result = await reconcileCallerFundedTaskRunAfterRestart(harness.db, {
      taskId: task.id,
      taskRunId: run.id,
    });
    expect(result.transitioned).toBe(true);
    const patch = harness.writes.find((write) => write.table === tasks)?.patch;
    expect(patch?.["status"]).toBe("pending");
    expect(patch).not.toHaveProperty("nextFireAt");
  });

  test("terminalizes an older denied occurrence without pausing the newer run or definition", async () => {
    const newerRunId = "60000000-0000-4000-8000-000000000006";
    const cronTask = {
      ...task,
      status: "pending",
      scheduleKind: "cron",
      nextFireAt: new Date("2026-10-04T09:00:00.000Z"),
    } as Task;
    const harness = aggregateHarness({ task: cronTask, run, latestRunId: newerRunId });
    const result = await pauseTaskRunForFundingDenial(harness.db, {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      reason: "personal_credential_unavailable",
    });

    expect(result).toMatchObject({ transitioned: true, task: undefined });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.table).toBe(taskRuns);
    expect(harness.writes[0]?.patch).toMatchObject({
      status: "errored",
      lastError: "personal_credential_unavailable",
    });
    expect(harness.writes[0]?.patch["completedAt"]).toBeInstanceOf(Date);
  });

  test("restart settles an older interrupted occurrence without changing its newer schedule", async () => {
    const cronTask = {
      ...task,
      status: "pending",
      scheduleKind: "cron",
      nextFireAt: new Date("2026-10-04T09:00:00.000Z"),
    } as Task;
    const harness = aggregateHarness({
      task: cronTask,
      run,
      latestRunId: "60000000-0000-4000-8000-000000000006",
    });
    const result = await reconcileCallerFundedTaskRunAfterRestart(harness.db, {
      taskId: task.id,
      taskRunId: run.id,
    });

    expect(result.transitioned).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.table).toBe(taskRuns);
    expect(harness.writes[0]?.patch).toMatchObject({
      status: "errored",
      lastError: "funding_interrupted_uncertain",
    });
  });

  test("restart reconciliation rejects legacy, paused, terminal, and superseded work", async () => {
    for (const candidate of [
      { task: { ...task, fundingMode: "legacy_server" } as Task, run },
      { task: { ...task, status: "paused" } as Task, run },
      { task, run: { ...run, status: "completed" } as TaskRun },
      { task, run: { ...run, id: "60000000-0000-4000-8000-000000000006" } as TaskRun },
    ]) {
      const harness = aggregateHarness(candidate);
      expect((await reconcileCallerFundedTaskRunAfterRestart(harness.db, {
        taskId: task.id,
        taskRunId: run.id,
      })).transitioned).toBe(false);
      expect(harness.writes).toEqual([]);
    }
  });

  test("claims an exact live caller-funded run and accepts an exact retry", async () => {
    const harness = aggregateHarness({ task, run });
    const input = {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      graphThreadId: run.graphThreadId,
      jobId: "50000000-0000-4000-8000-000000000005",
    };
    expect(await claimCallerTaskRunJob(harness.db, input)).toBe(true);
    expect(harness.writes).toEqual([{ table: taskRuns, patch: { jobId: input.jobId } }]);

    const retried = aggregateHarness({ task, run: { ...run, jobId: input.jobId } });
    expect(await claimCallerTaskRunJob(retried.db, input)).toBe(true);
    expect(retried.writes).toEqual([]);
  });

  test("claims an exact older occurrence while its recurring definition is pending", async () => {
    const pendingCron = {
      ...task,
      status: "pending",
      scheduleKind: "cron",
      nextFireAt: new Date("2026-10-04T09:00:00.000Z"),
    } as Task;
    const harness = aggregateHarness({ task: pendingCron, run });
    const input = {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      graphThreadId: run.graphThreadId,
      jobId: "50000000-0000-4000-8000-000000000005",
    };

    expect(await claimCallerTaskRunJob(harness.db, input)).toBe(true);
    expect(harness.writes).toEqual([{ table: taskRuns, patch: { jobId: input.jobId } }]);
  });

  test("an idempotent delayed claim follows a paused or stopped aggregate", async () => {
    const jobId = "50000000-0000-4000-8000-000000000005";
    const input = {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      graphThreadId: run.graphThreadId,
      jobId,
    };
    const paused = aggregateHarness({
      task: { ...task, status: "paused", lastError: "personal_credential_stale" } as Task,
      run: { ...run, jobId } as TaskRun,
    });
    expect(await claimCallerTaskRunJob(paused.db, input)).toBe(false);
    expect(paused.writes).toEqual([{
      table: taskRuns,
      patch: { status: "paused", lastError: "personal_credential_stale" },
    }]);

    const stopped = aggregateHarness({
      task: { ...task, status: "cancelled" } as Task,
      run: { ...run, jobId } as TaskRun,
    });
    expect(await claimCallerTaskRunJob(stopped.db, input)).toBe(false);
    expect(stopped.writes).toHaveLength(1);
    expect(stopped.writes[0]?.patch).toMatchObject({ status: "cancelled" });
    expect(stopped.writes[0]?.patch["completedAt"]).toBeInstanceOf(Date);
  });

  test("rejects a stale run, terminal run, or job claimed by another executor", async () => {
    const input = {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      graphThreadId: run.graphThreadId,
      jobId: "50000000-0000-4000-8000-000000000005",
    };
    for (const candidate of [
      { ...run, id: "60000000-0000-4000-8000-000000000006" },
      { ...run, status: "completed" as const },
      { ...run, jobId: "70000000-0000-4000-8000-000000000007" },
    ]) {
      const harness = aggregateHarness({ task, run: candidate as TaskRun });
      expect(await claimCallerTaskRunJob(harness.db, input)).toBe(false);
      expect(harness.writes).toEqual([]);
    }
  });

  test("parks and releases only the exact Human-owned fire-lock", async () => {
    let patch: Record<string, unknown> | undefined;
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    const returned = { id: "task" };
    const db = {
      update: () => ({
        set: (value: Record<string, unknown>) => {
          patch = value;
          return {
            where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
              whereSql = condition;
              return { returning: async () => [returned] };
            },
          };
        },
      }),
    } as unknown as DirectDatabase;

    const result = await pauseClaimedTaskForFundingDenial(db, {
      taskId: "10000000-0000-4000-8000-000000000001",
      requestorId: "20000000-0000-4000-8000-000000000002",
      fireLockId: "30000000-0000-4000-8000-000000000003",
      reason: "personal_credential_stale",
    });

    expect(result.transitioned).toBe(true);
    expect(result.task?.id).toBe(returned.id);
    expect(result.run).toBeUndefined();
    expect(patch).toMatchObject({
      status: "paused",
      lastError: "personal_credential_stale",
      fireLockId: null,
      fireLockedAt: null,
    });
    const query = new PgDialect().sqlToQuery(whereSql!);
    for (const column of ["id", "requestor_id", "status", "fire_lock_id"]) {
      expect(query.sql).toContain(`"tasks"."${column}" =`);
    }
    expect(query.params).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "pending",
      "30000000-0000-4000-8000-000000000003",
    ]);
  });

  test("reports a stale claim without mutating another lifecycle", async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }),
    } as unknown as DirectDatabase;
    expect(await pauseClaimedTaskForFundingDenial(db, {
      taskId: "10000000-0000-4000-8000-000000000001",
      requestorId: "20000000-0000-4000-8000-000000000002",
      fireLockId: "30000000-0000-4000-8000-000000000003",
      reason: "personal_credential_missing",
    })).toEqual({ task: undefined, run: undefined, transitioned: false });
  });

  test("atomically pauses only the latest active run and its live Task", async () => {
    const harness = aggregateHarness({ task, run });
    const result = await pauseTaskRunForFundingDenial(harness.db, {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      reason: "personal_credential_unavailable",
    });
    expect(result.transitioned).toBe(true);
    expect(harness.writes).toHaveLength(2);
    expect(harness.writes.find((write) => write.table === taskRuns)?.patch)
      .toEqual({ status: "paused", lastError: "personal_credential_unavailable" });
    expect(harness.writes.find((write) => write.table === tasks)?.patch)
      .toMatchObject({
        status: "paused",
        lastError: "personal_credential_unavailable",
        fireLockId: null,
        fireLockedAt: null,
      });
  });

  test("does not let an older or terminal run pause the Task", async () => {
    const older = aggregateHarness({
      task,
      run: { ...run, id: "50000000-0000-4000-8000-000000000005" },
    });
    expect((await pauseTaskRunForFundingDenial(older.db, {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      reason: "funding_source_changed",
    })).transitioned).toBe(false);
    expect(older.writes).toEqual([]);

    const terminal = aggregateHarness({
      task,
      run: { ...run, status: "completed" },
    });
    expect((await pauseTaskRunForFundingDenial(terminal.db, {
      taskId: task.id,
      taskRunId: run.id,
      requestorId: task.requestorId,
      reason: "funding_source_changed",
    })).transitioned).toBe(false);
    expect(terminal.writes).toEqual([]);
  });

  test("records a completed wake failure without changing result or lifecycle", async () => {
    const completedRun = {
      ...run,
      status: "completed",
      resultText: "durable result",
    } as TaskRun;
    const pendingCron = { ...task, status: "pending", scheduleKind: "cron" } as Task;
    const harness = aggregateHarness({
      task: pendingCron,
      run: completedRun,
      latestRunId: completedRun.id,
    });
    const result = await recordTaskWakeFundingFailure(harness.db, {
      taskId: task.id,
      taskRunId: completedRun.id,
      requestorId: task.requestorId,
      reason: "personal_credential_stale",
    });
    expect(result).toMatchObject({ recorded: true, taskErrorRecorded: true });
    expect(harness.writes.find((write) => write.table === taskRuns)?.patch)
      .toEqual({ lastError: "personal_credential_stale" });
    expect(harness.writes.find((write) => write.table === tasks)?.patch)
      .toMatchObject({ lastError: "personal_credential_stale" });
    expect(harness.writes.some((write) => "status" in write.patch)).toBe(false);
    expect(harness.writes.some((write) => "resultText" in write.patch)).toBe(false);
  });

  test("keeps an older wake failure off the Task projection", async () => {
    const completedRun = { ...run, status: "completed" } as TaskRun;
    const harness = aggregateHarness({
      task,
      run: completedRun,
      latestRunId: "60000000-0000-4000-8000-000000000006",
    });
    const result = await recordTaskWakeFundingFailure(harness.db, {
      taskId: task.id,
      taskRunId: completedRun.id,
      requestorId: task.requestorId,
      reason: "provider_credentials_missing",
    });
    expect(result).toMatchObject({ recorded: true, taskErrorRecorded: false });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.table).toBe(taskRuns);
  });
});
