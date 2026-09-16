import { describe, expect, test } from "bun:test";
import { jobs, taskRuns, tasks, type DirectDatabase } from "@nautilo/db";
import { createCodexTaskRunLifecycleWriter } from "../../src/codex/task-run-lifecycle";

const TASK = "task";
const RUN = "run";
const JOB = "job";

type Rows = ReadonlyArray<Readonly<Record<string, unknown>>>;

/**
 * Deliberately small Drizzle-chain fake. The writer's transaction uses only
 * select/from/where/for and update/set/where/returning; recording that exact
 * surface lets these tests assert the transaction-local lock and write order.
 */
class LifecycleWriterDb {
  readonly reads: string[] = [];
  readonly locks: string[] = [];
  readonly updates: string[] = [];
  readonly patches: unknown[] = [];
  transactionCount = 0;

  constructor(
    private readonly readsToReturn: Rows[],
    private readonly updatesToReturn: Rows[] = [],
  ) {}

  transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return callback(this);
  }

  select(_fields: unknown) {
    return {
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_condition: unknown) => ({
            for: (lock: string) => {
              this.reads.push(name);
              this.locks.push(`${name}:${lock}`);
              return Promise.resolve(this.readsToReturn.shift() ?? []);
            },
          }),
        };
      },
    };
  }

  update(table: unknown) {
    this.updates.push(tableName(table));
    return {
      set: (patch: unknown) => {
        this.patches.push(patch);
        return ({
        where: (_condition: unknown) => ({
          returning: async () => this.updatesToReturn.shift() ?? [],
        }),
      });
      },
    };
  }
}

function tableName(table: unknown): string {
  if (table === tasks) return "tasks";
  if (table === taskRuns) return "taskRuns";
  if (table === jobs) return "jobs";
  throw new Error("unexpected lifecycle table");
}

function asDb(db: LifecycleWriterDb): DirectDatabase {
  return db as unknown as DirectDatabase;
}

const exactJob = { id: JOB, input: { taskId: TASK, taskRunId: RUN } };
const input = { taskId: TASK, taskRunId: RUN, jobId: JOB };

