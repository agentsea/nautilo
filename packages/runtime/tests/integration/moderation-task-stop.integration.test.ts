import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  __resetSharedDirectDbForTests, agents, ensureDatabase, eq, getSharedDirectDb,
  taskRuns, tasks, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { stopTask } from "../../src/tasks/lifecycle";

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase();
}, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });

async function fixture() {
  const db = getSharedDirectDb();
  const [human] = await db.insert(users).values({ name: "Task cancellation fixture", externalId: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ handle: `moderation-${randomUUID()}` }).returning();
  if (!human || !agent) throw new Error("Fixture creation failed");
  const [task] = await db.insert(tasks).values({ ownerId: human.id, requestorId: human.id,
    agentId: agent.id, prompt: "Synthetic Task", status: "running" }).returning();
  if (!task) throw new Error("Task creation failed");
  const [run] = await db.insert(taskRuns).values({ taskId: task.id, graphThreadId: randomUUID(), startedAt: new Date(0) }).returning();
  if (!run) throw new Error("Run creation failed");
  const aborted: unknown[] = [];
  let reports = 0;
  const deps = { db, jobManager: { abortJob: (...args: unknown[]) => { aborted.push(args); return true; } },
    reportBackCancellation: async () => { reports += 1; },
  };
  return { db, human, task, run, deps, aborted, reports: () => reports,
    async cleanup() { await db.delete(users).where(eq(users.id, human.id)); await db.delete(agents).where(eq(agents.id, agent.id)); },
  };
}

test("selective Stop terminalizes the exact Human's accepted run with no concrete Job", async () => {
  const f = await fixture();
  try {
    const result = await stopTask(f.deps, f.task.id, { humanUserId: f.human.id, taskRunId: f.run.id });
    expect(result.status).toBe("cancelled");
    const [run] = await f.db.select().from(taskRuns).where(eq(taskRuns.id, f.run.id));
    expect(run?.status).toBe("cancelled");
    expect(f.aborted).toEqual([["", "stop", { taskId: f.task.id, taskRunId: f.run.id }]]);
    expect(f.reports()).toBe(1);
  } finally { await f.cleanup(); }
});

test("an old worker cannot cancel a newer run of the same Task", async () => {
  const f = await fixture();
  try {
    await f.db.update(taskRuns).set({ status: "paused" }).where(eq(taskRuns.id, f.run.id));
    const [newRun] = await f.db.insert(taskRuns).values({ taskId: f.task.id, graphThreadId: randomUUID() }).returning();
    const result = await stopTask(f.deps, f.task.id, { humanUserId: f.human.id, taskRunId: f.run.id });
    expect(result.status).toBe("authority_changed");
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    const [run] = await f.db.select().from(taskRuns).where(eq(taskRuns.id, newRun!.id));
    expect(task?.status).toBe("running"); expect(run?.status).toBe("running");
    expect(f.aborted).toHaveLength(0); expect(f.reports()).toBe(0);
  } finally { await f.cleanup(); }
});

test("a different initiating Human cannot use the selective Task stop", async () => {
  const f = await fixture();
  try {
    const result = await stopTask(f.deps, f.task.id, { humanUserId: randomUUID(), taskRunId: f.run.id });
    expect(result.status).toBe("authority_changed");
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    expect(task?.status).toBe("running"); expect(f.aborted).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("selective cancellation respects a reserved Writer save", async () => {
  const f = await fixture();
  try {
    await f.db.update(tasks).set({ metadata: { writerReviewAwaiting: {
      version: 1, taskRunId: f.run.id, proposalId: randomUUID(),
      pendingWorkspaceOperationId: randomUUID(), pendingWorkspaceClientMutationId: randomUUID(),
    } } }).where(eq(tasks.id, f.task.id));
    const result = await stopTask(f.deps, f.task.id, { humanUserId: f.human.id, taskRunId: f.run.id });
    expect(result.ok).toBe(false); expect(result.status).toBe("awaiting"); expect(f.aborted).toHaveLength(0);
  } finally { await f.cleanup(); }
});


test("equal run timestamps cannot select an older run as current", async () => {
  const f = await fixture();
  try {
    await f.db.insert(taskRuns).values({ taskId: f.task.id, graphThreadId: randomUUID(), startedAt: new Date(0) });
    const result = await stopTask(f.deps, f.task.id, { humanUserId: f.human.id, taskRunId: f.run.id });
    expect(result.status).toBe("authority_changed"); expect(f.aborted).toHaveLength(0);
  } finally { await f.cleanup(); }
});
