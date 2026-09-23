/**
 * M141 — Task primitive substrate on live Postgres.
 *
 * Covers migration shape (tables / columns / indexes / constraints) and the
 * `queries/tasks.ts` store layer (CRUD, claim/lock concurrency, lifecycle
 * setters). Requires migration 0075 applied to the target instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  sql,
  users,
  agents,
  namespaces,
  rooms,
  tasks,
  createTask,
  getTaskById,
  getTaskByIdWithMutationVersion,
  listTasksForOwner,
  updateTask,
  updateTaskIfCurrent,
  insertTaskRun,
  getTaskRuns,
  countActiveTaskWorkWith,
  claimDueTasks,
  clearStaleFireLocks,
  pauseClaimedTaskForAuthorizationDenial,
  pauseAwaitingTaskRunForAuthorizationDenial,
  rescheduleCron,
  markTaskRunning,
  markTaskAwaiting,
  markTaskPaused,
  markTaskCompleted,
  markTaskCancelled,
  markTaskErrored,
  markTaskRunStatus,
  findOpenPingTask,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

/** Seed a fresh owner user + agent; returns their ids. */
async function seedOwnerAndAgent(tag: string) {
  const ts = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ name: `m141-${tag}`, email: `m141-${tag}-${ts}@test.local` })
    .returning({ id: users.id });
  const [agent] = await db
    .insert(agents)
    .values({ handle: `m141-${tag}-${ts}` })
    .returning({ id: agents.id });
  if (!user || !agent) throw new Error("seed owner/agent failed");
  return { userId: user.id, agentId: agent.id };
}

/** Convenience: a minimal valid NewTask for `owner`. */
function taskInput(
  owner: { userId: string; agentId: string },
  overrides: Partial<Parameters<typeof createTask>[1]> = {},
) {
  return {
    ownerId: owner.userId,
    requestorId: owner.userId,
    agentId: owner.agentId,
    prompt: "do the thing",
    ...overrides,
  };
}

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
async function newOwner(tag: string) {
  const o = await seedOwnerAndAgent(tag);
  createdUserIds.push(o.userId);
  createdAgentIds.push(o.agentId);
  return o;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  // Deleting the owner cascades tasks → task_runs.
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdAgentIds) {
    await db.delete(agents).where(eq(agents.id, id));
  }
  await db.end();
});