describe("createCodexTaskRunLifecycleWriter", () => {
  test("linkJob locks Task → TaskRun → Job and only then conditionally links", async () => {
    const db = new LifecycleWriterDb(
      [
        [{ id: TASK, scheduleKind: "now" }],
        [{ taskId: TASK, jobId: null, status: "running" }],
        [exactJob],
      ],
      [[{ id: RUN }]],
    );

    const result = await createCodexTaskRunLifecycleWriter(asDb(db)).linkJob(input);

    expect(result).toBe("linked");
    expect(db.transactionCount).toBe(1);
    expect(db.locks).toEqual(["tasks:update", "taskRuns:update", "jobs:key share"]);
    expect(db.updates).toEqual(["taskRuns"]);
  });

  test("linkJob rejects an absent or cron Task inside its transaction before any run/job lock or write", async () => {
    const missing = new LifecycleWriterDb([[]]);
    const cron = new LifecycleWriterDb([[{ id: TASK, scheduleKind: "cron" }]]);

    expect(await createCodexTaskRunLifecycleWriter(asDb(missing)).linkJob(input)).toBe("conflict");
    expect(missing.transactionCount).toBe(1);
    expect(missing.locks).toEqual(["tasks:update"]);
    expect(missing.updates).toEqual([]);

    expect(await createCodexTaskRunLifecycleWriter(asDb(cron)).linkJob(input)).toBe("conflict");
    expect(cron.transactionCount).toBe(1);
    expect(cron.locks).toEqual(["tasks:update"]);
    expect(cron.updates).toEqual([]);
  });

  test("fails only the exact owner-bound nonterminal Job before canonical report-back", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const db = new LifecycleWriterDb(
      [
        [{ id: TASK, ownerId: "owner", scheduleKind: "now", status: "running", lastError: null }],
        [{ taskId: TASK, jobId: JOB, status: "awaiting", lastError: null }],
        [{ ...exactJob, ownerId: "owner", status: "running", message: null }],
      ],
      [[{ id: JOB }]],
    );

    const result = await createCodexTaskRunLifecycleWriter(asDb(db)).failUnavailableJob({
      ownerId: "owner",
      ...input,
      code: "CODEX_REQUEST_UNAVAILABLE",
      now,
    });

    expect(result).toEqual({ status: "failed", scheduleKind: "now" });
    expect(db.locks).toEqual(["tasks:update", "taskRuns:update", "jobs:update"]);
    expect(db.updates).toEqual(["jobs"]);
    expect(db.patches).toEqual([{
      status: "failed",
      message: "CODEX_REQUEST_UNAVAILABLE",
      result: null,
      completedAt: now,
    }]);
  });

  test("recognizes the same controlled Job failure as idempotent without rewriting it", async () => {
    const db = new LifecycleWriterDb([
      [{ id: TASK, ownerId: "owner", scheduleKind: "one_shot", status: "errored", lastError: "CODEX_REQUEST_UNAVAILABLE" }],
      [{ taskId: TASK, jobId: JOB, status: "errored", lastError: "CODEX_REQUEST_UNAVAILABLE" }],
      [{ ...exactJob, ownerId: "owner", status: "failed", message: "CODEX_REQUEST_UNAVAILABLE" }],
    ]);

    const result = await createCodexTaskRunLifecycleWriter(asDb(db)).failUnavailableJob({
      ownerId: "owner",
      ...input,
      code: "CODEX_REQUEST_UNAVAILABLE",
      now: new Date(),
    });

    expect(result).toEqual({ status: "already_failed", scheduleKind: "one_shot" });
    expect(db.updates).toEqual([]);
  });

  test("rejects foreign relations and never overwrites another terminal Job", async () => {
    for (const rows of [
      [[]],
      [
        [{ id: TASK, ownerId: "owner", scheduleKind: "now", status: "running", lastError: null }],
        [{ taskId: TASK, jobId: "foreign-job", status: "running", lastError: null }],
        [{ ...exactJob, ownerId: "owner", status: "running", message: null }],
      ],
      [
        [{ id: TASK, ownerId: "owner", scheduleKind: "now", status: "running", lastError: null }],
        [{ taskId: TASK, jobId: JOB, status: "running", lastError: null }],
        [{ ...exactJob, ownerId: "owner", status: "cancelled", message: "user_stop" }],
      ],
    ] as Rows[][]) {
      const db = new LifecycleWriterDb(rows);
      const result = await createCodexTaskRunLifecycleWriter(asDb(db)).failUnavailableJob({
        ownerId: "owner",
        ...input,
        code: "CODEX_REQUEST_UNAVAILABLE",
        now: new Date(),
      });
      expect(result).toEqual({ status: "conflict" });
      expect(db.updates).toEqual([]);
    }
  });

  test("lets a terminal or differently errored Task/Run win without relabeling its Job", async () => {
    const terminalPairs = [
      [{ status: "completed", lastError: null }, { status: "completed", lastError: null }],
      [{ status: "cancelled", lastError: null }, { status: "cancelled", lastError: null }],
      [{ status: "errored", lastError: "other_failure" }, { status: "errored", lastError: "other_failure" }],
      [{ status: "running", lastError: null }, { status: "cancelled", lastError: null }],
    ] as const;

    for (const [taskState, runState] of terminalPairs) {
      const db = new LifecycleWriterDb([
        [{ id: TASK, ownerId: "owner", scheduleKind: "now", ...taskState }],
        [{ taskId: TASK, jobId: JOB, ...runState }],
        [{ ...exactJob, ownerId: "owner", status: "running", message: null }],
      ]);
      const result = await createCodexTaskRunLifecycleWriter(asDb(db)).failUnavailableJob({
        ownerId: "owner",
        ...input,
        code: "CODEX_REQUEST_UNAVAILABLE",
        now: new Date(),
      });

      expect(result).toEqual({ status: "conflict" });
      expect(db.updates).toEqual([]);
    }
  });
});
