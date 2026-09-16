/**
 * M136 — per-(room,bot) checkpoint serialization, integration (real Postgres).
 *
 * Test Plan §5 #8 + #9 (issue ISSUE-M136):
 *   #8 — two DIFFERENT users dispatch to the SAME bot concurrently → the bot's
 *        checkpoint thread is written one-at-a-time (the second turn forks the
 *        bot thread and splices in order); the parent transcript shows both
 *        turns, never interleaved/lost, and NO two main turns ever run the bot
 *        thread at once. (Pre-M136: two lanes → no serialization → race.)
 *   #9 — one human message wakes TWO bots → the bots run in parallel on
 *        DISTINCT threads (no cross-serialization), and the shared `turnId`
 *        collapses the duplicated human row when read back across member
 *        sessions (`getRoomMessagesAcrossMemberSessions`).
 *
 * Drives the REAL `JobManager` dispatch path against the real DB. The splice
 * graph is stubbed (LangGraph checkpoint I/O is out of scope here) but the
 * transcript persistence (`persistMessages` → `appendTranscriptMessages`) and
 * cross-session read are real. Mirrors the proven harness in
 * `fork-completion-parent-state.integration.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  getLatestSessionForRoom,
  getRoomMessagesAcrossMemberSessions,
} from "@nautilo/agent";
import { actors, roomMembers } from "@nautilo/db";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { eventBus } from "../../src/event-bus";
import { persistMessages } from "../../src/executors/persist-messages";
import { forkCoordinator } from "../../src/fork/fork-coordinator";
import type { ForkRunMetadata } from "../../src/fork/fork-metadata";
import {
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  setupTestDb,
  createTestRoom,
  getDirectDb,
  waitForDispatchedJobCount,
  pollUntilComplete,
  collectEvents,
} from "./helpers";

const TIMING = {
  coalescerWindowMs: 60_000,
  coalescerFirstSegmentQuietMs: 25,
} as const;

let ownerA: string;
let ownerB: string;

beforeAll(async () => {
  await setupTestDb();
  ownerA = (await createTestUser("m136-int-a")).userId;
  ownerB = (await createTestUser("m136-int-b")).userId;
});

afterAll(async () => {
  // Clean the non-owner first: user B's fork job references user A's room, so
  // B's jobs must be deleted before A's room can be removed (FK).
  await cleanupTestUser(ownerB);
  await cleanupTestUser(ownerA);
  await closeDirectDb();
});

/** Largest value that fits Postgres int4 (the `session_messages.id` column type). */
const MAX_INT4 = 2_147_483_647;

/** Seed a second human as a room member so their bot-session is RLS-readable. */
async function addRoomMember(roomId: string, memberOwnerId: string): Promise<void> {
  const db = getDirectDb();
  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: memberOwnerId,
      kind: "user",
      displayName: "m136-second-human",
      trustState: "verified",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("failed to seed second member actor");
  await db.insert(roomMembers).values({ roomId, actorId: actor.id, roomRole: "member" });
}

