/**
 * M085 MAJOR #1 + #3 — fork run wires transcript writes to the PARENT
 * room thread (no checkpoint splice). Drives a stub executor that emits
 * the same persistence + completion calls a real `forkLanggraphExecutor`
 * makes (`persistMessages(parentThreadId,…)` + `forkCoordinator.markForkCompleted`).
 * The real DB exercises `appendTranscriptMessages` +
 * `getLatestSessionForRoom` + `getSessionMessages`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { getLatestSessionForRoom, getSessionMessages } from "@nautilo/agent";
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
  waitForDispatchedJobCount,
  pollUntilComplete,
} from "./helpers";

const TIMING = {
  coalescerWindowMs: 60_000,
  coalescerFirstSegmentQuietMs: 30,
} as const;

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  userId = (await createTestUser("fork-completion-parent-state")).userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("M085 fork persists reply to the PARENT transcript (no splice)", () => {
  test("fork persists rows under parent room transcript (no checkpoint splice)", async () => {
    const laneLock = new InMemoryLaneLock();
    const main1Gate = Promise.withResolvers<void>();

    const { roomId } = await createTestRoom(userId);
    const lane = `room:${roomId}`;
    const parentThreadId = `room:${roomId}`;

    const stubExecutor: JobExecutor = async function* (input, _jobId, laneKey) {
      const fr = (input as { forkRun?: ForkRunMetadata }).forkRun;
      const message = (input["message"] as string) ?? "";
      const turnId = (input["turnId"] as string) ?? "";
      if (!fr) {
        // main turn — block lane until released; persist nothing here
        // (langgraphExecutor would; we keep the test surface narrow).
        await main1Gate.promise;
        yield {
          type: "message.tokens",
          laneKey: laneKey ?? "lane",
          content: ".",
          chunkSequence: 1,
          done: true,
        };
        return;
      }

      // Emulate forkLanggraphExecutor: persist user + assistant rows
      // to the PARENT transcript thread (not the fork checkpoint id).
      const fingerprints = new Set<string>();
      const persistOpts = {
        roomId,
        humanTurnId: turnId,
        eventBus,
      };
      const human = new HumanMessage(message);
      const ai = new AIMessage(`reply:${message}`);
      await persistMessages(fr.transcriptThreadId, userId, [human, ai], fingerprints, persistOpts);

      forkCoordinator.markForkCompleted(fr.parentThreadId, fr.sequence);

      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "lane",
        content: "fork-done",
        chunkSequence: 1,
        done: true,
      };
    };

    const jm = new JobManager({ laneLock, ...TIMING });
    const base = {
      ownerId: userId,
      requestorId: userId,
      agentId: "a1",
      roomId,
      graphThreadId: parentThreadId,
      threadId: parentThreadId,
    };

    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "first",
      turnId: randomUUID(),
    }, stubExecutor);
    const [main1] = await waitForDispatchedJobCount(jm, 1);
    if (!main1) throw new Error("expected main1");

    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "second",
      turnId: randomUUID(),
    }, stubExecutor);
    const [fork2] = await waitForDispatchedJobCount(jm, 1);
    if (!fork2) throw new Error("expected fork2");

    await pollUntilComplete(fork2);
    main1Gate.resolve();
    await pollUntilComplete(main1);

    // Transcript persistence: room's session is the PARENT thread,
    // not the fork checkpoint thread.
    const session = await getLatestSessionForRoom(userId, roomId);
    expect(session).not.toBeNull();
    expect(session!.threadId).toBe(parentThreadId);
    expect(session!.threadId.includes(":fork:")).toBe(false);

    // The fork's user + assistant rows live in the parent's session.
    const msgs = await getSessionMessages(session!.sessionId);
    const userTexts = msgs.filter((m) => m.role === "user").map((m) => m.content);
    const aiTexts = msgs.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(userTexts).toContain("second");
    expect(aiTexts.some((c) => typeof c === "string" && c.includes("reply:second"))).toBe(true);
  });
});
