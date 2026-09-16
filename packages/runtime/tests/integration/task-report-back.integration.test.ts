/**
 * M143 — report-back finalizer + minimal `task` tool against real Postgres + a
 * stub graph. Covers the blast-radius gaps the unit tests can't reach:
 *
 *  - S1 wake delivery: a completed task with a `calling_room_id` wakes the
 *    room — a hidden `originatedBy='task'` synthetic input row is persisted AND
 *    a fresh agent reply turn lands; the synthetic row is excluded from
 *    `getRoomMessagesAcrossMemberSessions` while the reply renders.
 *  - S4 raw delivery: `result_delivery='raw'` posts the result text directly as
 *    the agent's assistant message, with NO extra LLM turn.
 *  - S8 error path: a failing run → `markTaskErrored` + `task.errored`, terminal
 *    status (never stuck `running`).
 *  - S6 owner-only: the `task` tool's `read`/`list` only ever surface the
 *    caller's own tasks.
 *
 * No API keys: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  actors,
  groupMembers,
  groups,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  jobs,
  taskRuns,
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  eq,
  and,
  inArray,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import {
  createAcceptedInvocationAuthority,
  findActorByOwnerId,
  initPolicyResolver,
  getPolicyResolver,
  PersonalPolicyResolver,
} from "@nautilo/trust";
import {
  __setStubModelForTests,
  createNautiloGraph, createCheckpointSaver, defaultPostModelDeps,
  setAgentEventSink,
  appendTranscriptMessages,
  ensureSession,
  getRoomMessagesAcrossMemberSessions,
  setTaskToolRuntime,
  createTaskTool,
} from "@nautilo/agent";
import { SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import { unpauseTask } from "../../src/tasks/lifecycle";
import { resumeSecurityResearchRun } from "../../src/tasks/security-report-recovery";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  createTask as runtimeCreateTask,
  computeNextFireAt as runtimeComputeNextFireAt,
} from "../../src/tasks/create-task";
import {
  setTaskRunDb,
  setTaskRunJobManager,
} from "../../src/tasks/task-runtime-context";
import { reportBackTaskCompletion, reportBackTaskError, SAFE_BACKGROUND_TASK_FAILURE_RESULT, SAFE_DELEGATED_TASK_FAILURE_RESULT } from "../../src/tasks/report-back";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
  createTestUser,
  taskTablesCleanStatus,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createIntegrationStubPolicyResolver } from "./integration-stub-policy";
import { createStubProvider } from "./helpers/stub-provider";

let userId: string;
let agentId: string;
let agentActorId: string;
let humanActorId: string;
let db: DirectDatabase;

const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const extraUserIds: string[] = [];

await setupTestDb();
db = getDirectDb();
const taskTableStatus = await taskTablesCleanStatus(db);
const taskSuiteSkipReason = taskTableStatus.clean
  ? null
  : taskTableStatus.reason;
if (taskSuiteSkipReason) {
  console.warn(`Skipping task-report-back integration suite: ${taskSuiteSkipReason}`);
  await closeDirectDb();
}

beforeAll(async () => {
  if (taskSuiteSkipReason) return;
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("task-reportback");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  // The agent-actor mirror seeded by setupAgentTestEnv (kind='agent').
  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")))
    .limit(1);
  agentActorId = aa!.id;
  const existingHumanActor = await findActorByOwnerId(userId);
  if (existingHumanActor) {
    humanActorId = existingHumanActor.id;
  } else {
    const [createdHumanActor] = await db
      .insert(actors)
      .values({
        ownerId: userId,
        kind: "user",
        displayName: "Owner",
        trustState: "verified",
      })
      .returning({ id: actors.id });
    if (!createdHumanActor) throw new Error("canonical human actor insert failed");
    humanActorId = createdHumanActor.id;
  }
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("canonical owners group missing");
  await db.insert(groupMembers).values({
    groupId: ownersGroup.id,
    userId,
    grantedBy: agentActorId,
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

  // Clean up rooms/sessions/members/namespaces we created, then the users
  // (tasks/task_runs cascade off the owner delete).
  for (const rid of createdRoomIds) {
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
    const ids = sess.map((s) => s.id);
    if (ids.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await db.delete(sessions).where(inArray(sessions.id, ids));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
    // The wake foreground turn creates a `jobs` row referencing the room.
    await db.delete(jobs).where(eq(jobs.roomId, rid));
    await db.delete(rooms).where(eq(rooms.id, rid));
  }
  for (const nid of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nid));
  }
  if (userId) await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  if (userId) await cleanupTestUser(userId);
  for (const uid of extraUserIds) await cleanupTestUser(uid);
  await closeDirectDb();
  await closeAgentDb();
});

/** Script the global stub model; returns the provider for `remaining` asserts. */
function setStub(
  responses: Array<
    | { type: "text"; content: string }
    | { type: "error"; error: Error }
  >,
): ReturnType<typeof createStubProvider> {
  const provider = createStubProvider({ responses });
  __setStubModelForTests(provider.asChatModel());
  return provider;
}

