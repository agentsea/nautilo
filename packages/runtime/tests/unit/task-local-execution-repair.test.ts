import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { TASK_LOCAL_EXECUTION_RECREATE_TEXT, tasks, taskRuns, type DirectDatabase, type Task, type TaskRun } from "@nautilo/db";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";
import { parkTaskRunInterrupt } from "../../src/tasks/task-run-executor";
import { unpauseTask } from "../../src/tasks/lifecycle";

function fixture() {
  let task = { id: "task", ownerId: "owner", requestorId: "human", status: "paused", fundingMode: "legacy_server",
    scheduleKind: "now", metadata: {}, contentRevision: 0, mutationVersion: "1", localExecutionDelegation: null, lastError: null } as Task & { mutationVersion: string };
  let selects = 0; let updates = 0; let kicks = 0; let loseCAS = false; let predicate: SQL | undefined;
  const db = { select: () => {
    const chain = { from: () => chain, where: () => chain, orderBy: () => chain,
      limit: async () => { selects++; return selects <= 2 ? [structuredClone(task)] : []; } };
    return chain;
  }, update: () => {
    const chain = { set: () => chain, where: (value: SQL) => { predicate = value; return chain; },
      returning: async () => { updates++; return loseCAS ? [] : [{ ...task, status: "pending" }]; } };
    return chain;
  } } as unknown as DirectDatabase;
  return { deps: { db, jobManager: { abortJob: () => false }, observer: { kick: () => { kicks++; } } },
    setRepair: () => { task = { ...task, lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT }; },
    loseCAS: () => { loseCAS = true; }, counts: () => ({ selects, updates, kicks }), predicate: () => predicate };
}

test("Resume cannot turn edited delegated work into a cloud-only Task", async () => {
  const f = fixture(); f.setRepair();
  expect(await unpauseTask(f.deps, "task")).toEqual({ ok: false, status: "paused", message: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
  expect(f.counts()).toEqual({ selects: 1, updates: 0, kicks: 0 });
});

test("ordinary cloud Tasks retain Resume bound to the exact tuple version", async () => {
  const f = fixture(); expect(await unpauseTask(f.deps, "task")).toMatchObject({ ok: true, status: "pending" });
  const query = new PgDialect().sqlToQuery(f.predicate()!);
  expect(query.sql).toContain('xmin::text'); expect(query.params).toContain("1"); expect(query.params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  expect(f.counts()).toEqual({ selects: 3, updates: 1, kicks: 1 });
});

test("an edit winning while Resume awaits its checkpoint query prevents dispatch", async () => {
  const f = fixture(); f.loseCAS(); expect(await unpauseTask(f.deps, "task")).toMatchObject({ ok: false, status: "changed" });
  expect(f.counts().kicks).toBe(0);
});


function interruptFixture(repair: boolean) {
  let task = { id: "task", ownerId: "canonical-owner", status: repair ? "paused" : "running", scheduleKind: "now",
    localExecutionDelegation: null, lastError: repair ? TASK_LOCAL_EXECUTION_RECREATE_TEXT : null } as Task;
  let run = { id: "run", taskId: "task", status: "running", resultText: null } as TaskRun;
  const db = { transaction: async (work: (tx: DirectDatabase) => Promise<unknown>) => work(db as unknown as DirectDatabase),
    select: () => { let table: unknown; const chain = { from: (value: unknown) => { table = value; return chain; },
      where: () => chain, orderBy: () => chain, limit: () => chain,
      for: async () => [structuredClone(table === tasks ? task : run)] }; return chain; },
    update: (table: unknown) => { let patch: Record<string, unknown>; const chain = { set: (value: Record<string, unknown>) => { patch = value; return chain; },
      where: () => chain, returning: async () => {
        if (table === taskRuns) { run = { ...run, ...patch } as TaskRun; return [run]; }
        task = { ...task, ...patch } as Task; return [task];
      } }; return chain; },
  };
  return { db: db as unknown as DirectDatabase, task: () => task, run: () => run };
}

test("an edited Task interrupt cancels the old Run without emitting false awaiting or approval", async () => {
  const f = interruptFixture(true); const events: ServerEvent[] = []; const listener = (event: ServerEvent) => { events.push(event); };
  eventBus.on(listener);
  try {
    expect(await parkTaskRunInterrupt(f.db, { taskId: "task", taskRunId: "run" })).toBe(false);
    expect(f.task()).toMatchObject({ status: "paused", lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
    expect(f.run()).toMatchObject({ status: "cancelled", resultText: null, lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
    expect(events).toHaveLength(0);
  } finally { eventBus.off(listener); }
});

test("an admitted current interrupt publishes only its committed canonical Task owner", async () => {
  const f = interruptFixture(false); const events: ServerEvent[] = []; const listener = (event: ServerEvent) => { events.push(event); };
  eventBus.on(listener);
  try {
    expect(await parkTaskRunInterrupt(f.db, { taskId: "task", taskRunId: "run" })).toBe(true);
    expect(events).toEqual([{ type: "task.status", taskId: "task", ownerId: "canonical-owner", status: "awaiting" }]);
    expect(f.run().status).toBe("awaiting"); expect(f.task().status).toBe("awaiting");
  } finally { eventBus.off(listener); }
});