describe("M141 migration shape", () => {
  test("tasks + task_runs tables exist with key columns", async () => {
    const cols = (await db.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name IN ('tasks','task_runs')
    `)) as unknown as Array<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>;
    const taskCols = new Set(
      cols.filter((c) => c.table_name === "tasks").map((c) => c.column_name),
    );
    const runCols = new Set(
      cols.filter((c) => c.table_name === "task_runs").map((c) => c.column_name),
    );
    for (const c of [
      "id",
      "owner_id",
      "requestor_id",
      "agent_id",
      "prompt",
      "preset",
      "schedule_kind",
      "status",
      "next_fire_at",
      "fire_lock_id",
      "fire_locked_at",
      "parent_task_id",
      "target_user_ids",
      "tools_whitelist",
      "metadata",
      // M152 — multi-axis selection columns replace `privacy_mode`.
      "selection_profile",
      "selection_spec",
    ]) {
      expect(taskCols.has(c)).toBe(true);
    }
    // M152 — `privacy_mode` was dropped (replaced by selection_profile/spec).
    expect(taskCols.has("privacy_mode")).toBe(false);
    for (const c of [
      "id",
      "task_id",
      "job_id",
      "graph_thread_id",
      "status",
      "model_id",
      "result_text",
      "started_at",
    ]) {
      expect(runCols.has(c)).toBe(true);
    }
    // M152 — `privacy_warning` was dropped (A6: no soft-warning concept).
    expect(runCols.has("privacy_warning")).toBe(false);
  });

  test("M152 — selection_profile defaults to 'balanced' and selection_spec is nullable", async () => {
    const owner = await newOwner("m152-defaults");
    const task = await createTask(db, taskInput(owner));
    expect(task.selectionProfile).toBe("balanced");
    expect(task.selectionSpec).toBeNull();

    const meta = (await db.execute(sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'tasks'
        AND column_name IN ('selection_profile','selection_spec')
    `)) as unknown as Array<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>;
    const profileCol = meta.find((c) => c.column_name === "selection_profile");
    const specCol = meta.find((c) => c.column_name === "selection_spec");
    expect(profileCol?.is_nullable).toBe("NO");
    expect(profileCol?.column_default).toContain("balanced");
    expect(specCol?.is_nullable).toBe("YES");
  });

  test("expected indexes exist", async () => {
    const idx = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('tasks','task_runs')
    `)) as unknown as Array<{ indexname: string }>;
    const names = new Set(idx.map((r) => r.indexname));
    for (const n of [
      "tasks_due_idx",
      "tasks_owner_idx",
      "tasks_calling_room_idx",
      "task_runs_task_idx",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("session_messages.metadata column exists and is nullable", async () => {
    const rowsRes = (await db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'session_messages' AND column_name = 'metadata'
    `)) as unknown as Array<{ is_nullable: string }>;
    expect(rowsRes.length).toBe(1);
    expect(rowsRes[0]?.is_nullable).toBe("YES");
  });

  test("rooms_kind_check accepts 'task' and rejects a bogus kind", async () => {
    const owner = await newOwner("roomkind");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "test", label: "m141-task-room" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");

    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: owner.userId,
        type: "private",
        label: "task room",
        graphThreadId: `m141-task-${Date.now()}`,
        namespaceId: ns.id,
        kind: "task",
      })
      .returning({ id: rooms.id, kind: rooms.kind });
    expect(room?.kind).toBe("task");

    let rejected = false;
    try {
      await db.execute(sql`
        INSERT INTO rooms (owner_id, type, label, graph_thread_id, namespace_id, kind)
        VALUES (${owner.userId}, 'private', 'bogus', ${"m141-bogus-" + Date.now()}, ${ns.id}, 'bogus_kind')
      `);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    if (room) await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
  });

  test("deleting a task cascades its task_runs", async () => {
    const owner = await newOwner("cascade-run");
    const task = await createTask(db, taskInput(owner));
    await insertTaskRun(db, { taskId: task.id, graphThreadId: "t1" });
    await insertTaskRun(db, { taskId: task.id, graphThreadId: "t2" });
    expect((await getTaskRuns(db, task.id)).length).toBe(2);

    await db.delete(tasks).where(eq(tasks.id, task.id));
    expect((await getTaskRuns(db, task.id)).length).toBe(0);
  });

  test("deleting owner user cascades tasks", async () => {
    const owner = await seedOwnerAndAgent("cascade-owner");
    const task = await createTask(db, taskInput(owner));
    await db.delete(users).where(eq(users.id, owner.userId));
    expect(await getTaskById(db, task.id)).toBeUndefined();
    await db.delete(agents).where(eq(agents.id, owner.agentId));
  });

  test("parent_task_id self-FK is ON DELETE SET NULL", async () => {
    const owner = await newOwner("selffk");
    const parent = await createTask(db, taskInput(owner, { prompt: "parent" }));
    const child = await createTask(
      db,
      taskInput(owner, { prompt: "child", parentTaskId: parent.id, depth: 1 }),
    );
    expect(child.parentTaskId).toBe(parent.id);

    await db.delete(tasks).where(eq(tasks.id, parent.id));
    const refreshed = await getTaskById(db, child.id);
    expect(refreshed?.parentTaskId).toBeNull();
  });
});

