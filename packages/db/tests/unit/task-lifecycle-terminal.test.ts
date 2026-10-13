import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import { transitionTaskLifecycleTerminal } from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  newerRun: "20000000-0000-4000-8000-000000000003",
  job: "30000000-0000-4000-8000-000000000004",
  replacementJob: "30000000-0000-4000-8000-000000000005",
  human: "40000000-0000-4000-8000-000000000006",
  namespace: "60000000-0000-4000-8000-000000000008",
};

const inputObjectId = `task-definition:v1:${"a".repeat(64)}`;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.human,
    requestorId: ids.human,
    agentId: "50000000-0000-4000-8000-000000000007",
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    fundingMode: "legacy_server",
    status: "running",
    metadata: {},
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: inputObjectId,
    cryptoAccessRevision: 1,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    cryptoMappingState: "verified",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId: `subagent:task:${ids.task}:${ids.run}`,
    status: "running",
    modelId: null,
    fundingBinding: null,
    fundingPredecessorRunId: null,
    resultText: null,
    startedAt: new Date("2026-10-08T09:00:00.000Z"),
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function jobReference(overrides: Record<string, unknown> = {}) {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    authorizationRequestId: "authorization-request",
    policyRevision: 1,
    executionSegment: 1,
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.human,
    requestorId: ids.human,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "running",
    input: jobReference(),
    result: null,
    message: null,
    metadata: {},
    createdAt: new Date("2026-10-08T08:59:00.000Z"),
    startedAt: new Date("2026-10-08T09:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: Task;
  run?: TaskRun | null;
  job?: Job;
  newerRun?: TaskRun;
}>;

function harness(options: HarnessOptions = {}) {
  let taskRow = options.task ?? task();
  let runRow = options.run === null ? null : options.run ?? run();
  let jobRow = options.job ?? job();
  const transactions: string[] = [];
  const locks: unknown[] = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const updatePredicates: Array<{ table: unknown; predicate: SQL }> = [];
  const reads: Array<{ table: unknown; projection: Record<string, unknown> | undefined; predicate: SQL }> = [];

  const writerPending = (row: Record<string, unknown>) => {
    const metadata = row["metadata"] as Record<string, unknown> | undefined;
    const marker = metadata?.["writerReviewAwaiting"] as Record<string, unknown> | undefined;
    return marker?.["version"] === 1 && typeof marker["pendingWorkspaceOperationId"] === "string"
      && typeof marker["pendingWorkspaceClientMutationId"] === "string";
  };
  const project = (row: Record<string, unknown>, projection?: Record<string, unknown>) => projection === undefined ? row
    : Object.fromEntries(Object.keys(projection).map(key => [key,
      key === "requiresLocalRecapture" ? row["localExecutionDelegation"] === null && row["lastError"] === "Project access was removed by a Task edit. Recreate this Task from its original chat on the intended Mac."
        : key === "writerReviewPending" ? writerPending(row) : row[key]]));
  const tx = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        let predicate: SQL | undefined;
        const query = {
          where: (value: SQL) => {
            predicate = value;
            reads.push({ table, projection, predicate: value });
            return query;
          },
          orderBy: () => query,
          limit: (_limit: number) => {
            if (table === taskRuns
              && projection !== undefined
              && Object.keys(projection).join(",") === "id") {
              return Promise.resolve(options.newerRun ? [options.newerRun] : []);
            }
            return query;
          },
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(table === tasks ? [project(taskRow, projection)] : []).then(resolve),
          for: async (kind: string) => {
            locks.push({ table, kind, predicate, projection });
            if (table === tasks) return [project(taskRow, projection)];
            if (table === taskRuns) {
              return runRow === null ? [] : [project(runRow, projection)];
            }
            if (table === jobs) {
              return [{
                id: jobRow.id,
                ownerId: jobRow.ownerId,
                requestorId: jobRow.requestorId,
                laneKey: jobRow.laneKey,
                type: jobRow.type,
                status: jobRow.status,
                input: jobRow.input,
                resultIsNull: jobRow.result === null,
                messageIsNull: jobRow.message === null,
                startedAt: jobRow.startedAt,
                completedAt: jobRow.completedAt,
              }];
            }
            throw new Error("unexpected table");
          },
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async (projection?: Record<string, unknown>) => {
          if (table !== taskRuns || runRow !== null) throw new Error("unexpected insert");
          writes.push({ table, patch: values });
          runRow = run({ ...values, jobId: null } as Partial<TaskRun>);
          return [project(runRow, projection)];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: SQL) => ({
          returning: async (projection?: Record<string, unknown>) => {
            updatePredicates.push({ table, predicate });
            writes.push({ table, patch });
            if (table === tasks) {
              taskRow = { ...taskRow, ...patch } as Task;
              return [project(taskRow, projection)];
            }
            if (table === taskRuns) {
              runRow = { ...runRow, ...patch } as TaskRun;
              return [project(runRow, projection)];
            }
            if (table === jobs) {
              jobRow = { ...jobRow, ...patch } as Job;
              return [jobRow];
            }
            throw new Error("unexpected table");
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) => {
      transactions.push("transaction");
      return operation(tx);
    },
  } as unknown as DirectDatabase;
  return { db, locks, transactions, updatePredicates, writes, reads };
}

const terminalInput = {
  taskId: ids.task,
  taskStatus: "cancelled" as const,
  taskPatch: { cancelledAt: new Date("2026-10-08T09:05:00.000Z") },
  runId: ids.run,
  runStatus: "cancelled" as const,
  expectedInvocation: {
    humanUserId: ids.human,
    taskRunId: ids.run,
    jobId: ids.job,
  },
};
const broadTerminalInput = {
  taskId: ids.task,
  taskStatus: "cancelled" as const,
  taskPatch: { cancelledAt: new Date("2026-10-08T09:05:00.000Z") },
  runStatus: "cancelled" as const,
};

describe("exact Task invocation terminal transition", () => {
  test("stops only the Human's locked run with its exact attached Job", async () => {
    const fixture = harness();

    const result = await transitionTaskLifecycleTerminal(
      fixture.db,
      terminalInput,
    );

    expect(result.outcome).toBe("transitioned");
    expect(fixture.locks.slice(0, 3).map((lock) => {
      const entry = lock as { table: unknown; kind: string };
      return { table: entry.table, kind: entry.kind };
    })).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
    ]);
    const invocationLock = fixture.locks[1] as {
      projection: Record<string, unknown> | undefined;
    };
    expect(Object.keys(invocationLock.projection ?? {})).toEqual([
      "id",
      "jobId",
    ]);
    const jobLock = fixture.locks[2] as {
      projection: Record<string, unknown> | undefined;
    };
    expect(Object.keys(jobLock.projection ?? {})).toEqual([
      "id",
      "ownerId",
      "requestorId",
      "laneKey",
      "type",
      "status",
      "input",
      "resultIsNull",
      "messageIsNull",
      "startedAt",
      "completedAt",
    ]);
    expect(jobLock.projection).not.toHaveProperty("result");
    expect(jobLock.projection).not.toHaveProperty("message");
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.writes[0]).toEqual({
      table: jobs,
      patch: {
        status: "cancelled",
        completedAt: expect.any(Date) as Date,
      },
    });
    expect(fixture.writes[1]).toEqual({
      table: taskRuns,
      patch: { status: "cancelled", completedAt: terminalInput.taskPatch.cancelledAt },
    });
    expect(fixture.writes[2]?.table).toBe(tasks);
    expect(fixture.writes[2]?.patch["status"]).toBe("cancelled");
    const jobPredicate = fixture.updatePredicates.find(
      (entry) => entry.table === jobs,
    );
    if (!jobPredicate) throw new Error("expected protected Job cancellation");
    const compiled = new PgDialect().sqlToQuery(jobPredicate.predicate);
    expect(compiled.sql).toBe(
      "(\"jobs\".\"id\" = $1 and \"jobs\".\"status\" in ($2, $3) "
      + "and \"jobs\".\"completed_at\" is null and \"jobs\".\"result\" is null "
      + "and \"jobs\".\"message\" is null and \"jobs\".\"input\" = $4)",
    );
    expect(compiled.params).toEqual([
      ids.job,
      "queued",
      "running",
      JSON.stringify(jobReference()),
    ]);
  });

  test("preserves the id-only invocation lock for a non-Job-bound stop", async () => {
    const fixture = harness({
      task: task({
        contentRepresentation: "ordinary",
        contentNamespaceId: null,
        contentRevision: 0,
        cryptoObjectId: null,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: null,
        cryptoMappingState: "unmapped",
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, {
      ...terminalInput,
      expectedInvocation: {
        humanUserId: ids.human,
        taskRunId: ids.run,
      },
    })).toMatchObject({ transitioned: true, outcome: "transitioned" });
    const invocationLock = fixture.locks[1] as {
      projection: Record<string, unknown> | undefined;
    };
    expect(Object.keys(invocationLock.projection ?? {})).toEqual(["id"]);
    expect(fixture.locks.filter((lock) => (
      lock as { table: unknown }
    ).table === jobs)).toEqual([]);
  });

  test("broad protected Stop cancels the exact Job linked by the current run", async () => {
    const fixture = harness();

    expect(await transitionTaskLifecycleTerminal(
      fixture.db,
      broadTerminalInput,
    )).toMatchObject({ transitioned: true, outcome: "transitioned" });
    expect(fixture.locks.slice(0, 3).map((lock) => (
      lock as { table: unknown }
    ).table)).toEqual([tasks, taskRuns, jobs]);
    expect(fixture.writes.map((write) => write.table)).toEqual([
      jobs,
      taskRuns,
      tasks,
    ]);
  });

  test("broad protected Stop rejects a substituted current Job", async () => {
    const fixture = harness({
      run: run({ jobId: ids.replacementJob }),
    });

    expect(await transitionTaskLifecycleTerminal(
      fixture.db,
      broadTerminalInput,
    )).toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("broad protected Stop leaves an exact completed parked Job terminal", async () => {
    const fixture = harness({
      run: run({ status: "awaiting" }),
      job: job({
        status: "completed",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(
      fixture.db,
      broadTerminalInput,
    )).toMatchObject({ transitioned: true, outcome: "transitioned" });
    expect(fixture.writes.map((write) => write.table)).toEqual([
      taskRuns,
      tasks,
    ]);
  });

  test("broad protected Stop preserves failed and timed-out Job outcomes", async () => {
    for (const terminalJob of [
      job({
        status: "failed",
        startedAt: null,
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
      job({
        status: "timed_out",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    ]) {
      const fixture = harness({
        run: run({ status: "awaiting" }),
        job: terminalJob,
      });

      expect(await transitionTaskLifecycleTerminal(
        fixture.db,
        broadTerminalInput,
      )).toMatchObject({ transitioned: true, outcome: "transitioned" });
      expect(fixture.writes.map((write) => write.table)).toEqual([
        taskRuns,
        tasks,
      ]);
    }
  });

  test("broad protected Stop rejects a terminal Job without completion proof", async () => {
    const fixture = harness({
      job: job({ status: "failed", completedAt: null }),
    });

    expect(await transitionTaskLifecycleTerminal(
      fixture.db,
      broadTerminalInput,
    )).toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("accepts an exact already-cancelled Job replay without rewriting it", async () => {
    const fixture = harness({
      job: job({
        status: "cancelled",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: true, outcome: "transitioned" });
    expect(fixture.writes.map((write) => write.table)).toEqual([
      taskRuns,
      tasks,
    ]);
  });

  test("repairs only the exact Job when Task and Run are already cancelled", async () => {
    const fixture = harness({
      task: task({ status: "cancelled" }),
      run: run({ status: "cancelled" }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: true, outcome: "transitioned" });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toEqual({
      table: jobs,
      patch: {
        status: "cancelled",
        completedAt: expect.any(Date) as Date,
      },
    });
  });

  test("allows an exact fully-cancelled replay without writes", async () => {
    const fixture = harness({
      task: task({ status: "cancelled" }),
      run: run({ status: "cancelled" }),
      job: job({
        status: "cancelled",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "same_terminal" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects a stale Job after the same TaskRun gained a successor", async () => {
    const fixture = harness({
      run: run({ jobId: ids.replacementJob }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects an exact stop when the locked TaskRun has no Job", async () => {
    const fixture = harness({ run: run({ jobId: null }) });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects an older run when a same-time or newer run exists", async () => {
    const fixture = harness({
      newerRun: run({
        id: ids.newerRun,
        jobId: ids.replacementJob,
        startedAt: new Date("2026-10-08T09:00:01.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects a different Human before terminal writes", async () => {
    const fixture = harness();

    expect(await transitionTaskLifecycleTerminal(fixture.db, {
      ...terminalInput,
      expectedInvocation: {
        ...terminalInput.expectedInvocation,
        humanUserId: "40000000-0000-4000-8000-000000000099",
      },
    })).toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects a substituted protected Job reference", async () => {
    const fixture = harness({
      job: job({ input: jobReference({ taskRunId: ids.newerRun }) }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects an already-completed Job instead of overwriting its outcome", async () => {
    const fixture = harness({
      job: job({
        status: "completed",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("keeps exact Job-bound Stop strict for an already-failed Job", async () => {
    const fixture = harness({
      job: job({
        status: "failed",
        completedAt: new Date("2026-10-08T09:04:00.000Z"),
      }),
    });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects a Job with content through projected null guards", async () => {
    const fixture = harness({ job: job({ result: { forbidden: true } }) });

    expect(await transitionTaskLifecycleTerminal(fixture.db, terminalInput))
      .toMatchObject({ transitioned: false, outcome: "authority_changed" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects a Job-bound non-cancellation intent before opening a transaction", async () => {
    const fixture = harness();
    const rejection = await transitionTaskLifecycleTerminal(fixture.db, {
      ...terminalInput,
      taskStatus: "completed",
      runStatus: "completed",
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TypeError);
    expect(fixture.transactions).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
});


describe("protected cancellation history", () => {
  test("pre-dispatch Stop creates one terminal history receipt without a Job", async () => {
    const fixture = harness({ task: task({ status: "pending" }), run: null });
    const result = await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
    expect(result.transitioned).toBe(true);
    expect(result.protectedRun).toMatchObject({ status: "cancelled", jobId: null });
    expect(fixture.writes.find(write => write.table === taskRuns)?.patch).toMatchObject({
      completedAt: broadTerminalInput.taskPatch.cancelledAt,
      startedAt: broadTerminalInput.taskPatch.cancelledAt });
    expect(result.protectedRun).not.toHaveProperty("resultText");
    expect(result.protectedRun).not.toHaveProperty("lastError");
    expect(fixture.writes.some(write => write.table === jobs)).toBe(false);
    await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
    expect(fixture.writes.filter(write => write.table === taskRuns)).toHaveLength(1);
  });

  test("Plain pre-dispatch Stop retains its existing no-occurrence behavior", async () => {
    const fixture = harness({ task: task({ status: "pending", contentRepresentation: "ordinary" }), run: null });
    const result = await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
    expect(result.protectedRun).toBeUndefined();
    expect(fixture.writes.map(write => write.table)).toEqual([tasks]);
  });

  test("completed Task cannot acquire a cancellation history receipt", async () => {
    const fixture = harness({ task: task({ status: "completed" }), run: null });
    const result = await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
    expect(result.transitioned).toBe(false);
    expect(fixture.writes).toHaveLength(0);
  });

  test.each(["running", "awaiting", "paused"] as const)("%s occurrence retains its identity and records the Stop timestamp", async status => {
    const fixture = harness({ task: task({ status }), run: run({ status, jobId: null }) });
    const result = await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
    expect(result.protectedRun).toMatchObject({ id: ids.run, status: "cancelled" });
    expect(fixture.writes.find(write => write.table === taskRuns)?.patch["completedAt"]).toEqual(broadTerminalInput.taskPatch.cancelledAt);
    expect(fixture.writes.filter(write => write.table === taskRuns)).toHaveLength(1);
  });
});


test("protected Stop clears cooperative pause intent under the same Task lock", async () => {
  const fixture = harness({ task: task({ status: "paused", pauseRequestId: ids.run,
    pauseReason: "manual_pause", pauseRequestedAt: new Date("2026-10-08T09:00:00Z") }), run: run({ status: "awaiting", jobId: null }) });
  expect((await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput)).transitioned).toBe(true);
  expect(fixture.writes.find(write => write.table === tasks)?.patch).toMatchObject({
    status: "cancelled", pauseRequestId: null, pauseRequestedAt: null, pauseReason: null,
  });
});


test("Shadow Stop selects and returns no Task definition or Run result siblings", async () => {
  const fixture = harness({ task: task({ contentRepresentation: "dual", prompt: "private prompt",
    expectedOutput: "private objective", lastError: "private failure" }),
    run: run({ resultText: "private result", lastError: "private run failure" }) });
  const result = await transitionTaskLifecycleTerminal(fixture.db, terminalInput);
  expect(result.outcome).toBe("transitioned");
  expect(result.task).toBeUndefined(); expect(result.run).toBeUndefined();
  expect(Object.keys(result.protectedTask!).sort()).toEqual([
    "contentRepresentation", "id", "ownerId", "pauseReason", "pauseRequestId", "pauseRequestedAt", "requestorId", "status",
  ]);
  expect(Object.keys(result.protectedRun!).sort()).toEqual(["id", "jobId", "status", "taskId"]);
  for (const read of fixture.reads.filter(value => value.table === tasks || value.table === taskRuns)) {
    expect(read.projection).toBeDefined();
    for (const key of ["prompt", "expectedOutput", "toolsWhitelist", "selectionSpec", "metadata", "resultText", "lastError"]) {
      expect(read.projection).not.toHaveProperty(key);
    }
  }
  expect(JSON.stringify(result)).not.toContain("private");
});

test.each(["completed", "errored"] as const)("ordinary %s finalizer racing conversion refuses before Run read or write", async status => {
  const fixture = harness({ task: task({ contentRepresentation: "dual", prompt: "retained Shadow" }) });
  const result = await transitionTaskLifecycleTerminal(fixture.db, {
    taskId: ids.task, runId: ids.run, taskStatus: status, runStatus: status,
    runPatch: { resultText: "stale ordinary output" },
  });
  expect(result).toMatchObject({ outcome: "authority_changed", transitioned: false, task: undefined, run: undefined });
  expect(fixture.writes).toEqual([]);
  expect(fixture.reads).toHaveLength(1);
  expect(fixture.reads[0]?.projection).not.toHaveProperty("prompt");
});

test("ordinary Stop hydration remains full and is SQL fenced after the structural lock", async () => {
  const ordinary = task({ contentRepresentation: "ordinary", prompt: "ordinary prompt" });
  const fixture = harness({ task: ordinary, run: run({ jobId: null, resultText: "ordinary result" }) });
  const result = await transitionTaskLifecycleTerminal(fixture.db, broadTerminalInput);
  expect(result.task?.prompt).toBe("ordinary prompt");
  expect(result.run?.resultText).toBe("ordinary result");
  expect(result.protectedTask).toBeUndefined(); expect(result.protectedRun).toBeUndefined();
  expect(fixture.reads[0]?.projection).toBeDefined();
  for (const read of fixture.reads.filter(value => value.projection === undefined)) {
    const query = new PgDialect().sqlToQuery(read.predicate);
    expect(query.params).toContain("ordinary");
    expect(query.sql).toContain(read.table === tasks ? '"content_representation"' : '"result_representation"');
  }
});

test("protected Stop refuses stale ordinary cancellation text and recapture writes", async () => {
  const fixture = harness();
  expect((await transitionTaskLifecycleTerminal(fixture.db, {
    ...terminalInput, runPatch: { resultText: "ordinary cancellation" },
  })).outcome).toBe("authority_changed");
  expect(fixture.writes).toEqual([]);
  const recapture = harness({ task: task({ contentRepresentation: "dual", localExecutionDelegation: null,
    lastError: "Project access was removed by a Task edit. Recreate this Task from its original chat on the intended Mac." }) });
  expect((await transitionTaskLifecycleTerminal(recapture.db, terminalInput)).outcome).toBe("authority_changed");
  expect(recapture.writes).toEqual([]);
});


test("protected Stop retains the Writer reservation fence without reading its metadata", async () => {
  const fixture = harness({ task: task({ contentRepresentation: "dual", metadata: {
    writerReviewAwaiting: { version: 1,
      pendingWorkspaceOperationId: "reserved-operation", pendingWorkspaceClientMutationId: "reserved-mutation" },
    unrelatedPrivateField: "not returned",
  } }) });
  const result = await transitionTaskLifecycleTerminal(fixture.db, { ...broadTerminalInput,
    blockPendingWriterWorkspaceAcceptance: true });
  expect(result.outcome).toBe("writer_review_pending");
  expect(fixture.writes).toEqual([]);
  expect(fixture.reads).toHaveLength(1);
  expect(fixture.reads[0]?.projection).not.toHaveProperty("metadata");
  expect(result.protectedTask).not.toHaveProperty("metadata");
});
