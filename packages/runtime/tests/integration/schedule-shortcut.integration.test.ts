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
  users,
  serverAdmission,
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  sessionMessageDirectedRecipients,
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
import type { ServerEvent } from "@nautilo/types";
import {
  createAgentTurnTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
} from "../../src/tasks/task-creation-admission";

const TZ = "America/New_York";

let userId: string;
let agentId: string;
let agentActorId: string;
let userActorId: string;
let db: DirectDatabase;
let requesterHandle: string;

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
  await db.insert(serverAdmission).values({ userId, admitted: true });
  requesterHandle = `reminder_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.update(users).set({ handle: requesterHandle }).where(eq(users.id, userId));
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")))
    .limit(1);
  agentActorId = aa!.id;
  const [userActor] = await db
    .insert(actors)
    .values({ ownerId: userId, kind: "user", displayName: "Owner", trustState: "verified" })
    .returning({ id: actors.id });
  userActorId = userActor!.id;
  createdUserActorIds.push(userActorId);

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
        provenance: createAgentTurnTaskCreationProvenance({
          ownerId: input.requestorId,
          invocation: null,
        }),
        admission: getPlaintextTaskCreationAdmission(),
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
  responses: Parameters<typeof createStubProvider>[0]["responses"],
): ReturnType<typeof createStubProvider> {
  const provider = createStubProvider({ responses });
  __setStubModelForTests(provider.asChatModel());
  return provider;
}

/** Real room with the owner (kind='user' actor) + the agent as members so
 *  `last_in_namespace` resolves here and the wake reply persists under RLS. */
async function createCallingRoom(label: string, existingNamespaceId?: string): Promise<string> {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const namespaceId = existingNamespaceId ?? (await db
    .insert(namespaces)
    .values({ scope: "private", label: `m145-${label}-${ts}` })
    .returning({ id: namespaces.id }))[0]!.id;
  if (!existingNamespaceId) createdNamespaceIds.push(namespaceId);

  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: userId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId,
    humanActorIds: [userActorId],
  });
  createdRoomIds.push(roomId);
  await db.insert(roomMembers).values({ roomId, actorId: userActorId, roomRole: "admin" });
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
    causalHumanUserId: userId,
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
    const roomEvents: ServerEvent[] = [];
    const onRoomEvent = (event: ServerEvent) => {
      if ("laneKey" in event && event.laneKey === `room:${roomId}`) roomEvents.push(event);
    };
    eventBus.on(onRoomEvent);
    try {
      await obs.tick();

      const runs = await pollRun(taskId, (rs) => rs.some((r) => r.status === "completed"));
      expect(runs.length).toBe(1);

      // The agent speaks the reminder unprompted in the calling room (wake reply).
      const contents = await pollRoomMessages(roomId, (c) =>
        c.some((x) => x.includes("SCHED_WAKE_S1")),
      );
      expect(contents.filter((c) => c.includes("SCHED_WAKE_S1"))).toHaveLength(1);
      // When the execution Room is also the calling Room, its internal Task
      // transcript must not surface beside the wake, even over live events.
      expect(contents.filter((c) => c.includes("SCHED_RUN_S1"))).toHaveLength(0);
      expect(roomEvents.filter((event) => event.type === "message.new"
        && "content" in event && typeof event.content === "string"
        && event.content.includes("SCHED_RUN_S1"))).toHaveLength(0);
      expect(roomEvents.filter((event) => event.type === "message.tokens"
        && event.turnId === runs[0]?.id)).toHaveLength(0);

      // One-shot does not reschedule → terminal.
      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe("completed");
    } finally {
      eventBus.off(onRoomEvent);
      await obs.stop();
    }
  }, 60_000);

  test("saved reminder corrects a no-reply requester message and completes via wake", async () => {
    const roomId = await createCallingRoom("self-reminder");
    const provider = setStub([
      { type: "tool_call", name: "discover_tools", args: { query: "ask_peer" } },
      { type: "tool_call", name: "activate_tools", args: { names: ["ask_peer"], families: [] } },
      { type: "tool_call", name: "ask_peer", args: {
        peer_handle: requesterHandle,
        message_to_peer: "It is time to water the plants.",
        return_instructions: "Confirm delivery; no reply from the requester is necessary.",
        tools: [],
      } },
      { type: "tool_call", name: "ask_peer", args: {
        peer_handle: requesterHandle,
        message_to_peer: "Which plants need water?",
        return_instructions: "Wait for the requester's answer.",
        tools: [],
      } },
      { type: "tool_call", name: "ask_peer", args: {
        peer_handle: "someone_else",
        message_to_peer: "It is time to water the plants.",
        return_instructions: "No reply is needed.",
        tools: [],
      } },
      { type: "tool_call", name: "ask_peer", args: {
        peer_handle: requesterHandle,
        message_to_peer: "Here is the plan.",
        return_instructions: "No reply is needed.",
        artifact_ids: ["synthetic-artifact"],
        tools: [],
      } },
      { type: "text", content: "It is time to water the plants." },
      { type: "text", content: "Reminder: water the plants." },
    ]);
    const at = new Date(Date.now() + 1_200).toISOString();
    const out: string = await tool(roomId).invoke({
      message: "Remind me to water the plants",
      when: { kind: "once", at },
    });
    const { taskId } = JSON.parse(out) as { taskId: string };
    const saved = await getTaskById(db, taskId);
    expect(saved).toMatchObject({
      preset: "schedule", targetChat: "last_in_namespace", resultDelivery: "wake",
      toolsMode: "auto", callingRoomId: roomId,
    });
    const [callingRoom] = await db.select({ namespaceId: rooms.namespaceId })
      .from(rooms).where(eq(rooms.id, roomId)).limit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const executionRoomId = await createCallingRoom("reminder-execution", callingRoom!.namespaceId);

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const observer = makeObserver();
    try {
      await observer.tick();
      const runs = await pollRun(taskId, (rows) => rows.some((row) => row.status === "completed"));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.resultText).toContain("It is time to water the plants.");
      expect((await getTaskById(db, taskId))?.targetRoomId).toBe(executionRoomId);
      expect(executionRoomId).not.toBe(roomId);
      const contents = await pollRoomMessages(roomId,
        (rows) => rows.some((content) => content.includes("Reminder: water the plants.")));
      expect(contents.filter((content) => content.includes("Reminder: water the plants."))).toHaveLength(1);
      const { messages } = await getRoomMessagesAcrossMemberSessions({
        ownerId: userId, roomId, beforeCreatedAt: new Date(Date.now() + 60_000),
        beforeId: 2_147_483_647, limit: 200,
      });
      const reminder = messages.find((message) => message.content?.includes("Reminder: water the plants."));
      expect(reminder).toBeDefined();
      const reminderMessageId = Number(reminder!.id);
      expect(Number.isSafeInteger(reminderMessageId)).toBe(true);
      const directed = await db.select({ recipientId: sessionMessageDirectedRecipients.recipientId,
        reason: sessionMessageDirectedRecipients.reason })
        .from(sessionMessageDirectedRecipients)
        .where(eq(sessionMessageDirectedRecipients.messageId, reminderMessageId));
      expect(directed).toContainEqual({ recipientId: userId, reason: "direct_room" });
      expect(provider.invocations.some(({ messages }) => messages.some((message) =>
        typeof message.content === "string" && message.content.includes("No separate message was sent"),
      ))).toBe(true);
      for (const invocationIndex of [4, 5, 6]) {
        const feedback = provider.invocations[invocationIndex]?.messages.at(-1)?.content;
        expect(typeof feedback === "string" && feedback.includes("No separate message was sent")).toBe(false);
      }
      expect(provider.invocations.some(({ messages }) => messages.some((message) =>
        typeof message.content === "string" && message.content.includes("Your final answer is returned automatically"),
      ))).toBe(true);
      const peerTasks = await db.select({ prompt: tasks.prompt }).from(tasks).where(eq(tasks.preset, "ask_peer"));
      // The redundant delivery created none; the legitimate follow-up and
      // different-recipient calls still take the ordinary peer Task path.
      expect(peerTasks).toHaveLength(2);
      expect(peerTasks.some((task) => task.prompt.includes("Which plants need water?"))).toBe(true);
      expect(peerTasks.some((task) => task.prompt.includes("@someone_else"))).toBe(true);
      expect(peerTasks.some((task) => task.prompt.includes(`@${requesterHandle}`)
        && task.prompt.includes('"It is time to water the plants."'))).toBe(false);
      expect(provider.remaining).toBe(0);
    } finally {
      await observer.stop();
    }
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