describe("M141 store layer", () => {
  test("createTask → getTaskById round-trips arrays + jsonb metadata", async () => {
    const owner = await newOwner("roundtrip");
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const task = await createTask(
      db,
      taskInput(owner, {
        expectedOutput: "a report",
        preset: "in_background",
        scheduleKind: "one_shot",
        targetUserIds: [u1, u2],
        toolsMode: "whitelist",
        toolsWhitelist: ["file", "run_shell"],
        metadata: { foo: "bar", n: 1 },
      }),
    );
    const got = await getTaskById(db, task.id);
    expect(got).toBeDefined();
    expect(got?.targetUserIds).toEqual([u1, u2]);
    expect(got?.toolsWhitelist).toEqual(["file", "run_shell"]);
    expect(got?.metadata).toEqual({ foo: "bar", n: 1 });
    expect(got?.preset).toBe("in_background");
    expect(got?.status).toBe("pending");
    expect(got?.depth).toBe(0);
  });

  test("claimDueTasks claims only pending + due + unlocked rows, stamping the lock", async () => {
    const owner = await newOwner("claim-filter");
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);

    const dueRow = await createTask(
      db,
      taskInput(owner, { status: "pending", nextFireAt: past }),
    );
    await createTask(db, taskInput(owner, { status: "pending", nextFireAt: future }));
    await createTask(db, taskInput(owner, { status: "running", nextFireAt: past }));
    await createTask(
      db,
      taskInput(owner, {
        status: "pending",
        nextFireAt: past,
        fireLockId: crypto.randomUUID(),
        fireLockedAt: past,
      }),
    );

    const claimed = await claimDueTasks(db, now, 10);
    const claimedIds = claimed.map((t) => t.id);
    expect(claimedIds).toContain(dueRow.id);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.fireLockId).not.toBeNull();
    expect(claimed[0]?.fireLockedAt).not.toBeNull();
  });

  test("countActiveTaskWorkWith counts running runs and pending fire-lock claims only", async () => {
    const owner = await newOwner("maintenance-active-work");
    const before = await countActiveTaskWorkWith(db);
    const claimed = await createTask(
      db,
      taskInput(owner, {
        status: "pending",
        fireLockId: crypto.randomUUID(),
        fireLockedAt: new Date(),
      }),
    );
    const running = await createTask(db, taskInput(owner, { status: "running" }));
    await insertTaskRun(db, {
      taskId: running.id,
      graphThreadId: `task:${running.id}:running`,
      status: "running",
    });
    const parked = await createTask(db, taskInput(owner, { status: "awaiting" }));
    await insertTaskRun(db, {
      taskId: parked.id,
      graphThreadId: `task:${parked.id}:parked`,
      status: "awaiting",
    });

    const counts = await countActiveTaskWorkWith(db);
    expect(claimed.fireLockId).not.toBeNull();
    expect(counts.claimedTasks).toBe(before.claimedTasks + 1);
    expect(counts.runningTaskRuns).toBe(before.runningTaskRuns + 1);
  });

  test("two concurrent claimDueTasks claim DISJOINT rows (FOR UPDATE SKIP LOCKED)", async () => {
    const owner = await newOwner("claim-concurrent");
    const past = new Date(Date.now() - 60_000);
    const N = 8;
    for (let i = 0; i < N; i++) {
      await createTask(db, taskInput(owner, { status: "pending", nextFireAt: past }));
    }
    const now = new Date();

    const [a, b] = await Promise.all([
      claimDueTasks(db, now, N),
      claimDueTasks(db, now, N),
    ]);
    const aIds = a.map((t) => t.id);
    const bIds = b.map((t) => t.id);

    // No row claimed by both observers.
    const overlap = aIds.filter((id) => bIds.includes(id));
    expect(overlap).toEqual([]);
    // No duplicates within a single claim batch.
    expect(new Set(aIds).size).toBe(aIds.length);
    expect(new Set(bIds).size).toBe(bIds.length);
    // Together they claim only this owner's due rows (could be fewer if one
    // batch lost the race entirely — but never more, never double).
    expect(aIds.length + bIds.length).toBeLessThanOrEqual(N);
  });

  test("clearStaleFireLocks clears only rows older than the cutoff", async () => {
    const owner = await newOwner("stale-locks");
    const old = new Date(Date.now() - 600_000);
    const recent = new Date(Date.now() - 1_000);

    const staleTask = await createTask(
      db,
      taskInput(owner, { fireLockId: crypto.randomUUID(), fireLockedAt: old }),
    );
    const freshTask = await createTask(
      db,
      taskInput(owner, { fireLockId: crypto.randomUUID(), fireLockedAt: recent }),
    );

    const cutoff = new Date(Date.now() - 300_000);
    const cleared = await clearStaleFireLocks(db, cutoff);
    expect(cleared).toBeGreaterThanOrEqual(1);

    const stale = await getTaskById(db, staleTask.id);
    const fresh = await getTaskById(db, freshTask.id);
    expect(stale?.fireLockId).toBeNull();
    expect(stale?.fireLockedAt).toBeNull();
    expect(fresh?.fireLockId).not.toBeNull();
  });

  test("authorization pause wins only the exact pending fire-lock claim", async () => {
    const owner = await newOwner("auth-pause-claim");
    const fireLockId = crypto.randomUUID();
    const task = await createTask(
      db,
      taskInput(owner, {
        status: "pending",
        fireLockId,
        fireLockedAt: new Date(),
      }),
    );

    const stale = await pauseClaimedTaskForAuthorizationDenial(db, {
      taskId: task.id,
      fireLockId: crypto.randomUUID(),
    });
    expect(stale.transitioned).toBe(false);
    expect((await getTaskById(db, task.id))?.status).toBe("pending");

    const won = await pauseClaimedTaskForAuthorizationDenial(db, {
      taskId: task.id,
      fireLockId,
    });
    expect(won.transitioned).toBe(true);
    const paused = await getTaskById(db, task.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.lastError).toBe("invoke_agents_required");
    expect(paused?.fireLockId).toBeNull();
    expect(paused?.fireLockedAt).toBeNull();

    const duplicate = await pauseClaimedTaskForAuthorizationDenial(db, {
      taskId: task.id,
      fireLockId,
    });
    expect(duplicate.transitioned).toBe(false);
  });

  test("authorization pause atomically parks the exact awaiting TaskRun", async () => {
    const owner = await newOwner("auth-pause-awaiting");
    const task = await createTask(db, taskInput(owner, { status: "awaiting" }));
    const run = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `task:${task.id}:awaiting`,
      status: "awaiting",
    });

    const stale = await pauseAwaitingTaskRunForAuthorizationDenial(db, {
      taskId: task.id,
      taskRunId: run.id,
      graphThreadId: "wrong-thread",
    });
    expect(stale.transitioned).toBe(false);
    expect((await getTaskById(db, task.id))?.status).toBe("awaiting");
    expect((await getTaskRuns(db, task.id))[0]?.status).toBe("awaiting");

    const won = await pauseAwaitingTaskRunForAuthorizationDenial(db, {
      taskId: task.id,
      taskRunId: run.id,
      graphThreadId: run.graphThreadId,
    });
    expect(won.transitioned).toBe(true);
    expect((await getTaskById(db, task.id))?.status).toBe("paused");
    expect((await getTaskById(db, task.id))?.lastError).toBe(
      "invoke_agents_required",
    );
    expect((await getTaskRuns(db, task.id))[0]?.status).toBe("paused");
  });

  test("rescheduleCron sets next/last fire, clears lock, keeps pending", async () => {
    const owner = await newOwner("reschedule");
    const task = await createTask(
      db,
      taskInput(owner, {
        scheduleKind: "cron",
        status: "pending",
        fireLockId: crypto.randomUUID(),
        fireLockedAt: new Date(),
      }),
    );
    const next = new Date(Date.now() + 3_600_000);
    await rescheduleCron(db, task.id, next);

    const got = await getTaskById(db, task.id);
    expect(got?.status).toBe("pending");
    expect(got?.fireLockId).toBeNull();
    expect(got?.fireLockedAt).toBeNull();
    expect(got?.lastFiredAt).not.toBeNull();
    expect(got?.nextFireAt?.getTime()).toBe(next.getTime());
  });

  test("lifecycle setters transition status (+ stamp cancelledAt / lastError)", async () => {
    const owner = await newOwner("lifecycle");

    const running = await createTask(db, taskInput(owner));
    await markTaskRunning(db, running.id);
    expect((await getTaskById(db, running.id))?.status).toBe("running");

    await markTaskAwaiting(db, running.id);
    expect((await getTaskById(db, running.id))?.status).toBe("awaiting");

    await markTaskPaused(db, running.id);
    expect((await getTaskById(db, running.id))?.status).toBe("paused");

    await markTaskCompleted(db, running.id);
    expect((await getTaskById(db, running.id))?.status).toBe("completed");

    const cancelled = await createTask(db, taskInput(owner));
    await markTaskCancelled(db, cancelled.id);
    const c = await getTaskById(db, cancelled.id);
    expect(c?.status).toBe("cancelled");
    expect(c?.cancelledAt).not.toBeNull();

    const errored = await createTask(
      db,
      taskInput(owner, { fireLockId: crypto.randomUUID(), fireLockedAt: new Date() }),
    );
    await markTaskErrored(db, errored.id, "boom");
    const e = await getTaskById(db, errored.id);
    expect(e?.status).toBe("errored");
    expect(e?.lastError).toBe("boom");
    expect(e?.fireLockId).toBeNull();
  });

  test("updateTask bumps updatedAt and applies the patch", async () => {
    const owner = await newOwner("update");
    const task = await createTask(db, taskInput(owner));
    const before = task.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const patched = await updateTask(db, task.id, {
      prompt: "changed",
      selectionProfile: "cheapest",
    });
    expect(patched?.prompt).toBe("changed");
    expect(patched?.selectionProfile).toBe("cheapest");
    expect(patched!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test("conditional update uses a lossless tuple version across microsecond timestamps", async () => {
    const owner = await newOwner("conditional-update");
    const task = await createTask(db, taskInput(owner));

    await db
      .update(tasks)
      .set({
        updatedAt: sql`date_trunc('second', clock_timestamp()) + interval '123456 microseconds'`,
      })
      .where(eq(tasks.id, task.id));

    const [precision] = await db
      .select({ microseconds: sql<string>`to_char(${tasks.updatedAt}, 'US')` })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(precision?.microseconds).toBe("123456");

    const snapshot = await getTaskByIdWithMutationVersion(db, task.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.updatedAt.toISOString()).toEndWith(".123Z");

    const updated = await updateTaskIfCurrent(db, {
      id: task.id,
      ownerId: owner.userId,
      expectedStatus: "pending",
      expectedMutationVersion: snapshot!.mutationVersion,
      expectedContentRevision: snapshot!.contentRevision,
    }, { prompt: "changed exactly once" });
    expect(updated?.prompt).toBe("changed exactly once");

    const staleRetry = await updateTaskIfCurrent(db, {
      id: task.id,
      ownerId: owner.userId,
      expectedStatus: "pending",
      expectedMutationVersion: snapshot!.mutationVersion,
      expectedContentRevision: snapshot!.contentRevision,
    }, { prompt: "stale overwrite" });
    expect(staleRetry).toBeUndefined();
    expect((await getTaskById(db, task.id))?.prompt).toBe("changed exactly once");
  });

  test("markTaskRunStatus updates a task_runs row", async () => {
    const owner = await newOwner("run-status");
    const task = await createTask(db, taskInput(owner));
    const run = await insertTaskRun(db, { taskId: task.id, graphThreadId: "run-1" });
    expect(run.status).toBe("running");
    await markTaskRunStatus(db, run.id, "completed", { resultText: "done" });
    const [refreshed] = await getTaskRuns(db, task.id);
    expect(refreshed?.status).toBe("completed");
    expect(refreshed?.resultText).toBe("done");
  });

  test("listTasksForOwner scopes to owner and toggles terminal filtering", async () => {
    const owner = await newOwner("list");
    const other = await newOwner("list-other");

    const pending = await createTask(db, taskInput(owner, { status: "pending" }));
    const done = await createTask(db, taskInput(owner, { status: "completed" }));
    await createTask(db, taskInput(other, { status: "pending" }));

    const active = await listTasksForOwner(db, owner.userId);
    const activeIds = active.map((t) => t.id);
    expect(activeIds).toContain(pending.id);
    expect(activeIds).not.toContain(done.id);

    const all = await listTasksForOwner(db, owner.userId, { includeTerminal: true });
    const allIds = all.map((t) => t.id);
    expect(allIds).toContain(pending.id);
    expect(allIds).toContain(done.id);

    const onlyCompleted = await listTasksForOwner(db, owner.userId, { status: "completed" });
    expect(onlyCompleted.map((t) => t.id)).toEqual([done.id]);
  });

  test("listTasksForOwner returns every active row plus a bounded newest terminal window", async () => {
    const owner = await newOwner("recent-terminal");
    const other = await newOwner("recent-terminal-other");
    const activeOlder = await createTask(db, taskInput(owner, {
      status: "pending",
      createdAt: new Date("2040-01-01T00:00:00.000Z"),
      updatedAt: new Date("2040-01-01T00:00:00.000Z"),
    }));
    const activeNewer = await createTask(db, taskInput(owner, {
      status: "awaiting",
      createdAt: new Date("2040-01-02T00:00:00.000Z"),
      updatedAt: new Date("2040-01-02T00:00:00.000Z"),
    }));
    const terminalOldest = await createTask(db, taskInput(owner, {
      status: "completed",
      updatedAt: new Date("2040-02-01T00:00:00.000Z"),
    }));
    const terminalMiddle = await createTask(db, taskInput(owner, {
      status: "cancelled",
      updatedAt: new Date("2040-02-02T00:00:00.000Z"),
    }));
    const terminalNewest = await createTask(db, taskInput(owner, {
      status: "errored",
      updatedAt: new Date("2040-02-03T00:00:00.000Z"),
    }));
    const otherTerminal = await createTask(db, taskInput(other, {
      status: "completed",
      updatedAt: new Date("2040-02-04T00:00:00.000Z"),
    }));

    const recent = await listTasksForOwner(db, owner.userId, {
      includeTerminal: true,
      recentTerminalLimit: 2,
    });
    expect(recent.map((task) => task.id)).toEqual([
      activeOlder.id,
      activeNewer.id,
      terminalNewest.id,
      terminalMiddle.id,
    ]);
    expect(recent.map((task) => task.id)).not.toContain(terminalOldest.id);
    expect(recent.map((task) => task.id)).not.toContain(otherTerminal.id);

    const exactTerminal = await listTasksForOwner(db, owner.userId, {
      status: "completed",
      recentTerminalLimit: 1,
    });
    expect(exactTerminal.map((task) => task.id)).toEqual([terminalOldest.id]);
  });

  test("listTasksForOwner clamps the bounded terminal window to its hard maximum", async () => {
    const owner = await newOwner("recent-terminal-cap");
    const base = new Date("2041-01-01T00:00:00.000Z").getTime();
    const terminalIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const task = await createTask(db, taskInput(owner, {
        status: "completed",
        updatedAt: new Date(base + index * 1_000),
      }));
      terminalIds.push(task.id);
    }

    const capped = await listTasksForOwner(db, owner.userId, {
      includeTerminal: true,
      recentTerminalLimit: 10_000,
    });
    expect(capped).toHaveLength(50);
    expect(capped[0]?.id).toBe(terminalIds[50]);
    expect(capped.at(-1)?.id).toBe(terminalIds[1]);
  });

  test("findOpenPingTask matches pending/running ping by metadata.artifactId", async () => {
    const owner = await newOwner("ping-open");
    const artifactId = `art-${Date.now()}`;

    const pending = await createTask(
      db,
      taskInput(owner, {
        preset: "ping",
        status: "pending",
        metadata: { artifactId, topic: "t1", source: "artifact_ping" },
      }),
    );
    const running = await createTask(
      db,
      taskInput(owner, {
        preset: "ping",
        status: "running",
        metadata: { artifactId: `${artifactId}-other`, source: "artifact_ping" },
      }),
    );
    const completed = await createTask(
      db,
      taskInput(owner, {
        preset: "ping",
        status: "completed",
        metadata: { artifactId, source: "artifact_ping" },
      }),
    );

    const hit = await findOpenPingTask(db, {
      ownerId: owner.userId,
      agentId: owner.agentId,
      artifactId,
    });
    expect(hit?.id).toBe(pending.id);

    const otherHit = await findOpenPingTask(db, {
      ownerId: owner.userId,
      agentId: owner.agentId,
      artifactId: `${artifactId}-other`,
    });
    expect(otherHit?.id).toBe(running.id);

    const miss = await findOpenPingTask(db, {
      ownerId: owner.userId,
      agentId: owner.agentId,
      artifactId: `${artifactId}-missing`,
    });
    expect(miss).toBeUndefined();

    await markTaskCompleted(db, pending.id);
    expect(
      await findOpenPingTask(db, {
        ownerId: owner.userId,
        agentId: owner.agentId,
        artifactId,
      }),
    ).toBeUndefined();

    await db.delete(tasks).where(eq(tasks.id, completed.id));
  });
});
