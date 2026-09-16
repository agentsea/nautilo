import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setAgentEventSink } from "@nautilo/agent";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";
import {
  cleanupTestUser,
  closeDirectDb,
  pollUntilComplete,
  collectEvents,
  waitForRunningForegroundJob,
} from "./helpers";
import {
  setupAgentTestEnv,
  getTranscriptMessages,
  closeAgentDb,
} from "./agent-helpers";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;
let agentId: string;
let jobManager: JobManager;
let _prevModel: string | undefined;
const hasOpenAIKey = !!process.env["OPENAI_API_KEY"]?.trim();

beforeAll(async () => {
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });

  jobManager = new JobManager(fastCoalesce);
  if (!hasOpenAIKey) return;

  _prevModel = process.env["NAUTILO_MODEL"];
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";

  const env = await setupAgentTestEnv("agent-invoke");
  userId = env.userId;
  agentId = env.agentId;
});

afterAll(async () => {
  if (_prevModel === undefined) {
    delete process.env["NAUTILO_MODEL"];
  } else {
    process.env["NAUTILO_MODEL"] = _prevModel;
  }
  setAgentEventSink(null);
  if (hasOpenAIKey) {
    await cleanupTestUser(userId);
  }
  await closeDirectDb();
  await closeAgentDb();
});

describe("Agent invocation (integration)", () => {
  test.skipIf(!hasOpenAIKey)(
    `simple message gets a text response${hasOpenAIKey ? "" : " (missing OPENAI_API_KEY)"}`,
    async () => {
    const threadId = `test-simple-${Date.now()}`;
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:invoke:${threadId}`,
      { message: "What is 2 + 2? Reply with just the number.", ownerId: userId, agentId, threadId },
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(job, 30_000);
    expect(job.status).toBe("completed");

    const messages = await getTranscriptMessages(threadId);
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const humanMsg = messages.find((m) => m.role === "user");
    expect(humanMsg).toBeDefined();
    if (!humanMsg || humanMsg.content === null) throw new Error("seeded human content unavailable");
    expect(humanMsg.content).toContain("2 + 2");

    const assistantMsgs = messages.filter(
      (m) => m.role === "assistant" && m.content !== null && m.content.length > 0,
    );
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const hasAnswer = assistantMsgs.some((m) => {
      if (m.content === null) throw new Error("seeded assistant content unavailable");
      return m.content.includes("4");
    });
    expect(hasAnswer).toBe(true);
    },
  );

  test.skipIf(!hasOpenAIKey)(
    `events stream correctly during LLM execution${hasOpenAIKey ? "" : " (missing OPENAI_API_KEY)"}`,
    async () => {
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `test-events-${Date.now()}`;
      await jobManager.createForegroundJob(
        userId,
        userId,
        `test:events:${threadId}`,
        { message: "Say hello in one word.", ownerId: userId, agentId, threadId },
      );

      const job = await waitForRunningForegroundJob(jobManager);

      await pollUntilComplete(job, 30_000);
      expect(job.status).toBe("completed");

      const statusEvents = events.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status" && "jobId" in e && e.jobId === job.id,
      );
      const tokenEvents = events.filter(
        (e): e is ServerEvent & { type: "message.tokens" } =>
          e.type === "message.tokens",
      );

      const statuses = statusEvents.map((e) => e.status);
      expect(statuses).toContain("running");
      expect(statuses).toContain("completed");

      expect(tokenEvents.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
    },
  );
});
