/**
 * M145 — `schedule` shortcut end-to-end against real Postgres + a stub graph.
 *
 * Authors tasks through the REAL `schedule` tool (validation → DI seam → runtime
 * `createTask`) and proves the minimal viable subset of the blast radius reaches
 * the finished M142/M143 engine from the new surface:
 *
 *  - S1 one-shot: `when:{kind:"once", at:<future ISO>}` → a `one_shot` row with
 *    the correct shape (`preset:"schedule"`, `target_chat:"last_in_namespace"`,
 *    `result_delivery:"wake"`, `timezone` from ctx, `run_at` = parsed date) that
 *    fires once on the next tick and reports back into the calling room; the row
 *    goes terminal (one-shot does not reschedule).
 *  - S2 cron + catch-up (D8): `when:{kind:"recurring", cron}` → a `cron` row in
 *    the ctx timezone; a past-due first occurrence fires once on the next tick
 *    and `rescheduleCron` advances `next_fire_at` forward in the task's timezone
 *    (status stays `pending`). Reuses M142's cron assertions from the new surface.
 *  - S3 validation: a past one-shot authored through the tool returns a friendly
 *    error string and persists NO row (the only net-new logic, end-to-end).
 *
 * No API keys: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  tasks,
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  jobs,
  getTaskById,
  getTaskRuns,
  markTaskCancelled,
  updateTask,
  eq,
  and,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import {
  __setStubModelForTests,
  setAgentEventSink,
  ensureSession,
  getRoomMessagesAcrossMemberSessions,
  setTaskToolRuntime,
  createScheduleTool,
} from "@nautilo/agent";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  createTask as runtimeCreateTask,
  computeNextFireAt as runtimeComputeNextFireAt,
} from "../../src/tasks/create-task";
import { nextCronOccurrence } from "../../src/tasks/cron";
import {
  setTaskRunDb,
  setTaskRunJobManager,
} from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
  taskTablesCleanStatus,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";

const TZ = "America/New_York";

let userId: string;
let agentId: string;
let agentActorId: string;
let db: DirectDatabase;

const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdUserActorIds: string[] = [];

await setupTestDb();
db = getDirectDb();
const taskTableStatus = await taskTablesCleanStatus(db);
const taskSuiteSkipReason = taskTableStatus.clean
  ? null
  : taskTableStatus.reason;
if (taskSuiteSkipReason) {
  console.warn(`Skipping schedule-shortcut integration suite: ${taskSuiteSkipReason}`);
  await closeDirectDb();
}

beforeAll(async () => {
  if (taskSuiteSkipReason) return;
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("m145-schedule");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")))
    .limit(1);
  agentActorId = aa!.id;

  // The `schedule` tool reaches the runtime createTask via the DI seam. A no-op
  // observer kick is fine: one_shot/cron do NOT kick (only `now` does) — we tick
  // the observer explicitly below.
  setTaskToolRuntime({
    db,
    createTask: (input) =>
      runtimeCreateTask({
        db,
        observer: { kick: () => {} },
        invocationAuthority: createAcceptedInvocationAuthority(input.requestorId),
      }, input),
    computeNextFireAt: runtimeComputeNextFireAt,
    // M147 — lifecycle not exercised by this suite; satisfy the DI contract.
    pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
    unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
    stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
  });

});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  if (taskSuiteSkipReason) return;
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  setTaskRunJobManager(null);
  setTaskToolRuntime(null);

  for (const rid of createdRoomIds) {
    const sess = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, rid));
    const ids = sess.map((s) => s.id);
    if (ids.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await db.delete(sessions).where(inArray(sessions.id, ids));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
    await db.delete(jobs).where(eq(jobs.roomId, rid));
    await db.delete(rooms).where(eq(rooms.id, rid));
  }
  for (const aid of createdUserActorIds) {
    await db.delete(actors).where(eq(actors.id, aid));
  }
  for (const nid of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nid));
  }
  if (userId) await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

function setStub(
  responses: Array<{ type: "text"; content: string }>,
): ReturnType<typeof createStubProvider> {
  const provider = createStubProvider({ responses });
  __setStubModelForTests(provider.asChatModel());
  return provider;
}

/** Real room with the owner (kind='user' actor) + the agent as members so
 *  `last_in_namespace` resolves here and the wake reply persists under RLS. */
