import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { JobManager } from "../../src/job-manager";
import {
  cleanupTestUser,
  closeDirectDb,
  pollUntilComplete,
  setupTestDb,
  createTestUser,
  waitForRunningForegroundJob,
} from "./helpers";
import {
  getTranscriptMessages,
  getSessionByThread,
  searchSessionMessagesFTS,
  closeAgentDb,
} from "./agent-helpers";
import { stubSingleTurnTranscriptExecutor, stubTurnWithToolExecutor } from "./stub-transcript-executor";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;
let jobManager: JobManager;

beforeAll(async () => {
  await setupTestDb();
  const u = await createTestUser("session-persist-contract");
  userId = u.userId;
  jobManager = new JobManager(fastCoalesce);
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

describe("Session persistence (contract, no LLM)", () => {
  test("single turn persists exactly user + assistant rows", async () => {
    const threadId = `test-persist-${Date.now()}`;
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:persist:${threadId}`,
      {
        message: "What color is the sky on a clear day?",
        ownerId: userId,
        threadId,
        turnId: randomUUID(),
        __stubAssistantReply: "The sky is blue on a clear day.",
      },
      stubSingleTurnTranscriptExecutor,
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(job, 15_000);
    expect(job.status).toBe("completed");

    const messages = await getTranscriptMessages(threadId);
    expect(messages.length).toBe(2);

    const users = messages.filter((m) => m.role === "user");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(users).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    expect(users[0]!.content).toContain("sky");
    expect(assistants[0]!.content).toContain("blue");

    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1]!;
      const cur = messages[i]!;
      const dt = cur.createdAt.getTime() - prev.createdAt.getTime();
      expect(dt > 0 || (dt === 0 && Number(cur.id) >= Number(prev.id))).toBe(true);
    }
  });

  test("session messageCount matches persisted row count", async () => {
    const threadId = `test-session-record-${Date.now()}`;
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:session:${threadId}`,
      {
        message: "Hello, this is a session test.",
        ownerId: userId,
        threadId,
        turnId: randomUUID(),
        __stubAssistantReply: "Acknowledged.",
      },
      stubSingleTurnTranscriptExecutor,
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(job, 15_000);
    expect(job.status).toBe("completed");

    const session = await getSessionByThread(threadId);
    expect(session).not.toBeNull();
    expect(session!.ownerId).toBe(userId);
    expect(session!.threadId).toBe(threadId);

    const messages = await getTranscriptMessages(threadId);
    expect(messages.length).toBe(2);
    expect(session!.messageCount).toBe(2);
  });

  test("full-text search finds inserted transcript row", async () => {
    const threadId = `test-fts-${Date.now()}`;
    const phrase = "The Pythagorean theorem relates sides of right triangles";
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:fts:${threadId}`,
      {
        message: `${phrase}. Just confirm.`,
        ownerId: userId,
        threadId,
        turnId: randomUUID(),
        __stubAssistantReply: "Understood.",
      },
      stubSingleTurnTranscriptExecutor,
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(job, 15_000);
    expect(job.status).toBe("completed");

    const results = await searchSessionMessagesFTS("Pythagorean");
    const match = results.find((r) => {
      if (r.content === null) throw new Error("seeded FTS content unavailable");
      return r.content.includes("Pythagorean");
    });
    expect(match).toBeDefined();
  });

  test("two sequential turns accumulate exactly four transcript rows", async () => {
    const threadId = `test-accumulate-${Date.now()}`;
    const laneKey = `test:accum:${threadId}`;

    await jobManager.createForegroundJob(
      userId,
      userId,
      laneKey,
      {
        message: "First message: hello.",
        ownerId: userId,
        threadId,
        turnId: randomUUID(),
        __stubAssistantReply: "First reply.",
      },
      stubSingleTurnTranscriptExecutor,
    );
    const job1 = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job1, 15_000);

    await jobManager.createForegroundJob(
      userId,
      userId,
      laneKey,
      {
        message: "Second message: world.",
        ownerId: userId,
        threadId,
        turnId: randomUUID(),
        __stubAssistantReply: "Second reply.",
      },
      stubSingleTurnTranscriptExecutor,
    );
    const job2 = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job2, 15_000);

    const messages = await getTranscriptMessages(threadId);
    expect(messages.length).toBe(4);

    const humanMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(humanMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);

    const session = await getSessionByThread(threadId);
    expect(session).not.toBeNull();
    expect(session!.messageCount).toBe(4);
  });

  test("turn with tool persists user + assistant-with-tools + tool (three rows)", async () => {
    const threadId = `test-tool-rows-${Date.now()}`;
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:tool:${threadId}`,
      { message: "x", ownerId: userId, threadId, turnId: randomUUID() },
      stubTurnWithToolExecutor,
    );
    const job = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job, 15_000);
    expect(job.status).toBe("completed");

    const messages = await getTranscriptMessages(threadId);
    expect(messages.length).toBe(3);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);

    const session = await getSessionByThread(threadId);
    expect(session!.messageCount).toBe(3);
  });
});
