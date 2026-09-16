import { expect, test } from "bun:test";
import { repairTaskContentAccessRecovery, transitionTaskApprovalExecution } from "../../src/queries/tasks";
import { tasks } from "../../src/schema/tasks";
import { taskRuns } from "../../src/schema/task-runs";
import { jobs } from "../../src/schema/jobs";
import type { DirectDatabase } from "../../src/config/direct-database";

const input = { taskId: "task", runId: "run", graphThreadId: "thread", ownerId: "human", requestorId: "human",
  agentId: "agent", roomId: "room", originalJobId: "job" };
function harness(options: { missingTask?: boolean; newerRun?: boolean; jobStatusDenied?: boolean; badLink?: boolean } = {}) {
  const locks: { table: unknown; kind: string }[] = [];
  const writes: unknown[] = [];
  const values = (table: unknown) => table === tasks ? options.missingTask ? [] : [{ id: "task", ownerId: "human", agentId: "agent" }]
    : table === taskRuns ? [{ id: options.newerRun ? "new-run" : "run", status: "running", graphThreadId: "thread", jobId: "job" }]
    : options.jobStatusDenied ? [] : [{ input: { taskId: "task", taskRunId: options.badLink ? "other" : "run", graphThreadId: "thread", agentId: "agent", roomId: "room", ownerId: "human" } }];
  const tx = {
    select: () => ({ from: (table: unknown) => {
      const q = { where: (_condition: unknown) => q, orderBy: (..._order: unknown[]) => q, limit: (_n: number) => q,
        for: async (kind: string) => { locks.push({ table, kind }); return values(table); } };
      return q;
    } }),
    update: (table: unknown) => ({ set: (patch: unknown) => ({ where: (_condition: unknown) => {
      writes.push({ table, patch });
      return { returning: async () => [{ id: "run" }], then: (resolve: (value: unknown) => void) => resolve([]) };
    } }) }),
  };
  const db = { transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as DirectDatabase;
  return { db, locks, writes };
}
test("crash repair locks Task, newest Run and original terminal Job before either write", async () => {
  const f = harness();
  expect(await repairTaskContentAccessRecovery(f.db, input)).toBe(true);
  expect(f.locks).toEqual([{ table: tasks, kind: "update" }, { table: taskRuns, kind: "update" }, { table: jobs, kind: "share" }]);
  expect(f.writes).toHaveLength(2);
});
test("Stop/foreign parent, newer Run, nonterminal Job or mismatched original input make zero writes", async () => {
  for (const options of [{ missingTask: true }, { newerRun: true }, { jobStatusDenied: true }, { badLink: true }]) {
    const f = harness(options);
    expect(await repairTaskContentAccessRecovery(f.db, input)).toBe(false);
    expect(f.writes).toHaveLength(0);
  }
});
test("ordinary claim requires latest Run before canonical awaiting/running transition", async () => {
  const f = harness({ newerRun: true });
  expect(await transitionTaskApprovalExecution(f.db, { taskId: "task", runId: "run", graphThreadId: "thread",
    ownerId: "human", from: "awaiting", to: "running", requireLatestRun: true })).toBe(false);
  expect(f.writes).toHaveLength(0);
});
