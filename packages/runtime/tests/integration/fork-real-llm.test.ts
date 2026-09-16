/**
 * M085 PR review #2 follow-up — real-LLM gap closer.
 *
 * The unit + stub-executor integration tests around fork-on-busy never
 * exercise an actual provider call, so a previous regression where the
 * fork's initial state contained a mid-conversation `SystemMessage`
 * shipped to production and only crashed live ("System messages are only
 * permitted as the first passed message"). This suite drives the REAL
 * `forkLanggraphExecutor` against an Anthropic / OpenAI run — fork must
 * complete without the upstream-model error.
 *
 * Skips visibly when no provider keys are available.
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import { setAgentEventSink } from "@nautilo/agent";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import type { JobExecutor } from "../../src/job";
import {
  cleanupTestUser,
  closeDirectDb,
  collectEvents,
  createTestRoom,
  pollUntilComplete,
  waitForDispatchedJobCount,
} from "./helpers";
import {
  closeAgentDb,
  setupAgentTestEnv,
} from "./agent-helpers";

const fastCoalesce = {
  coalescerWindowMs: 60_000,
  coalescerFirstSegmentQuietMs: 40,
} as const;

let userId = "";
let agentId = "";
let workspaceRoot: string | undefined;
const hasLLMKey =
  !!process.env["ANTHROPIC_API_KEY"]?.trim() ||
  !!process.env["OPENAI_API_KEY"]?.trim();

beforeAll(async () => {
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });

  if (!hasLLMKey) return;

  const env = await setupAgentTestEnv("fork-real-llm-m085");
  userId = env.userId;
  agentId = env.agentId;
  workspaceRoot = join(tmpdir(), `m085-fork-real-llm-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
});

afterAll(async () => {
  setAgentEventSink(null);
  if (workspaceRoot) {
    await fsp.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (hasLLMKey && userId) {
    await cleanupTestUser(userId);
  }
  await closeDirectDb();
  await closeAgentDb();
});

describe("M085 fork-on-busy real-LLM (PR review #2 follow-up)", () => {
  test.skipIf(!hasLLMKey)(
    `forked turn with one predecessor completes against the real provider${hasLLMKey ? "" : " (missing ANTHROPIC_API_KEY or OPENAI_API_KEY)"}`,
    async () => {
    const jm = new JobManager(fastCoalesce);
    const { roomId } = await createTestRoom(userId);
    const lane = `room:${roomId}`;
    const graphThreadId = `room:${roomId}`;
    const base = {
      ownerId: userId,
      agentId,
      requestorId: userId,
      roomId,
      graphThreadId,
      threadId: graphThreadId,
      workspacePath: workspaceRoot!,
      currentFolder: workspaceRoot!,
    };

    // Main 1 holds the lane with a custom blocking executor — real LLM
    // would also work but is slow + flaky for an ordering test. The fork
    // 2 dispatch will see `laneExec === customMain1`, but that is not
    // `langgraphExecutor`, so JobManager's fork branch falls back to
    // `getExecutor("foreground", input)` → real `forkLanggraphExecutor`.
    const main1Gate = Promise.withResolvers<void>();
    const mainHold: JobExecutor = async function* (_input, _jobId, laneKey) {
      await main1Gate.promise;
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? lane,
        content: "main1-finished",
        chunkSequence: 1,
        done: true,
      };
    };

    const { events, cleanup } = collectEvents(eventBus);

    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "What is 2 + 2? Reply with just the digit.",
      turnId: randomUUID(),
    }, mainHold);
    const [main1] = await waitForDispatchedJobCount(jm, 1);
    if (!main1) throw new Error("expected main1");

    // Send msg 2 while lane is busy → forks. No executor override so the
    // lane registry is reset to the default langgraphExecutor and the
    // fork branch uses forkLanggraphExecutor.
    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "Reply with the single word PASS and nothing else.",
      turnId: randomUUID(),
    });
    const [fork2] = await waitForDispatchedJobCount(jm, 1);
    if (!fork2) throw new Error("expected fork2");

    // Wait for fork 2 to terminate against the real model — this is the
    // assertion: with the buggy SystemMessage shape it would fail with
    // "System messages are only permitted as the first passed message".
    try {
      await pollUntilComplete(fork2, 90_000);
    } finally {
      main1Gate.resolve();
      await pollUntilComplete(main1, 30_000).catch(() => {});
      cleanup();
    }

    expect(fork2.status).toBe("completed");

    // Sanity: no `job.status: failed` for fork 2 carrying an upstream
    // model rejection. We don't pin the exact message text because
    // providers wordsmith errors, but a successful fork should NOT have
    // emitted any failed-status event for this job id.
    const fork2Failed = events.some(
      (e: ServerEvent) =>
        e.type === "job.status" && e.jobId === fork2.id && e.status === "failed",
    );
    expect(fork2Failed).toBe(false);
    const forkOutput = events
      .filter(
        (e): e is ServerEvent & {
          type: "message.tokens";
          content: string;
        } =>
          e.type === "message.tokens"
          && "content" in e
          && e.laneKey === lane,
      )
      .map((e) => e.content)
      .join("");
    expect(forkOutput.toUpperCase()).toContain("PASS");
    },
    120_000,
  );
});