describe("M136 thread serialization (integration)", () => {
  test("#8 two users → same bot: serialized on the bot thread, consistent checkpoint, no concurrent main", async () => {
    const agentId = "botX";
    const { roomId } = await createTestRoom(ownerA);
    await addRoomMember(roomId, ownerB);

    const botThread = `room:${roomId}:bot:${agentId}`;
    const laneA = `room:${roomId}:user:ua:bot:${agentId}`;
    const laneB = `room:${roomId}:user:ub:bot:${agentId}`;

    // Concurrency probe: how many MAIN turns are running the bot thread at once.
    let activeMainOnThread = 0;
    let maxConcurrentMainOnThread = 0;

    const main1Gate = Promise.withResolvers<void>();
    const { events, cleanup } = collectEvents(eventBus);

    const stubExecutor: JobExecutor = async function* (input, _jobId, laneKey) {
      const fr = (input as { forkRun?: ForkRunMetadata }).forkRun;
      const message = (input["message"] as string) ?? "";
      const turnId = (input["turnId"] as string) ?? "";
      const ownerId = (input["ownerId"] as string) ?? ownerA;
      const human = new HumanMessage(message);
      const ai = new AIMessage(`reply:${message}`);

      if (!fr) {
        // Main turn — writes the bot (parent) checkpoint. Hold the thread so
        // the second user's turn must contend with it.
        activeMainOnThread += 1;
        maxConcurrentMainOnThread = Math.max(maxConcurrentMainOnThread, activeMainOnThread);
        try {
          await persistMessages(botThread, ownerId, [human, ai], new Set(), {
            roomId,
            humanTurnId: turnId,
            eventBus,
          });
          await main1Gate.promise;
        } finally {
          activeMainOnThread -= 1;
        }
        yield { type: "message.tokens", laneKey: laneKey ?? "lane", content: ".", chunkSequence: 1, done: true };
        return;
      }

      // Fork turn — persists to the PARENT transcript thread.
      await persistMessages(fr.transcriptThreadId, ownerId, [human, ai], new Set(), {
        roomId,
        humanTurnId: turnId,
        eventBus,
      });
      forkCoordinator.markForkCompleted(fr.parentThreadId, fr.sequence);
      yield { type: "message.tokens", laneKey: laneKey ?? "lane", content: "fork-done", chunkSequence: 1, done: true };
    };

    const jm = new JobManager({ laneLock: new InMemoryLaneLock(), ...TIMING });
    const baseFor = (owner: string) => ({
      ownerId: owner,
      requestorId: owner,
      agentId,
      roomId,
      graphThreadId: botThread,
      threadId: botThread,
    });

    // User A dispatches → runs as the main turn, holds the bot thread.
    await jm.createForegroundJob(ownerA, ownerA, laneA, {
      ...baseFor(ownerA),
      message: "from-A",
      turnId: randomUUID(),
    }, stubExecutor);
    const [mainA] = await waitForDispatchedJobCount(jm, 1);
    if (!mainA) throw new Error("expected main turn for user A");

    // User B (DIFFERENT lane, SAME bot thread) dispatches while A runs.
    await jm.createForegroundJob(ownerB, ownerB, laneB, {
      ...baseFor(ownerB),
      message: "from-B",
      turnId: randomUUID(),
    }, stubExecutor);
    const [forkB] = await waitForDispatchedJobCount(jm, 1);
    if (!forkB) throw new Error("expected fork turn for user B");

    // B must have been routed as a FORK of the BOT thread (the fix). Pre-M136
    // it would have started a second concurrent main on the same checkpoint.
    const forkedEvt = events.find((e) => e.type === "job.forked");
    expect(forkedEvt?.type).toBe("job.forked");
    if (forkedEvt?.type === "job.forked") {
      expect(forkedEvt.jobId).toBe(forkB.id);
      expect(forkedEvt.parentThreadId).toBe(botThread);
      expect(forkedEvt.forkThreadId.startsWith(`${botThread}:fork:`)).toBe(true);
    }

    await pollUntilComplete(forkB);
    main1Gate.resolve();
    await pollUntilComplete(mainA);

    cleanup();

    // (a) The bot checkpoint was NEVER written by two main turns at once.
    expect(maxConcurrentMainOnThread).toBe(1);

    // (c) The room transcript holds BOTH humans' turns (no loss / no merge).
    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: new Date(Date.now() + 60_000),
      beforeId: MAX_INT4,
      limit: 50,
    });
    const userTexts = page.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toContain("from-A");
    expect(userTexts).toContain("from-B");

    // (d) The room session is the bot thread, not a fork checkpoint.
    const session = await getLatestSessionForRoom(ownerA, roomId);
    expect(session?.threadId.includes(":fork:")).toBe(false);
  });

  test("#9 one message wakes two bots → parallel distinct threads; shared turnId collapses the human row", async () => {
    const { roomId } = await createTestRoom(ownerA);
    const bot1Thread = `room:${roomId}:bot:bot1`;
    const bot2Thread = `room:${roomId}:bot:bot2`;
    const lane1 = `room:${roomId}:user:ua:bot:bot1`;
    const lane2 = `room:${roomId}:user:ua:bot:bot2`;
    const sharedTurnId = randomUUID(); // both woken bots share ONE turnId

    let concurrentlyRunning = 0;
    let maxConcurrent = 0;
    const bothRunning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const stubExecutor: JobExecutor = async function* (input, _jobId, laneKey) {
      const message = (input["message"] as string) ?? "";
      const turnId = (input["turnId"] as string) ?? "";
      const thread = (input["graphThreadId"] as string) ?? "";
      // Persist the (identical) human message + a per-bot assistant reply to
      // THIS bot's session, under the shared turnId.
      const human = new HumanMessage(message);
      const ai = new AIMessage(`reply-${thread.endsWith("bot1") ? "1" : "2"}`);
      await persistMessages(thread, ownerA, [human, ai], new Set(), {
        roomId,
        humanTurnId: turnId,
        eventBus,
      });

      concurrentlyRunning += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentlyRunning);
      if (concurrentlyRunning >= 2) bothRunning.resolve();
      try {
        await release.promise;
      } finally {
        concurrentlyRunning -= 1;
      }
      yield { type: "message.tokens", laneKey: laneKey ?? "lane", content: message, chunkSequence: 1, done: true };
    };

    const jm = new JobManager({ laneLock: new InMemoryLaneLock(), ...TIMING });
    const base = {
      ownerId: ownerA,
      requestorId: ownerA,
      roomId,
      message: "hello both",
      turnId: sharedTurnId,
    };

    await jm.createForegroundJob(ownerA, ownerA, lane1, {
      ...base,
      agentId: "bot1",
      graphThreadId: bot1Thread,
      threadId: bot1Thread,
    }, stubExecutor);
    await jm.createForegroundJob(ownerA, ownerA, lane2, {
      ...base,
      agentId: "bot2",
      graphThreadId: bot2Thread,
      threadId: bot2Thread,
    }, stubExecutor);

    const [j1, j2] = await waitForDispatchedJobCount(jm, 2);
    if (!j1 || !j2) throw new Error("expected two parallel bot jobs");

    // R4 — distinct threads run in PARALLEL (no cross-serialization).
    await Promise.race([
      bothRunning.promise,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("bots did not run in parallel")), 5_000)),
    ]);
    expect(maxConcurrent).toBe(2);

    release.resolve();
    await pollUntilComplete(j1);
    await pollUntilComplete(j2);

    // Shared turnId ⇒ identical human fingerprint across the two bot sessions
    // ⇒ the cross-session read collapses the duplicate user row to ONE, while
    // both bots' assistant rows survive.
    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: new Date(Date.now() + 60_000),
      beforeId: MAX_INT4,
      limit: 50,
    });
    const userRows = page.messages.filter((m) => m.role === "user" && m.content === "hello both");
    expect(userRows.length).toBe(1);
    const assistantRows = page.messages.filter((m) => m.role === "assistant");
    expect(assistantRows.some((m) => m.content === "reply-1")).toBe(true);
    expect(assistantRows.some((m) => m.content === "reply-2")).toBe(true);
  });
});
