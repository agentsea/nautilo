import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import {
  settleCancelledProtectedTaskRunAuthorization,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  orphan: "30000000-0000-4000-8000-000000000004",
  secondOrphan: "30000000-0000-4000-8000-000000000005",
  human: "40000000-0000-4000-8000-000000000006",
  namespace: "50000000-0000-4000-8000-000000000007",
};
const inputObjectId = `task-definition:v1:${"b".repeat(64)}`;
const authorizationRequestId = "task-run-authorization:cancelled-run";

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    authorizationRequestId,
    policyRevision: 7,
    executionSegment: 1,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.human,
    requestorId: ids.human,
    status: "cancelled",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    cryptoObjectId: inputObjectId,
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    status: "cancelled",
    ...overrides,
  } as TaskRun;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.human,
    requestorId: ids.human,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "cancelled",
    input: reference(),
    result: null,
    message: null,
    metadata: {},
    createdAt: new Date("2026-10-08T08:00:00.000Z"),
    startedAt: new Date("2026-10-08T08:01:00.000Z"),
    completedAt: new Date("2026-10-08T08:02:00.000Z"),
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task;
  run?: TaskRun;
  jobs?: Job[];
  failOrphanUpdate?: boolean;
}>;

function fixture(options: FixtureOptions = {}) {
  const taskRow = options.task ?? task();
  const runRow = options.run ?? run();
  let jobRows = options.jobs ?? [job()];
  const locks: unknown[] = [];
  const writes: Array<{ patch: Record<string, unknown>; predicate: SQL }> = [];

  const selectFrom = (
    table: unknown,
    projection: Record<string, unknown> | undefined,
    locked: boolean,
  ) => {
    let predicate: SQL | undefined;
    const query = {
      where: (value: SQL) => {
        predicate = value;
        return query;
      },
      limit: (_limit: number) => locked
        ? query
        : Promise.resolve(table === taskRuns
          ? [{ taskId: runRow.taskId }]
          : []),
      for: async (kind: string) => {
        locks.push({ table, kind, projection });
        if (table === tasks) return [taskRow];
        if (table === taskRuns) return [runRow];
        if (table === jobs) {
          if (!predicate) throw new Error("expected Job predicate");
          const params = new PgDialect().sqlToQuery(predicate).params;
          const row = jobRows.find(candidate => candidate.id === params[0]);
          return row ? [{
            id: row.id,
            ownerId: row.ownerId,
            requestorId: row.requestorId,
            laneKey: row.laneKey,
            type: row.type,
            status: row.status,
            input: row.input,
            resultIsNull: row.result === null,
            messageIsNull: row.message === null,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
          }] : [];
        }
        throw new Error("unexpected table");
      },
    };
    return query;
  };

  const applyJobUpdate = async (
    patch: Record<string, unknown>,
    predicate: SQL,
    returning: boolean,
  ): Promise<Array<{ id: string }>> => {
    const rendered = new PgDialect().sqlToQuery(predicate);
    const linked = rendered.sql.includes('"jobs"."id" =');
    if (!linked && options.failOrphanUpdate === true) {
      throw new Error("synthetic orphan cleanup failure");
    }
    const params = rendered.params;
    const changed: Array<{ id: string }> = [];
    jobRows = jobRows.map(candidate => {
      const exactInput = JSON.stringify(candidate.input);
      const matches = linked
        ? candidate.id === params[0]
          && (candidate.status === params[1] || candidate.status === params[2])
          && candidate.completedAt === null
          && candidate.result === null
          && candidate.message === null
          && exactInput === params[3]
        : candidate.ownerId === params[0]
          && candidate.requestorId === params[1]
          && candidate.laneKey === params[2]
          && candidate.type === params[3]
          && candidate.status === params[4]
          && candidate.startedAt === null
          && candidate.completedAt === null
          && candidate.result === null
          && candidate.message === null
          && exactInput === params[5];
      if (!matches) return candidate;
      changed.push({ id: candidate.id });
      return { ...candidate, ...patch } as Job;
    });
    writes.push({ patch, predicate });
    return returning ? changed : [];
  };

  const tx = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => selectFrom(table, projection, true),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: SQL) => {
          if (table !== jobs) throw new Error("unexpected update table");
          const execute = (returning: boolean) =>
            applyJobUpdate(patch, predicate, returning);
          return {
            returning: (_projection: Record<string, unknown>) => execute(true),
            then: <TResult1 = unknown, TResult2 = never>(
              onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => execute(false).then(onfulfilled, onrejected),
          };
        },
      }),
    }),
  };

  const database = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => selectFrom(table, projection, false),
    }),
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) => {
      const before = jobRows.map(row => ({ ...row }));
      try {
        return await operation(tx);
      } catch (error) {
        jobRows = before;
        throw error;
      }
    },
  } as unknown as DirectDatabase;
  return {
    database,
    jobs: () => jobRows,
    locks,
    writes,
  };
}

const settlementInput = {
  taskRunId: ids.run,
  contentNamespaceId: ids.namespace,
  authorizationRequestId,
  policyRevision: 7,
};

