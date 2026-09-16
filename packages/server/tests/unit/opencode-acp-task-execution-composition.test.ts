import { describe, expect, test } from "bun:test";
import { actors, jobs, roomMembers, rooms, taskRuns, tasks, type DirectDatabase } from "@nautilo/db";
import { ACP_EXECUTION_FAILED, HermesAcpTaskRunLifecycleRejected } from "../../src/acp/task-run-lifecycle";
import { createOpenCodeAcpTaskExecutionComposition } from "../../src/acp/opencode-task-execution-composition";

const TASK = "task";
const RUN = "run";
const JOB = "job";
const facts = { taskId: TASK, taskRunId: RUN, parentTaskId: null, source: "room" as const, jobId: JOB, authority: { ownerId: "owner", requestorId: "requestor", agentId: "agent", roomId: "room" } };
type Row = Readonly<Record<string, unknown>>;

function taskRow(overrides: Partial<Row> = {}): Row { return { id: TASK, ownerId: "owner", requestorId: "requestor", agentId: "agent", parentTaskId: null, targetRoomId: "room", prompt: "prompt", metadata: {}, scheduleKind: "now", status: "running", ...overrides }; }
function runRow(overrides: Partial<Row> = {}): Row { return { id: RUN, taskId: TASK, jobId: null, status: "running", ...overrides }; }
function jobRow(overrides: Partial<Row> = {}): Row { return { id: JOB, ownerId: "owner", requestorId: "requestor", roomId: "room", status: "running", input: { taskId: TASK, taskRunId: RUN }, ...overrides }; }

function tableName(table: unknown): string {
  if (table === tasks) return "tasks";
  if (table === taskRuns) return "taskRuns";
  if (table === jobs) return "jobs";
  if (table === rooms) return "rooms";
  if (table === actors) return "actors";
  if (table === roomMembers) return "roomMembers";
  throw new Error("unexpected table");
}

/** A deliberately narrow Drizzle fake: it records projections, transaction
 * locks, and the CAS result while returning only rows queued by each test. */
class CompositionDb {
  readonly projections: Array<Readonly<{ table: string; fields: readonly string[]; locked: boolean }>> = [];
  readonly locks: string[] = [];
  readonly updates: string[] = [];
  transactionCount = 0;

  constructor(
    private readonly plain: Row[][] = [],
    private readonly locked: Row[][] = [],
    private readonly cas: Row[][] = [],
  ) {}

  transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> { this.transactionCount += 1; return callback(this); }

  select(fields: Record<string, unknown>) {
    return { from: (table: unknown) => {
      const name = tableName(table);
      const projection = (locked: boolean) => {
        this.projections.push({ table: name, fields: Object.keys(fields).sort(), locked });
        if (locked) this.locks.push(`${name}:update`);
        return Promise.resolve((locked ? this.locked : this.plain).shift() ?? []);
      };
      const where = (_condition: unknown) => ({ limit: (_count: number) => projection(false), for: (lock: string) => {
        if (lock !== "update") throw new Error(`unexpected lock ${lock}`);
        return projection(true);
      } });
      return { where, innerJoin: (_joined: unknown, _condition: unknown) => ({ where }) };
    } };
  }

  update(table: unknown) {
    this.updates.push(tableName(table));
    return { set: (_patch: unknown) => ({ where: (_condition: unknown) => ({ returning: async (_fields: unknown) => this.cas.shift() ?? [] }) }) };
  }
}

function asDb(db: CompositionDb): DirectDatabase { return db as unknown as DirectDatabase; }
function exactReaders(linked = true): Row[][] { return [[taskRow()], [runRow({ jobId: linked ? JOB : null })], [jobRow()]]; }
async function rejected(promise: Promise<unknown>): Promise<void> { try { await promise; throw new Error("expected rejection"); } catch (error) { expect(error).toBeInstanceOf(HermesAcpTaskRunLifecycleRejected); } }

