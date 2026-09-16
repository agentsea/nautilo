/**
 * M151 (Phase 7a + 7b) — the await/resume round-trip against real Postgres +
 * a stub graph. This is the end-to-end "did test006 actually get the question,
 * and did the answer come back" guard.
 *
 * Dispatch is driven DIRECTLY via `dispatchTaskRun` (NOT the global
 * `TaskObserver`), so the suite is safe against a populated instance (no
 * `assertCleanTaskTables`, no risk of claiming live tasks) and the resume leg
 * is exercised in isolation. Tasks use a far-future `next_fire_at` so a live
 * observer never claims these scoped rows.
 *
 * Covers:
 *  - ask_peer-shaped `new_dm`: the run posts its question and the question is
 *    READABLE BY THE PEER in the DM room (validates DM membership + the
 *    transcript session being owned by the peer/room-member, so the
 *    member-owned `getRoomMessagesAcrossMemberSessions` reader surfaces it —
 *    the actual "peer saw nothing" bug), then the task parks `awaiting`.
 *  - the reply hook: `findAwaitingTaskForRoom` + `resumeGraphWithHumanReply` +
 *    `reportBackTaskCompletion` resume the run on the peer's reply and report
 *    the answer back to the calling room; the task goes terminal.
 *  - a non-matching reply (third party) does NOT match an awaiting task.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  users,
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  jobs,
  tasks,
  taskRuns,
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  findAwaitingTaskForRoom,
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
  resumeGraphWithHumanReply,
} from "@nautilo/agent";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { dispatchTaskRun } from "../../src/tasks/dispatch-task-run";
import { reportBackTaskCompletion } from "../../src/tasks/report-back";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import {
  setTaskRunDb,
  setTaskRunJobManager,
} from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
  createTestUser,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

let ownerUserId: string; // requester
let agentId: string;
let agentActorId: string;
let ownerActorId: string;
let db: DirectDatabase;

let peerUserId: string;
let peerActorId: string;
let peerHandle: string;

const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdTaskIds: string[] = [];
const extraUserIds: string[] = [];

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("m151-awaitresume");
  ownerUserId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerUserId), eq(actors.kind, "agent")))
    .limit(1);
  agentActorId = aa!.id;
  const [ua] = await db
    .insert(actors)
    .values({ ownerId: ownerUserId, kind: "user", displayName: "Owner", trustState: "verified" })
    .returning({ id: actors.id });
  ownerActorId = ua!.id;

  peerHandle = `peer_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [peer] = await db
    .insert(users)
    .values({ name: "Test006", email: `${peerHandle}@test.local`, handle: peerHandle })
    .returning({ id: users.id });
  peerUserId = peer!.id;
  const [pa] = await db
    .insert(actors)
    .values({ ownerId: peerUserId, kind: "user", displayName: "Test006", trustState: "verified" })
    .returning({ id: actors.id });
  peerActorId = pa!.id;
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  setTaskRunJobManager(null);
  if (!db) return;
  if (createdTaskIds.length > 0) {
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  for (const rid of createdRoomIds) {
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
    const ids = sess.map((s) => s.id);
    if (ids.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await db.delete(sessions).where(inArray(sessions.id, ids));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
    await db.delete(jobs).where(eq(jobs.roomId, rid));
    await db.delete(rooms).where(eq(rooms.id, rid));
  }
  await db.delete(actors).where(eq(actors.id, peerActorId));
  await db.delete(actors).where(eq(actors.id, ownerActorId));
  for (const nid of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nid));
  }
  await db.delete(users).where(eq(users.id, peerUserId));
  await cleanupTestUser(ownerUserId);
  for (const uid of extraUserIds) await cleanupTestUser(uid);
  await closeDirectDb();
  await closeAgentDb();
});

function setStub(texts: string[]): ReturnType<typeof createStubProvider> {
  const provider = createStubProvider({
    responses: texts.map((content) => ({ type: "text" as const, content })),
  });
  __setStubModelForTests(provider.asChatModel());
  return provider;
}

/** Calling room (the requester's room) — owner is a member so report-back can wake it. */
async function createCallingRoom(label: string): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m151-call-${label}-${randomUUID().slice(0, 8)}` })
    .returning({ id: namespaces.id });
  createdNamespaceIds.push(ns!.id);
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [ownerActorId],
  });
  createdRoomIds.push(roomId);
  await db.insert(roomMembers).values({ roomId, actorId: ownerActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
  await ensureSession({
    threadId: `room:${roomId}:bot:${agentId}`,
    ownerId: ownerUserId,
    personaId: "owner",
    roomId,
    agentId,
  });
  return roomId;
}

async function insertAskPeerTask(callingRoomId: string): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: ownerUserId,
    requestorId: ownerUserId,
    agentId,
    prompt: "Ask test006 how they are feeling and report back.",
    preset: "ask_peer",
    scheduleKind: "now",
    targetChat: "new_dm",
    targetChatHandle: `@${peerHandle}`,
    targetUserIds: [ownerUserId],
    awaitResponse: true,
    toolsMode: "none",
    callingRoomId,
    nextFireAt: new Date(Date.now() + 3_600_000),
    status: "pending",
  });
  createdTaskIds.push(row.id);
  return row.id;
}

async function pollTask(
  taskId: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 25_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const t = await getTaskById(db, taskId);
    if (predicate(t?.status)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollTask timeout for ${taskId}: status=${(await getTaskById(db, taskId))?.status}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function pollPeerRoomMessages(
  roomId: string,
  predicate: (contents: string[]) => boolean,
  asOwnerId: string,
  timeoutMs = 25_000,
): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const { messages } = await getRoomMessagesAcrossMemberSessions({
      ownerId: asOwnerId,
      roomId,
      beforeCreatedAt: new Date(Date.now() + 60_000),
      beforeId: 2_147_483_647,
      limit: 200,
    });
    const contents = messages.map((m) => {
      if (m.content === null) throw new Error("seeded peer room message content unavailable");
      return m.content;
    });
    if (predicate(contents)) return contents;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollPeerRoomMessages timeout for ${roomId}: ${JSON.stringify(contents)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("M151 — ask_peer await/resume round-trip (stub graph, real PG)", () => {
  test("the run posts a VISIBLE question into the DM that the PEER can read, then parks awaiting", async () => {
    const callingRoomId = await createCallingRoom("askpeer");
    const QUESTION = "Hey Test006, how are you feeling today?";
    setStub([QUESTION]);

    const taskId = await insertAskPeerTask(callingRoomId);
    const dispatched = await dispatchTaskRun((await getTaskById(db, taskId))!, {
      db,
      jobManager,
      assertInvocation: async () => {},
    });
    expect(dispatched.kind).toBe("dispatched");
    if (dispatched.kind !== "dispatched") throw new Error("dispatch unexpectedly paused");
    const dmRoomId = dispatched.roomId;
    createdRoomIds.push(dmRoomId);

    // Task parks awaiting.
    await pollTask(taskId, (s) => s === "awaiting");
    const runs = await getTaskRuns(db, taskId);
    expect(runs.some((r) => r.status === "awaiting")).toBe(true);

    // THE CRUX: the peer (test006) can read the agent's question in the DM room.
    const peerView = await pollPeerRoomMessages(
      dmRoomId,
      (c) => c.some((x) => x.includes("how are you feeling")),
      peerUserId,
    );
    expect(peerView.some((x) => x.includes("how are you feeling"))).toBe(true);
  }, 60_000);

  test("a matching peer reply resumes the run and reports the answer back to the calling room; non-matching reply is a no-op", async () => {
    const callingRoomId = await createCallingRoom("roundtrip");
    const QUESTION = "How are you, Test006?";
    const RESUME_FINAL = "Test006 says they are doing great.";
    const WAKE_REPLY = "Test006 told me they're doing great!";
    // 1 for the question turn, 1 for the resumed turn (final text), 1 for the wake reply turn.
    setStub([QUESTION, RESUME_FINAL, WAKE_REPLY, "spare"]);

    const taskId = await insertAskPeerTask(callingRoomId);
    const dispatched = await dispatchTaskRun((await getTaskById(db, taskId))!, {
      db,
      jobManager,
      assertInvocation: async () => {},
    });
    expect(dispatched.kind).toBe("dispatched");
    if (dispatched.kind !== "dispatched") throw new Error("dispatch unexpectedly paused");
    const dmRoomId = dispatched.roomId;
    createdRoomIds.push(dmRoomId);
    await pollTask(taskId, (s) => s === "awaiting");

    // Non-matching reply: an unrelated third party in the DM room does not match.
    const { userId: strangerId } = await createTestUser("m151-stranger");
    extraUserIds.push(strangerId);
    const noMatch = await findAwaitingTaskForRoom(db, dmRoomId, strangerId);
    expect(noMatch).toBeUndefined();

    // Matching reply: the peer is in target_user_ids → resume.
    const found = await findAwaitingTaskForRoom(db, dmRoomId, peerUserId);
    expect(found).toBeTruthy();
    expect(found!.task.id).toBe(taskId);

    const processor = createPersistingProcessor({
      threadId: found!.graphThreadId,
      ownerId: found!.task.ownerId,
      agentId: found!.task.agentId,
      laneKey: `task:${taskId}`,
      eventBus,
    });
    const result = await resumeGraphWithHumanReply(
      found!.graphThreadId,
      "I'm doing great, thanks!",
      peerUserId,
      processor,
      `task:${taskId}`,
    );
    expect(result.reparked).toBe(false);
    expect(result.finalText.length).toBeGreaterThan(0);

    await reportBackTaskCompletion(
      { db },
      { taskId, runId: found!.runId, scheduleKind: found!.task.scheduleKind, resultText: result.finalText },
    );

    // Task is terminal (completed) and the calling room got a report-back turn.
    await pollTask(taskId, (s) => s === "completed");
    const callingView = await pollPeerRoomMessages(
      callingRoomId,
      (c) => c.some((x) => x.includes("great")),
      ownerUserId,
    );
    expect(callingView.some((x) => x.includes("great"))).toBe(true);
  }, 90_000);
});