describe("cancelled protected Task authorization settlement", () => {
  test("calls cancellation only while the cancelled Task and Run are locked", async () => {
    const testFixture = fixture();
    let callbackLocks: unknown[] = [];

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => {
        callbackLocks = [...testFixture.locks];
        return true;
      },
    )).toBe(true);
    expect(callbackLocks.map(entry => (
      entry as { table: unknown }
    ).table)).toEqual([tasks, taskRuns, jobs]);
  });

  test("denies non-cancelled or wrong-namespace product state before callback", async () => {
    for (const [testFixture, input] of [
      [fixture({ task: task({ status: "running" }) }), settlementInput],
      [fixture({ run: run({ status: "running" }) }), settlementInput],
      [fixture(), { ...settlementInput, contentNamespaceId: "wrong-namespace" }],
    ] as const) {
      let callbacks = 0;
      expect(await settleCancelledProtectedTaskRunAuthorization(
        testFixture.database,
        input,
        async () => {
          callbacks += 1;
          return true;
        },
      )).toBe(false);
      expect(callbacks).toBe(0);
    }
  });

  test("succeeds after cancellation when no initial Job was ever persisted", async () => {
    const testFixture = fixture({
      run: run({ jobId: null }),
      jobs: [],
    });

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => true,
    )).toBe(true);
    expect(testFixture.jobs()).toEqual([]);
  });

  test("cancels every exact orphaned initial Job without touching continuations", async () => {
    const exactOrphans = [
      job({
        id: ids.orphan,
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
      job({
        id: ids.secondOrphan,
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
    ];
    const continuation = job({
      id: ids.job,
      status: "queued",
      startedAt: null,
      completedAt: null,
      input: reference({
        executionSegment: 2,
        resumeAcceptanceId: "resume:2",
      }),
    });
    const testFixture = fixture({
      run: run({ jobId: null }),
      jobs: [...exactOrphans, continuation],
    });

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => true,
    )).toBe(true);
    expect(testFixture.jobs().map(row => ({ id: row.id, status: row.status })))
      .toEqual([
        { id: ids.orphan, status: "cancelled" },
        { id: ids.secondOrphan, status: "cancelled" },
        { id: ids.job, status: "queued" },
      ]);
    const cleanup = testFixture.writes.find(({ predicate }) =>
      !new PgDialect().sqlToQuery(predicate).sql.includes('"jobs"."id" ='));
    if (!cleanup) throw new Error("expected orphaned initial Job cleanup");
    const rendered = new PgDialect().sqlToQuery(cleanup.predicate);
    for (const guard of [
      '"jobs"."owner_id" =',
      '"jobs"."requestor_id" =',
      '"jobs"."lane_key" =',
      '"jobs"."type" =',
      '"jobs"."status" =',
      '"jobs"."started_at" is null',
      '"jobs"."completed_at" is null',
      '"jobs"."result" is null',
      '"jobs"."message" is null',
      '"jobs"."input" =',
    ]) expect(rendered.sql).toContain(guard);
    expect(rendered.params).toEqual([
      ids.human,
      ids.human,
      `task:${ids.task}`,
      "foreground",
      "queued",
      JSON.stringify(reference()),
    ]);
  });

  test("a rejected cancellation callback leaves linked and orphan Jobs unchanged", async () => {
    const testFixture = fixture({
      jobs: [job({
        status: "running",
        completedAt: null,
      })],
    });

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => false,
    )).toBe(false);
    expect(testFixture.jobs()[0]).toMatchObject({
      status: "running",
      completedAt: null,
    });
    expect(testFixture.writes).toEqual([]);
  });

  test("does not overwrite the exact completed Job of a parked run", async () => {
    const testFixture = fixture({
      jobs: [job({ status: "completed" })],
    });

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => true,
    )).toBe(true);
    expect(testFixture.jobs()[0]?.status).toBe("completed");
  });

  test("settles authorization without overwriting failed or timed-out Jobs", async () => {
    for (const terminalJob of [
      job({
        status: "failed",
        startedAt: null,
        completedAt: new Date("2026-10-08T08:02:00.000Z"),
      }),
      job({ status: "timed_out" }),
    ]) {
      const testFixture = fixture({ jobs: [terminalJob] });
      let callbacks = 0;

      expect(await settleCancelledProtectedTaskRunAuthorization(
        testFixture.database,
        settlementInput,
        async () => {
          callbacks += 1;
          return true;
        },
      )).toBe(true);
      expect(callbacks).toBe(1);
      expect(testFixture.jobs()[0]).toMatchObject({
        status: terminalJob.status,
        startedAt: terminalJob.startedAt,
        completedAt: terminalJob.completedAt,
      });
    }
  });

  test("rejects a terminal Job without durable completion proof", async () => {
    const testFixture = fixture({
      jobs: [job({ status: "failed", completedAt: null })],
    });
    let callbacks = 0;

    expect(await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => {
        callbacks += 1;
        return true;
      },
    )).toBe(false);
    expect(callbacks).toBe(0);
  });

  test("rolls back linked Job repair when orphan cleanup fails after callback", async () => {
    const testFixture = fixture({
      jobs: [job({ status: "running", completedAt: null })],
      failOrphanUpdate: true,
    });
    let callbacks = 0;
    const failure = await settleCancelledProtectedTaskRunAuthorization(
      testFixture.database,
      settlementInput,
      async () => {
        callbacks += 1;
        return true;
      },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(callbacks).toBe(1);
    expect(testFixture.jobs()[0]).toMatchObject({
      status: "running",
      completedAt: null,
    });
  });
});