describe("OpenCode ACP task execution composition", () => {
  test("uses exact narrow route and lifecycle reader projections", async () => {
    const db = new CompositionDb([[taskRow()], ...exactReaders()]);
    const composition = createOpenCodeAcpTaskExecutionComposition(asDb(db));

    await composition.reader.getTask(TASK);
    await composition.lifecycle.reader.getTask(TASK);
    await composition.lifecycle.reader.getTaskRun(RUN);
    await composition.lifecycle.reader.getJob(JOB);

    expect(db.projections).toEqual([
      { table: "tasks", fields: ["agentId", "id", "metadata", "ownerId", "parentTaskId", "prompt", "requestorId", "targetRoomId"], locked: false },
      { table: "tasks", fields: ["agentId", "id", "ownerId", "parentTaskId", "requestorId", "scheduleKind", "status", "targetRoomId"], locked: false },
      { table: "taskRuns", fields: ["id", "jobId", "status", "taskId"], locked: false },
      { table: "jobs", fields: ["id", "input", "ownerId", "requestorId", "roomId", "status"], locked: false },
    ]);
  });

  test("locks Task → TaskRun → Job, rejects every authority drift before mutation, and permits exact idempotency only after all checks", async () => {
    const drifts: Array<readonly [string, Row, Row, Row]> = [
      ["task owner", taskRow({ ownerId: "other" }), runRow(), jobRow()], ["task requestor", taskRow({ requestorId: "other" }), runRow(), jobRow()], ["task agent", taskRow({ agentId: "other" }), runRow(), jobRow()], ["task parent", taskRow({ parentTaskId: "other" }), runRow(), jobRow()], ["task room", taskRow({ targetRoomId: "other" }), runRow(), jobRow()], ["task status", taskRow({ status: "paused" }), runRow(), jobRow()], ["task schedule", taskRow({ scheduleKind: "cron" }), runRow(), jobRow()],
      ["run id", taskRow(), runRow({ id: "other" }), jobRow()], ["run status", taskRow(), runRow({ status: "completed" }), jobRow()], ["run sibling", taskRow(), runRow({ jobId: "sibling" }), jobRow()],
      ["job id", taskRow(), runRow(), jobRow({ id: "other" })], ["job owner", taskRow(), runRow(), jobRow({ ownerId: "other" })], ["job requestor", taskRow(), runRow(), jobRow({ requestorId: "other" })], ["job room", taskRow(), runRow(), jobRow({ roomId: "other" })], ["job status", taskRow(), runRow(), jobRow({ status: "queued" })], ["job input", taskRow(), runRow(), jobRow({ input: { taskId: TASK, taskRunId: "other" } })],
    ];
    for (const [_name, task, run, job] of drifts) {
      const db = new CompositionDb([], [[task], [run], [job]]);
      const result = await createOpenCodeAcpTaskExecutionComposition(asDb(db)).lifecycle.writer.linkJob(facts);
      expect(result).toBe("conflict");
      expect(db.locks).toEqual(["tasks:update", "taskRuns:update", "jobs:update"]);
      expect(db.updates).toEqual([]);
    }

    const idempotent = new CompositionDb([], [[taskRow()], [runRow({ jobId: JOB })], [jobRow()]]);
    expect(await createOpenCodeAcpTaskExecutionComposition(asDb(idempotent)).lifecycle.writer.linkJob(facts)).toBe("already_linked");
    expect(idempotent.updates).toEqual([]);
  });

  test("performs a null-only one-row CAS and treats zero or multiple returned rows as conflict", async () => {
    for (const [returned, expected] of [[[{ id: RUN }] as Row[], "linked"], [[] as Row[], "conflict"], [[{ id: RUN }, { id: RUN }] as Row[], "conflict"]] as const) {
      const db = new CompositionDb([], [[taskRow()], [runRow()], [jobRow()]], [returned]);
      const result = await createOpenCodeAcpTaskExecutionComposition(asDb(db)).lifecycle.writer.linkJob(facts);
      expect(result).toBe(expected);
      expect(db.updates).toEqual(["taskRuns"]);
    }
  });

  test("passes mandatory authority to the writer and report-backs exact completion args with one same-args retry", async () => {
    const completionCalls: unknown[] = [];
    let attempts = 0;
    const db = new CompositionDb([...exactReaders(), ...exactReaders(), ...exactReaders()], [[taskRow()], [runRow()], [jobRow()]], [[{ id: RUN }]]);
    const composition = createOpenCodeAcpTaskExecutionComposition(asDb(db), {
      complete: async (_deps, args) => { completionCalls.push(args); attempts += 1; if (attempts === 1) throw new Error("first"); return true; },
      fail: async () => undefined,
    });

    await composition.taskRuns.linkJob(facts);
    await composition.taskRuns.complete({ ...facts, resultText: "answer" });

    expect(db.transactionCount).toBe(1);
    expect(completionCalls).toEqual([
      { taskId: TASK, runId: RUN, scheduleKind: "now", resultText: "answer" },
      { taskId: TASK, runId: RUN, scheduleKind: "now", resultText: "answer" },
    ]);
  });

  test("propagates the second completion error; OpenCode failure preserves its stable code and opts into only the fixed safe Room text", async () => {
    let completionAttempts = 0;
    const failures: unknown[] = [];
    const db = new CompositionDb([...exactReaders(), ...exactReaders()], [], []);
    const composition = createOpenCodeAcpTaskExecutionComposition(asDb(db), {
      complete: async () => { completionAttempts += 1; throw new Error(`completion-${completionAttempts}`); },
      fail: async (_deps, args) => { failures.push(args); },
    });

    let completionFailure: unknown;
    try { await composition.taskRuns.complete({ ...facts, resultText: "answer" }); } catch (error) { completionFailure = error; }
    await composition.taskRuns.fail({ ...facts, code: ACP_EXECUTION_FAILED });
    await rejected(composition.taskRuns.fail({ ...facts, code: "raw upstream detail" }));

    expect(completionAttempts).toBe(2);
    expect(completionFailure).toMatchObject({ message: "completion-2" });
    expect(failures).toEqual([{
      taskId: TASK,
      runId: RUN,
      scheduleKind: "now",
      error: ACP_EXECUTION_FAILED,
      failureResultText: "The delegated task could not be completed. Please try again.",
    }]);
  });

  test("retries one identical safe OpenCode failure report-back after a transient post-transition delivery error", async () => {
    const failures: unknown[] = [];
    const db = new CompositionDb([...exactReaders(), ...exactReaders()]);
    const composition = createOpenCodeAcpTaskExecutionComposition(asDb(db), {
      complete: async () => true,
      fail: async (_deps, args) => {
        failures.push(args);
        if (failures.length === 1) throw new Error("transient delivery failure");
      },
    });

    await composition.taskRuns.fail({ ...facts, code: ACP_EXECUTION_FAILED });

    expect(failures).toEqual([{
      taskId: TASK, runId: RUN, scheduleKind: "now", error: ACP_EXECUTION_FAILED,
      failureResultText: "The delegated task could not be completed. Please try again.",
    }, {
      taskId: TASK, runId: RUN, scheduleKind: "now", error: ACP_EXECUTION_FAILED,
      failureResultText: "The delegated task could not be completed. Please try again.",
    }]);
  });

  test("forwards the exact bounded OpenCode failure receipt without substituting legacy text", async () => {
    const failures: unknown[] = [];
    const receipt = { provider: "OpenCode", reason: "ended_without_result", phase: "running", processStarted: true, commandActivityCount: 1, outputObserved: true, containmentRequested: true } as const;
    const db = new CompositionDb([...exactReaders()]);
    const composition = createOpenCodeAcpTaskExecutionComposition(asDb(db), {
      complete: async () => true,
      fail: async (_deps, args) => { failures.push(args); },
    });

    await composition.taskRuns.fail({ ...facts, code: ACP_EXECUTION_FAILED, failureReceipt: receipt });

    expect(failures).toEqual([{
      taskId: TASK, runId: RUN, scheduleKind: "now", error: ACP_EXECUTION_FAILED, failureReceipt: receipt,
    }]);
  });
});