/** Real room with the owner (kind='user' actor) + the agent as members, so
 *  transcript reads + RLS-scoped persistence work. */
async function createCallingRoom(label: string): Promise<string> {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m143-${label}-${ts}` })
    .returning({ id: namespaces.id });
  createdNamespaceIds.push(ns!.id);

  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: userId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [humanActorId],
  });
  createdRoomIds.push(roomId);
  await db.insert(roomMembers).values({ roomId, actorId: humanActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
  // Strict DMs use the Room's canonical graph thread. Pre-create that exact
  // session so report-back cannot accidentally pass by writing/waking the
  // group-only `:bot:<agentId>` partition instead.
  await ensureSession({
    threadId: `room:${roomId}`,
    ownerId: userId,
    personaId: "owner",
    roomId,
    agentId,
  });
  return roomId;
}

function makeObserver(): TaskObserver {
  return new TaskObserver({ db, jobManager, batch: 20 });
}

async function insertNowTask(args: {
  prompt: string;
  callingRoomId?: string | null;
  resultDelivery?: "wake" | "raw" | "raw_and_wake";
}): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: args.prompt,
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "none",
    callingRoomId: args.callingRoomId ?? null,
    resultDelivery: args.resultDelivery ?? "wake",
    nextFireAt: new Date(),
    status: "pending",
  });
  return row.id;
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
      throw new Error(`pollRun timeout for ${taskId}: ${JSON.stringify(runs.map((r) => r.status))}`);
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
      // session_messages.id is int4 — use its max, not Number.MAX_SAFE_INTEGER.
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
  `M143 — report-back (stub graph, real PG)${
    taskSuiteSkipReason ? ` — ${taskSuiteSkipReason}` : ""
  }`,
  () => {
  test("S1: wake delivery — hidden synthetic row + fresh agent reply turn", async () => {
    const roomId = await createCallingRoom("wake");
    // One response for the task run, one for the woken reply turn.
    setStub([
      { type: "text", content: "TASK_RUN_RESULT_S1" },
      { type: "text", content: "WAKE_REPLY_S1" },
      { type: "text", content: "WAKE_REPLY_S1" },
      { type: "text", content: "WAKE_REPLY_S1" },
    ]);
    const taskId = await insertNowTask({ prompt: "do S1", callingRoomId: roomId, resultDelivery: "wake" });

    const obs = makeObserver();
    await obs.tick();
    await pollRun(taskId, (rs) => rs.some((r) => r.status === "completed"));

    // The woken agent reply renders; the synthetic [TASK RESULT …] row does NOT.
    const contents = await pollRoomMessages(roomId, (c) => c.some((x) => x.includes("WAKE_REPLY_S1")));
    expect(contents.some((c) => c.includes("WAKE_REPLY_S1"))).toBe(true);
    expect(contents.some((c) => c.includes("TASK RESULT"))).toBe(false);
    expect(contents.some((c) => c.includes("TASK_RUN_RESULT_S1"))).toBe(false);

    // The synthetic row exists in the DB, tagged originatedBy='task' (production
    // path: langgraph-executor applied metadata to the human input row only).
    const synthetic = await db.execute(sql`
      SELECT sm.metadata->>'originatedBy' AS origin
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE s.room_id = ${roomId} AND sm.content LIKE '[TASK RESULT%'
    `);
    const rows = synthetic as unknown as Array<{ origin: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.origin).toBe("task");

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("completed");
    await obs.stop();
  }, 60_000);

  test("M144: two task wakes on the SAME room do NOT coalesce — each gets its own reply", async () => {
    const roomId = await createCallingRoom("twowake");
    // 2 task-run turns (hidden, each on its own subagent thread) + 2 wake reply
    // turns (rendered in the calling room). All identical so the assertion is
    // robust to model-call ordering: run-result turns persist to hidden NULL-
    // session subagent threads (never the calling room), so only the two wake
    // replies surface in the room.
    // DISTINCT reply markers: the two run-result turns invoke first (hidden on
    // their own subagent threads), then the two wake turns. Distinct content
    // avoids the persist-layer fingerprint dedup (identical sibling messages on
    // one thread collapse to a single row) so two real wake turns yield two
    // distinct visible replies. Over-provisioned so exhaustion is never a cause.
    setStub([
      { type: "text", content: "RUN_RESULT_1" },
      { type: "text", content: "RUN_RESULT_2" },
      { type: "text", content: "WAKE_REPLY_A" },
      { type: "text", content: "WAKE_REPLY_B" },
      { type: "text", content: "WAKE_REPLY_C" },
      { type: "text", content: "WAKE_REPLY_D" },
    ]);
    const taskA = await insertNowTask({ prompt: "wake A", callingRoomId: roomId, resultDelivery: "wake" });
    const taskB = await insertNowTask({ prompt: "wake B", callingRoomId: roomId, resultDelivery: "wake" });

    const obs = makeObserver();
    await obs.tick();
    await pollRun(taskA, (rs) => rs.some((r) => r.status === "completed"));
    await pollRun(taskB, (rs) => rs.some((r) => r.status === "completed"));

    // Both wakes must render as SEPARATE agent replies (two distinct WAKE_REPLY_*
    // rows). Pre-fix the two wakes coalesced on the room lane into ONE turn → one
    // reply; the fork variant leaked the synthetic row. Now each runs as its own
    // sequential main turn.
    const contents = await pollRoomMessages(
      roomId,
      (c) => c.filter((x) => x.includes("WAKE_REPLY_")).length >= 2,
    );
    const replies = contents.filter((x) => x.includes("WAKE_REPLY_"));
    expect(replies.length).toBe(2);
    // Two DISTINCT turns (not one row, not a deduped duplicate).
    expect(new Set(replies).size).toBe(2);
    // Run-result text stays on the hidden subagent threads, never the room.
    expect(contents.some((c) => c.includes("RUN_RESULT"))).toBe(false);
    // Both synthetic [TASK RESULT …] human rows stay hidden from the room render.
    expect(contents.some((c) => c.includes("TASK RESULT"))).toBe(false);

    const a = await getTaskById(db, taskA);
    const b = await getTaskById(db, taskB);
    expect(a?.status).toBe("completed");
    expect(b?.status).toBe("completed");
    await obs.stop();
  }, 60_000);

  test("S4: raw delivery — direct assistant post, no extra LLM turn", async () => {
    const roomId = await createCallingRoom("raw");
    const provider = setStub([{ type: "text", content: "RAW_RESULT_S4" }]);
    const taskId = await insertNowTask({ prompt: "do S4", callingRoomId: roomId, resultDelivery: "raw" });

    const obs = makeObserver();
    await obs.tick();
    await pollRun(taskId, (rs) => rs.some((r) => r.status === "completed"));

    const contents = await pollRoomMessages(roomId, (c) => c.some((x) => x.includes("RAW_RESULT_S4")));
    expect(contents.some((c) => c.includes("RAW_RESULT_S4"))).toBe(true);
    // No synthetic wake row, and no extra model turn was consumed (raw = direct post).
    expect(contents.some((c) => c.includes("TASK RESULT"))).toBe(false);
    expect(provider.remaining).toBe(0);

    await obs.stop();
  }, 60_000);

  test("raw_and_wake posts one visible result before one authorized continuation", async () => {
    const roomId = await createCallingRoom("raw-and-wake");
    const provider = setStub([
      { type: "text", content: "COMBINED_RESULT" },
      { type: "text", content: "COMBINED_CONTINUATION" },
      { type: "text", content: "COMBINED_CONTINUATION" },
    ]);
    const taskId = await insertNowTask({
      prompt: "do combined delivery",
      callingRoomId: roomId,
      resultDelivery: "raw_and_wake",
    });

    const obs = makeObserver();
    await obs.tick();
    const runs = await pollRun(taskId, (rows) =>
      rows.some((row) => row.status === "completed"));
    const run = runs.find((row) => row.status === "completed");
    if (!run) throw new Error("completed task run missing");

    const rendered = await pollRoomMessages(roomId, (contents) =>
      contents.some((content) => content.includes("COMBINED_RESULT"))
      && contents.some((content) => content.includes("COMBINED_CONTINUATION")));
    expect(rendered.filter((content) => content.includes("COMBINED_RESULT"))).toHaveLength(1);
    expect(rendered.filter((content) => content.includes("COMBINED_CONTINUATION"))).toHaveLength(1);
    expect(rendered.some((content) => content.includes("[TASK RESULT"))).toBe(false);
    expect(rendered.some((content) => content.includes("full transcript for parent model")))
      .toBe(false);

    const roomSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, roomId));
    const transcript = await db
      .select({
        id: sessionMessages.id,
        threadId: sessions.threadId,
        role: sessionMessages.role,
        content: sessionMessages.content,
        metadata: sessionMessages.metadata,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(inArray(sessionMessages.sessionId, roomSessions.map((session) => session.id)))
      .orderBy(sessionMessages.id);
    const rawIndex = transcript.findIndex((row) => {
      if (row.content === null) throw new Error("seeded transcript content unavailable");
      return row.content.includes("COMBINED_RESULT");
    });
    const controlIndex = transcript.findIndex((row) =>
      row.metadata?.["originatedBy"] === "task");
    const continuationIndex = transcript.findIndex((row) => {
      if (row.content === null) throw new Error("seeded transcript content unavailable");
      return row.content.includes("COMBINED_CONTINUATION");
    });
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    expect(controlIndex).toBeGreaterThan(rawIndex);
    expect(continuationIndex).toBeGreaterThan(controlIndex);
    expect(transcript[controlIndex]?.content).not.toContain("COMBINED_RESULT");
    expect(transcript[rawIndex]?.threadId).toBe(`room:${roomId}`);
    expect(transcript[controlIndex]?.threadId).toBe(`room:${roomId}`);
    expect(transcript[continuationIndex]?.threadId).toBe(`room:${roomId}`);
    expect(transcript.some((row) => row.threadId.includes(":bot:"))).toBe(false);

    const wakeInvocation = provider.invocations.at(-1);
    if (!wakeInvocation) throw new Error("wake provider invocation missing");
    const wakeInput = wakeInvocation.messages
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    expect(wakeInput.match(/COMBINED_RESULT/g)).toHaveLength(1);
    expect(wakeInput).not.toContain("full transcript for parent model");

    await reportBackTaskCompletion(
      { db },
      {
        taskId,
        runId: run.id,
        scheduleKind: "now",
        resultText: "COMBINED_RESULT",
      },
    );
    const afterRetry = await db
      .select({ content: sessionMessages.content, metadata: sessionMessages.metadata })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, roomSessions.map((session) => session.id)));
    expect(afterRetry.filter((row) => {
      if (row.content === null) throw new Error("seeded retry content unavailable");
      return row.content.includes("COMBINED_RESULT");
    })).toHaveLength(1);
    expect(afterRetry.filter((row) =>
      row.metadata?.["originatedBy"] === "task"))
      .toHaveLength(1);
    expect(afterRetry.filter((row) => {
      if (row.content === null) throw new Error("seeded retry content unavailable");
      return row.content.includes("COMBINED_CONTINUATION");
    }))
      .toHaveLength(1);
    await obs.stop();
  }, 60_000);

  test("group report-back keeps the per-Agent bot checkpoint", async () => {
    const roomId = await createCallingRoom("raw-and-wake-group");
    const { userId: peerUserId } = await createTestUser("m286-group-peer");
    extraUserIds.push(peerUserId);
    const [peerActor] = await db
      .insert(actors)
      .values({
        ownerId: peerUserId,
        kind: "user",
        displayName: "Peer",
        trustState: "verified",
      })
      .returning({ id: actors.id });
    if (!peerActor) throw new Error("group peer actor insert failed");
    await db.insert(roomMembers).values({
      roomId,
      actorId: peerActor.id,
      roomRole: "member",
    });
    const botThread = `room:${roomId}:bot:${agentId}`;
    await ensureSession({
      threadId: botThread,
      ownerId: userId,
      personaId: "owner",
      roomId,
      agentId,
    });
    setStub([
      { type: "text", content: "GROUP_RESULT" },
      { type: "text", content: "GROUP_CONTINUATION" },
      { type: "text", content: "GROUP_CONTINUATION" },
    ]);
    const taskId = await insertNowTask({
      prompt: "do group combined delivery",
      callingRoomId: roomId,
      resultDelivery: "raw_and_wake",
    });

    const obs = makeObserver();
    await obs.tick();
    await pollRun(taskId, (rows) => rows.some((row) => row.status === "completed"));
    await pollRoomMessages(roomId, (contents) =>
      contents.some((content) => content.includes("GROUP_RESULT"))
      && contents.some((content) => content.includes("GROUP_CONTINUATION")));

    const rows = await db
      .select({ threadId: sessions.threadId, content: sessionMessages.content })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(and(
        eq(sessions.roomId, roomId),
        sql`${sessionMessages.content} LIKE ${"%GROUP_%"}`,
      ));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.threadId === botThread)).toBe(true);
    await obs.stop();
  }, 60_000);

  test("report-back resolves the owner's human actor before building the wake envelope", async () => {
    const roomId = await createCallingRoom("wake-authority");
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "resume with owner authority",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "wake",
      status: "running",
    });
    const [run] = await db.insert(taskRuns).values({
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    const humanActor = await findActorByOwnerId(userId);
    if (!humanActor) throw new Error("human actor missing");
    const calls: Array<readonly unknown[]> = [];
    const capturingManager = {
      createSystemForegroundJob: async (...args: unknown[]) => {
        calls.push(args);
        return { id: "authority-wake", virtualJobId: "authority-wake" };
      },
    } as unknown as typeof jobManager;

    initPolicyResolver(new PersonalPolicyResolver(userId, agentId));
    setTaskRunJobManager(capturingManager);
    try {
      await reportBackTaskCompletion(
        { db },
        {
          taskId: task.id,
          runId: run!.id,
          scheduleKind: "now",
          resultText: "AUTHORIZED_RESULT",
        },
      );
    } finally {
      setTaskRunJobManager(jobManager);
      initPolicyResolver(createIntegrationStubPolicyResolver(userId));
    }

    expect(calls).toHaveLength(1);
    const input = calls[0]?.[3] as {
      voiceMode: boolean;
      memoryAccessEnvelope: {
        actorId: string;
        ownerId: string;
        toolPolicy: Record<string, string>;
      };
    };
    expect(input.voiceMode).toBe(false);
    expect(input.memoryAccessEnvelope.actorId).toBe(humanActor.id);
    expect(input.memoryAccessEnvelope.actorId).not.toBe(userId);
    expect(input.memoryAccessEnvelope.ownerId).toBe(userId);
    expect(input.memoryAccessEnvelope.toolPolicy["run_shell"]).not.toBe("forbidden");
  }, 60_000);

  test("ask_peer report-back is TTS-eligible without captured client voice state", async () => {
    const roomId = await createCallingRoom("ask-peer-voice-wake");
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "ask Elias and report back aloud",
      preset: "ask_peer",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "wake",
      status: "running",
    });
    const [run] = await db.insert(taskRuns).values({
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    const calls: Array<readonly unknown[]> = [];
    const capturingManager = {
      createSystemForegroundJob: async (...args: unknown[]) => {
        calls.push(args);
        return { id: "voice-wake", virtualJobId: "voice-wake" };
      },
    } as unknown as typeof jobManager;

    setTaskRunJobManager(capturingManager);
    try {
      await reportBackTaskCompletion(
        { db },
        {
          taskId: task.id,
          runId: run!.id,
          scheduleKind: "now",
          resultText: "ELIAS_FEEDBACK",
        },
      );
    } finally {
      setTaskRunJobManager(jobManager);
    }

    expect(calls).toHaveLength(1);
    const input = calls[0]?.[3] as { voiceMode: boolean };
    expect(input.voiceMode).toBe(true);
  }, 60_000);

  test("same-run research failure and recovered report both persist once under raw delivery and combined wake", async () => {
    for (const resultDelivery of ["raw", "raw_and_wake"] as const) {
      const roomId = await createCallingRoom(`recovered-${resultDelivery}`);
      const modelId = "openai:gpt-5.5-2026-04-23";
      const task = await dbCreateTask(db, { ownerId: userId, requestorId: userId, agentId, prompt: "Complete the saved audit.",
        scheduleKind: "now", targetChat: "orphan", callingRoomId: roomId, resultDelivery,
        toolsMode: "whitelist", toolsWhitelist: ["security_scan", "file"], status: "running" });
      const threadId = `subagent:recovered-report:${randomUUID()}`;
      const [run] = await db.insert(taskRuns).values({ taskId: task.id, graphThreadId: threadId, status: "running", modelId }).returning();
      if (!run) throw Error("missing research Run");
      const graph = createNautiloGraph(createCheckpointSaver(), getPolicyResolver(), defaultPostModelDeps);
      const config = { configurable: { thread_id: threadId } };
      await graph.updateState(config, { subagentRun: true, taskRun: true, trustedExecutionEntrypoint: "background.task",
        userId, agentId, currentTaskId: task.id, currentTaskRunId: run.id, langgraphThreadId: threadId, model: modelId,
        toolWhitelist: ["security_scan", "file"], taskReportBackContinuation: { status: "available", relayId: "saved-relay",
          relaySessionId: "saved-socket", desktopSessionId: "saved-desktop", pairingGeneration: "saved-pair", currentFolder: "/authorized", workspacePath: "/workspace" },
        noProgressPendingStop: { toolName: "security_scan", operationDiscriminator: "context",
          normalizedError: JSON.stringify({ code: "context_budget_unavailable", message: "Local framing failed.", retryable: false }) },
        messages: [new AIMessage({ content: "", tool_calls: [{ id: "status", name: "security_scan", args: { operation: "status" } }] }),
          new ToolMessage({ name: "security_scan", tool_call_id: "status", content: JSON.stringify({ ok: true, operation: "status", result: {
            version: "security-scan-v1", scanId: "scan_saved", state: "active", phase: "researching", terminalState: null,
            mode: "deep_research", modelId, modelState: "running", completedSteps: 1, totalSteps: 2,
            lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] } }) })] });
      const readRows = () => db.select({ content: sessionMessages.content, fingerprint: sessionMessages.fingerprint })
        .from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, roomId)).orderBy(sessionMessages.id);
      const wakes: string[] = [];
      const deps = { db, wake: async (_task: unknown, _id: string, text: string) => {
        // Combined delivery must persist the correct outcome before claiming it is visible.
        expect((await readRows()).at(-1)?.content).toBe(text); wakes.push(text);
      } };
      await reportBackTaskError(deps, { taskId: task.id, runId: run.id, scheduleKind: "now", error: "no_progress",
        failureResultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT });
      expect((await readRows()).map((row) => row.content)).toEqual([SAFE_BACKGROUND_TASK_FAILURE_RESULT]);
      expect((await unpauseTask({ db, jobManager: { abortJob: () => false }, observer: { kick: () => {} } }, task.id)).ok).toBe(true);
      expect(await resumeSecurityResearchRun(db, { taskId: task.id, taskRunId: run.id, ownerId: userId,
        threadId, modelId, deliveryOnly: false })).toMatchObject({ id: run.id, status: "running" });
      const report = "# Complete recovered report\n\nSource-backed finding, counterevidence and explicit coverage limitations.\n";
      const completion = { taskId: task.id, runId: run.id, scheduleKind: "now", resultText: report, requireRunningPair: true };
      expect(await reportBackTaskCompletion(deps, completion)).toBe(true);
      expect(await reportBackTaskCompletion(deps, completion)).toBe(true);
      const rows = await readRows();
      expect(rows.map((row) => row.content)).toEqual([SAFE_BACKGROUND_TASK_FAILURE_RESULT, report]);
      expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(2);
      expect(wakes).toEqual(resultDelivery === "raw_and_wake" ? [SAFE_BACKGROUND_TASK_FAILURE_RESULT, report] : []);
      expect(await getTaskRuns(db, task.id)).toHaveLength(1);
    }
  });

  test("stable raw completion persists resultText, dedupes retry, and suppresses Stop", async () => {
    const roomId = await createCallingRoom("stable-raw");
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "Codex canonical result",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "raw",
      status: "running",
    });
    const [run] = await db.insert(taskRuns).values({
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    const completion = {
      taskId: task.id,
      runId: run!.id,
      scheduleKind: "now",
      resultText: "CODEX_CANONICAL_RESULT",
    } as const;
    let appendAttempts = 0;
    const flakyAppend = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error("transient transcript failure");
      return appendTranscriptMessages(...args);
    }) as typeof appendTranscriptMessages;
    const completionEvents: ServerEvent[] = [];

    let firstFailure: unknown;
    try {
      await reportBackTaskCompletion(
        { db, append: flakyAppend, emit: (event) => completionEvents.push(event) },
        completion,
      );
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({ message: "transient transcript failure" });
    await reportBackTaskCompletion(
      { db, append: flakyAppend, emit: (event) => completionEvents.push(event) },
      completion,
    );
    await reportBackTaskCompletion(
      { db, append: flakyAppend, emit: (event) => completionEvents.push(event) },
      completion,
    );
    await reportBackTaskCompletion(
      { db, append: flakyAppend, emit: (event) => completionEvents.push(event) },
      { ...completion, resultText: "CONFLICTING_CODEX_RESULT" },
    );

    const completedRuns = await getTaskRuns(db, task.id);
    expect(completedRuns[0]).toMatchObject({
      status: "completed",
      resultText: "CODEX_CANONICAL_RESULT",
    });
    const roomSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, roomId));
    const completedMessages = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, roomSessions.map((session) => session.id)));
    expect(completedMessages.filter(({ content }) => content === "CODEX_CANONICAL_RESULT"))
      .toHaveLength(1);
    expect(completedMessages.map(({ content }) => content)).not.toContain("CONFLICTING_CODEX_RESULT");
    expect(completionEvents.filter((event) => event.type === "message.new")).toHaveLength(1);
    expect(completionEvents.filter((event) => event.type === "task.completed")).toHaveLength(1);

    const stopped = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "Stopped Codex result",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "raw",
      status: "cancelled",
    });
    const [stoppedRun] = await db.insert(taskRuns).values({
      taskId: stopped.id,
      graphThreadId: `subagent:task:${stopped.id}`,
      status: "cancelled",
    }).returning({ id: taskRuns.id });
    await reportBackTaskCompletion(
      { db },
      {
        taskId: stopped.id,
        runId: stoppedRun!.id,
        scheduleKind: "now",
        resultText: "STOPPED_CODEX_RESULT_MUST_NOT_RENDER",
      },
    );
    const afterStop = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, roomSessions.map((session) => session.id)));
    expect(afterStop.map(({ content }) => content))
      .not.toContain("STOPPED_CODEX_RESULT_MUST_NOT_RENDER");

    const persistent = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "Persistent delivery failure",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "raw",
      status: "running",
    });
    const [persistentRun] = await db.insert(taskRuns).values({
      taskId: persistent.id,
      graphThreadId: `subagent:task:${persistent.id}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    const alwaysFail = (async () => {
      throw new Error("persistent transcript failure");
    }) as typeof appendTranscriptMessages;
    let persistentFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await reportBackTaskCompletion(
          { db, append: alwaysFail },
          {
            taskId: persistent.id,
            runId: persistentRun!.id,
            scheduleKind: "now",
            resultText: "PERSISTENT_CODEX_RESULT",
          },
        );
      } catch (error) {
        persistentFailure = error;
      }
    }
    await reportBackTaskError(
      { db },
      {
        taskId: persistent.id,
        runId: persistentRun!.id,
        scheduleKind: "now",
        error: "CODEX_EXECUTION_FAILED",
      },
    );
    expect(persistentFailure).toMatchObject({ message: "persistent transcript failure" });
    expect(await getTaskById(db, persistent.id)).toMatchObject({ status: "completed" });
    expect((await getTaskRuns(db, persistent.id))[0]).toMatchObject({
      status: "completed",
      resultText: "PERSISTENT_CODEX_RESULT",
    });
  }, 60_000);

  test("S8: error path — task.errored + terminal status (not stuck running)", async () => {
    setStub([{ type: "error", error: new Error("stub run failure S8") }]);
    const taskId = await insertNowTask({ prompt: "do S8", callingRoomId: null });

    const errored: ServerEvent[] = [];
    const handler = (e: ServerEvent) => {
      if (e.type === "task.errored" && e.taskId === taskId) errored.push(e);
    };
    eventBus.on(handler);

    const obs = makeObserver();
    await obs.tick();
    await pollRun(taskId, (rs) => rs.some((r) => ["errored", "completed"].includes(r.status)));

    const runs = await getTaskRuns(db, taskId);
    expect(runs[0]?.status).toBe("errored");
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(["pending", "running"]).not.toContain(task?.status);
    expect(errored.length).toBeGreaterThanOrEqual(1);
    expect(errored[0]).toMatchObject({ taskId, ownerId: userId });

    eventBus.off(handler);
    await obs.stop();
  });

  test("ACP raw_and_wake error retries wake without duplicating the visible receipt", async () => {
    const roomId = await createCallingRoom("acp-failure-wake");
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "delegated task",
      scheduleKind: "now",
      targetChat: "orphan",
      toolsMode: "none",
      callingRoomId: roomId,
      resultDelivery: "raw_and_wake",
      status: "running",
    });
    const [run] = await db.insert(taskRuns).values({
      taskId: task.id,
      graphThreadId: `subagent:task:${task.id}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    const calls: Array<readonly unknown[]> = [];
    const failingOnceManager = {
      createSystemForegroundJob: async (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw new Error("transient wake delivery failure");
        return { id: "wake-job", virtualJobId: "wake-job" };
      },
    } as unknown as typeof jobManager;
    const args = {
      taskId: task.id,
      runId: run!.id,
      scheduleKind: "now",
      error: "ACP_EXECUTION_FAILED",
      failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
    } as const;
    setTaskRunJobManager(failingOnceManager);
    try {
      let deliveryFailure: unknown;
      try { await reportBackTaskError({ db }, args); } catch (error) { deliveryFailure = error; }
      expect(deliveryFailure).toMatchObject({ message: "transient wake delivery failure" });
      await reportBackTaskError({ db }, args);
      // A later duplicate callback has no in-process failed-enqueue marker and
      // therefore cannot admit a second foreground wake.
      await reportBackTaskError({ db }, args);
    } finally {
      setTaskRunJobManager(jobManager);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.[2]).toBe(`room:${roomId}`);
    const wakeInput = calls[1]?.[3] as { message: string; metadata: unknown } | undefined;
    expect(wakeInput?.message).toContain("[TASK FAILURE");
    expect(wakeInput?.message).not.toContain(SAFE_DELEGATED_TASK_FAILURE_RESULT);
    expect(wakeInput?.message).toContain("immediately preceding assistant message");
    expect(wakeInput?.message).toContain(JSON.stringify({ command: "read", taskId: task.id, runId: run!.id, readSection: "transcript" }));
    expect(wakeInput?.message).toContain("saved work is unverified rather than absent");
    expect(wakeInput?.message).toContain("Inspection does not authorize restarting the Task");
    expect(wakeInput?.metadata).toEqual({ originatedBy: "task", taskId: task.id, taskRunId: run!.id });
    const roomSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, roomId));
    const receipts = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, roomSessions.map((session) => session.id)));
    expect(receipts.filter((row) => row.content === SAFE_DELEGATED_TASK_FAILURE_RESULT))
      .toHaveLength(1);
    expect(await getTaskById(db, task.id)).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
    expect((await getTaskRuns(db, task.id))[0]).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
  });

  test("S6: task tool read/list are strictly owner-only", async () => {
    // Inject the tool runtime with a no-op observer so `create` only inserts
    // (no dispatch / graph turn) — this test is about owner scoping, not runs.
    setTaskToolRuntime({
      db,
      createTask: (input) =>
        runtimeCreateTask(
          {
            db,
            observer: { kick: () => {} },
            invocationAuthority: createAcceptedInvocationAuthority(input.requestorId),
          },
          input,
        ),
      computeNextFireAt: runtimeComputeNextFireAt,
      // M147 — lifecycle not exercised here; satisfy the DI contract.
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });

    const { userId: otherUserId } = await createTestUser("m143-other");
    extraUserIds.push(otherUserId);

    // The tool reads ownerId/agentId/roomId from its factory closure, so build
    // one tool per caller identity (exactly how the catalog instantiates it).
    const ownerTool = createTaskTool({ ownerId: userId, agentId, roomId: "" });
    const otherTool = createTaskTool({ ownerId: otherUserId, agentId, roomId: "" });

    const createOut: string = await ownerTool.invoke({ command: "create", prompt: "owner-only S6 task" });
    const { taskId } = JSON.parse(createOut) as { taskId: string };
    expect(taskId).toBeTruthy();

    // Non-owner read → "Task not found." (owner-only, no leak).
    const otherRead: string = await otherTool.invoke({ command: "read", taskId });
    expect(otherRead).toBe("Task not found.");

    // Owner read → returns the task.
    const ownerRead: string = await ownerTool.invoke({ command: "read", taskId });
    expect((JSON.parse(ownerRead) as { task: { id: string } }).task.id).toBe(taskId);

    // Non-owner list → does not include the owner's task.
    const otherList: string = await otherTool.invoke({ command: "list", includeTerminal: true });
    const otherIds = (JSON.parse(otherList) as Array<{ id: string }>).map((t) => t.id);
    expect(otherIds).not.toContain(taskId);

    // Owner list → includes it.
    const ownerList: string = await ownerTool.invoke({ command: "list", includeTerminal: true });
    const ownerIds = (JSON.parse(ownerList) as Array<{ id: string }>).map((t) => t.id);
    expect(ownerIds).toContain(taskId);
  });
  },
);