async function createCallingRoom(label: string): Promise<string> {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m145-${label}-${ts}` })
    .returning({ id: namespaces.id });
  createdNamespaceIds.push(ns!.id);

  const [userActor] = await db
    .insert(actors)
    .values({ ownerId: userId, kind: "user", displayName: "Owner", trustState: "verified" })
    .returning({ id: actors.id });
  createdUserActorIds.push(userActor!.id);

  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: userId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [userActor!.id],
  });
  createdRoomIds.push(roomId);
  await db.insert(roomMembers).values({ roomId, actorId: userActor!.id, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
  await ensureSession({
    threadId: `room:${roomId}:bot:${agentId}`,
    ownerId: userId,
    personaId: "owner",
    roomId,
    agentId,
  });
  return roomId;
}

function makeObserver(now?: () => Date): TaskObserver {
  return new TaskObserver({ db, jobManager, batch: 20, ...(now ? { now } : {}) });
}

function tool(roomId: string) {
  return createScheduleTool({
    ownerId: userId,
    agentId,
    roomId,
    userTimezone: TZ,
  });
}

async function pollRun(
  taskId: string,
  predicate: (runs: Awaited<ReturnType<typeof getTaskRuns>>) => boolean,
  timeoutMs = 25_000,
): Promise<Awaited<ReturnType<typeof getTaskRuns>>> {
  const start = Date.now();
  for (;;) {
    const runs = await getTaskRuns(db, taskId);
    if (predicate(runs)) return runs;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pollRun timeout for ${taskId}: ${JSON.stringify(runs.map((r) => r.status))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function pollRoomMessages(
  roomId: string,
  predicate: (contents: string[]) => boolean,
  timeoutMs = 25_000,
): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const { messages } = await getRoomMessagesAcrossMemberSessions({
      ownerId: userId,
      roomId,
      beforeCreatedAt: new Date(Date.now() + 60_000),
      beforeId: 2_147_483_647,
      limit: 200,
    });
    const contents = messages.map((m) => {
      if (m.content === null) throw new Error("seeded room message content unavailable");
      return m.content;
    });
    if (predicate(contents)) return contents;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollRoomMessages timeout for ${roomId}: ${JSON.stringify(contents)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(taskSuiteSkipReason !== null)(
  `M145 — schedule shortcut (stub graph, real PG)${
    taskSuiteSkipReason ? ` — ${taskSuiteSkipReason}` : ""
  }`,
  () => {
  test("S1: one-shot authored via tool → correct row shape, fires once + wakes the room, terminal", async () => {
    const roomId = await createCallingRoom("once");
    // One response for the task run, one for the woken reply turn.
    setStub([
      { type: "text", content: "SCHED_RUN_S1" },
      { type: "text", content: "SCHED_WAKE_S1" },
    ]);

    const at = new Date(Date.now() + 1_200).toISOString();
    const out: string = await tool(roomId).invoke({
      message: "remind me to drink water",
      when: { kind: "once", at },
    });
    const { taskId } = JSON.parse(out) as { taskId: string };
    expect(taskId).toBeTruthy();

    // Row shape (R5 + R2/R4).
    const authored = await getTaskById(db, taskId);
    expect(authored).toMatchObject({
      scheduleKind: "one_shot",
      preset: "schedule",
      targetChat: "last_in_namespace",
      resultDelivery: "wake",
      timezone: TZ,
      status: "pending",
    });
    expect(authored?.runAt?.toISOString()).toBe(at);
    expect(authored?.nextFireAt?.toISOString()).toBe(at);
    expect(authored?.cron).toBeNull();

    // Wait until due, then tick.
    await new Promise((r) => setTimeout(r, 1_300));
    const obs = makeObserver();
    await obs.tick();

    const runs = await pollRun(taskId, (rs) => rs.some((r) => r.status === "completed"));
    expect(runs.length).toBe(1);

    // The agent speaks the reminder unprompted in the calling room (wake reply).
    const contents = await pollRoomMessages(roomId, (c) =>
      c.some((x) => x.includes("SCHED_WAKE_S1")),
    );
    expect(contents.some((c) => c.includes("SCHED_WAKE_S1"))).toBe(true);

    // One-shot does not reschedule → terminal.
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("completed");

    await obs.stop();
  }, 60_000);

  test("S2: cron authored via tool → cron row in ctx tz; past-due (catch-up) fires once + reschedules forward", async () => {
    const roomId = await createCallingRoom("cron");
    // Over-provision the stub: one cron run + one wake reply, with headroom.
    setStub([
      { type: "text", content: "SCHED_RUN_S2" },
      { type: "text", content: "SCHED_WAKE_S2" },
      { type: "text", content: "SCHED_EXTRA_1" },
      { type: "text", content: "SCHED_EXTRA_2" },
    ]);

    const out: string = await tool(roomId).invoke({
      message: "stand up",
      when: { kind: "recurring", cron: "* * * * *" },
    });
    const { taskId } = JSON.parse(out) as { taskId: string };

    const authored = await getTaskById(db, taskId);
    expect(authored).toMatchObject({
      scheduleKind: "cron",
      cron: "* * * * *",
      preset: "schedule",
      timezone: TZ,
      status: "pending",
    });
    expect(authored?.runAt).toBeNull();
    // Freshly-authored cron's first occurrence is in the FUTURE.
    expect(authored!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());

    // Simulate downtime/catch-up (D8): back-date the first occurrence so the
    // next tick claims it. (A freshly-authored cron is never past-due, so this
    // is the only way to reach the catch-up branch from the scheduled row.)
    const pastDue = new Date(Date.now() - 5 * 60_000);
    await updateTask(db, taskId, { nextFireAt: pastDue });

    const tickNow = new Date();
    const obs = makeObserver(() => tickNow);
    await obs.tick();

    // Fires exactly once on the tick.
    const runs = await pollRun(
      taskId,
      (rs) =>
        rs.length >= 1 &&
        rs.every((r) => ["completed", "errored", "cancelled"].includes(r.status)),
    );
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("completed");

    // Rescheduled forward in the task's timezone; still pending; lock cleared.
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("pending");
    expect(task?.fireLockId).toBeNull();
    const expectedNext = nextCronOccurrence("* * * * *", TZ, tickNow);
    expect(task?.nextFireAt?.toISOString()).toBe(expectedNext.toISOString());
    expect(task!.nextFireAt!.getTime()).toBeGreaterThan(tickNow.getTime());

    await obs.stop();
    // Park the recurring row so a later tick can't re-claim it mid-suite.
    await markTaskCancelled(db, taskId);
  }, 60_000);

  test("S3: a past one-shot authored through the tool returns an error and persists NO row", async () => {
    const roomId = await createCallingRoom("past");
    const before = await db.select({ id: tasks.id }).from(tasks);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    const out: string = await tool(roomId).invoke({
      message: "remind me yesterday",
      when: { kind: "once", at: past },
    });
    expect(out).toContain("in the past");

    const after = await db.select({ id: tasks.id }).from(tasks);
    expect(after.length).toBe(before.length);
  });
  },
);
