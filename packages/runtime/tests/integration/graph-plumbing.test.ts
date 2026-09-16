/**
 * M067D Phase 1 — LangGraph executor + checkpoint plumbing with a
 * deterministic stub ChatModel (`NAUTILO_TEST_MODE=stub`). No API keys.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import { forkLanggraphExecutor } from "../../src/executors/fork-langgraph-executor";
import type { ForkRunMetadata } from "../../src/fork/fork-metadata";
import {
  __setStubModelForTests,
  createCheckpointSaver,
  createNautiloGraph,
  getAgentTurnContext,
  getAgentTurnContextByKey,
  getOrCreateAgentTurnContext,
  getOrCreateAgentTurnContextByKey,
  setAgentEventSink,
  turnContextKey,
} from "@nautilo/agent";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  pollUntilComplete,
  collectEvents,
  waitForRunningForegroundJob,
} from "./helpers";
import {
  setupAgentTestEnv,
  getTranscriptMessages,
  extractToolCalls,
  closeAgentDb,
} from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;
let agentId: string;
let jobManager: JobManager;
let workspaceRoot: string;

function assistantVisibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const raw = (block as { text?: unknown }).text;
          return typeof raw === "string" ? raw : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";

  jobManager = new JobManager(fastCoalesce);
  const env = await setupAgentTestEnv("graph-plumbing");
  userId = env.userId;
  agentId = env.agentId;

  workspaceRoot = join(tmpdir(), `m067d-plumbing-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.writeFile(join(workspaceRoot, "hello.txt"), "hello\n");
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);

  await cleanupTestUserWithDestructivePermission(userId);
  await closeDirectDb();
  await closeAgentDb();
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("Graph plumbing (stub LLM, M067D)", () => {
  test("single-shot text response lands in transcript", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "STUBBED_REPLY_ALPHA" }],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `stub-text-${Date.now()}`;
    await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
      message: "Say something unique.",
      ownerId: userId,
      agentId,
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId: randomUUID(),
    });

    const job = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job, 60_000);
    expect(job.status).toBe("completed");

    const messages = await getTranscriptMessages(threadId);
    const joined = messages.map((m) => assistantVisibleText(m.content)).join("\n");
    expect(joined).toContain("STUBBED_REPLY_ALPHA");
    expect(stub.remaining).toBe(0);
  });

  test("tool call → tool result → final assistant text (discover_tools)", async () => {
    const stub = createStubProvider({
      responses: [
        {
          type: "tool_call",
          name: "discover_tools",
          args: { query: "filesystem" },
          id: "call-disc-1",
        },
        { type: "text", content: "catalog introspection done" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `stub-tools-${Date.now()}`;
      await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
        message: "Search the tool catalog for filesystem tools.",
        ownerId: userId,
      agentId,
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: randomUUID(),
      });

      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 60_000);
      expect(job.status).toBe("completed");

      const toolEvents = events.filter((e) => e.type === "tool.start" || e.type === "tool.end");
      expect(toolEvents.length).toBeGreaterThan(0);

      const messages = await getTranscriptMessages(threadId);
      expect(extractToolCalls(messages).some((n) => n === "discover_tools")).toBe(true);
      const assistantText = messages
        .filter(
          (m) => m.role === "assistant" && assistantVisibleText(m.content).includes("catalog introspection"),
        ).length;
      expect(assistantText).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
    expect(stub.remaining).toBe(0);
  });

  test("model invoke error fails the job (terminal failed)", async () => {
    const stub = createStubProvider({
      responses: [{ type: "error", error: new Error("stubbed model failure") }],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `stub-err-${Date.now()}`;
    await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
      message: "This will error.",
      ownerId: userId,
      agentId,
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId: randomUUID(),
    });

    const job = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job, 60_000);
    expect(job.status).toBe("failed");
  });

  test("M135 P6 — DM server-time prefix lands in the checkpoint/model input but NOT in the transcript", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "TIME_PREFIX_ACK" }],
    });
    __setStubModelForTests(stub.asChatModel());

    const iso = "2026-06-03T08:02:53Z";
    const threadId = `stub-timeprefix-${Date.now()}`;
    await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
      message: "what time is it for you?",
      ownerId: userId,
      agentId,
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId: randomUUID(),
      serverTimePrefixIso: iso,
    });

    const job = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job, 60_000);
    expect(job.status).toBe("completed");

    // (a) The model SAW the time-prefixed human message (checkpoint grounding).
    const firstInvocation = stub.invocations[0];
    expect(firstInvocation).toBeDefined();
    const humanSeen = [...firstInvocation!.messages]
      .reverse()
      .find((m) => assistantVisibleText(m.content).includes("what time is it"));
    expect(assistantVisibleText(humanSeen?.content)).toContain(`[${iso}]`);

    // (b) The persisted transcript row is CLEAN — no time prefix leaks to the UI.
    const messages = await getTranscriptMessages(threadId);
    const userRow = messages.find((m) => m.role === "user");
    expect(userRow).toBeDefined();
    const userText = assistantVisibleText(userRow!.content);
    expect(userText).toContain("what time is it");
    expect(userText).not.toContain(`[${iso}]`);
    expect(userText).not.toContain("[2026-");
  });

  test("M135 P6 (fork) — forked DM turn: model sees the time prefix, transcript row is clean", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "FORK_TIME_ACK" }],
    });
    __setStubModelForTests(stub.asChatModel());

    const iso = "2026-06-03T09:15:30Z";
    const parentThreadId = `stub-fork-time-${Date.now()}`;
    const forkThreadId = `${parentThreadId}:fork:${randomUUID()}`;
    const turnId = randomUUID();
    const perAgentTurnContextId = turnContextKey(turnId, agentId);
    getOrCreateAgentTurnContext(turnId).skipFlag = true;
    getOrCreateAgentTurnContextByKey(perAgentTurnContextId).webSearchDeadlineAt = Date.now() + 300_000;
    const forkRun: ForkRunMetadata = {
      mode: "fork",
      parentThreadId,
      forkThreadId,
      checkpointThreadId: forkThreadId,
      transcriptThreadId: parentThreadId,
      sequence: 1,
      pendingTurns: [],
    };

    const gen = forkLanggraphExecutor(
      {
        message: "forked: what time is it?",
        ownerId: userId,
        agentId,
        turnId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        serverTimePrefixIso: iso,
        forkRun,
      },
      randomUUID(),
      `lane:${parentThreadId}`,
      new AbortController().signal,
    );
    for await (const _ev of gen) {
      // drain the stream to completion
    }

    expect(getAgentTurnContext(turnId)).toBeUndefined();
    expect(getAgentTurnContextByKey(perAgentTurnContextId)).toBeUndefined();

    // (a) The model saw the prefixed human (fork checkpoint grounding).
    const inv = stub.invocations[0];
    expect(inv).toBeDefined();
    const humanSeen = [...inv!.messages]
      .reverse()
      .find((m) => assistantVisibleText(m.content).includes("what time is it"));
    expect(assistantVisibleText(humanSeen?.content)).toContain(`[${iso}]`);

    // (b) The persisted transcript row (parent thread) is CLEAN.
    const messages = await getTranscriptMessages(parentThreadId);
    const userRow = messages.find((m) => m.role === "user");
    expect(userRow).toBeDefined();
    const userText = assistantVisibleText(userRow!.content);
    expect(userText).toContain("what time is it");
    expect(userText).not.toContain(`[${iso}]`);
    expect(userText).not.toContain("[2026-");
  });

  test("multi-turn continuity on one thread (checkpoints)", async () => {
    const stub = createStubProvider({
      responses: [
        { type: "text", content: "turn-one-ack" },
        { type: "text", content: "turn-two-ack" },
        { type: "text", content: "turn-three mentions TURN_ONE_TOKEN" },
      ],
    });

    const threadId = `stub-multi-${Date.now()}`;
    const laneKey = `lane:${threadId}`;

    for (let i = 1; i <= 3; i++) {
      __setStubModelForTests(stub.asChatModel());
      await jobManager.createForegroundJob(userId, userId, laneKey, {
        message: `Segment ${i}`,
        ownerId: userId,
      agentId,
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: randomUUID(),
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 60_000);
      expect(job.status).toBe("completed");
    }

    const messages = await getTranscriptMessages(threadId);
    const lastAssistant = [...messages].reverse().find(
      (m) => m.role === "assistant" && assistantVisibleText(m.content).length > 0,
    );
    expect(assistantVisibleText(lastAssistant?.content)).toContain("TURN_ONE_TOKEN");
    expect(stub.remaining).toBe(0);
  });

  test("D447 fresh foreground turns retain an activation lease through three turns then expire", async () => {
    const threadId = `d447-fresh-retention-${Date.now()}`;
    const activation = createStubProvider({
      responses: [
        {
          type: "tool_call",
          name: "activate_tools",
          args: { names: ["file"], families: [] },
          id: "activate-file",
        },
        { type: "text", content: "activated" },
      ],
    });
    __setStubModelForTests(activation.asChatModel());

    const activationTurnId = randomUUID();
    await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
      message: "Prepare file access.",
      ownerId: userId,
      agentId,
      actorRole: "owner",
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId: activationTurnId,
    });
    await pollUntilComplete(await waitForRunningForegroundJob(jobManager), 60_000);

    const graph = createNautiloGraph(createCheckpointSaver());
    const config = { configurable: { thread_id: threadId } };
    const activatedState = await graph.getState(config);
    expect(activatedState?.values["activatedToolNames"]).toEqual(["file"]);
    expect(activatedState?.values["activatedToolLeases"]).toEqual([
      { name: "file", idleTurns: 0 },
    ]);
    expect(activatedState?.values["activationLeasesInitialized"]).toBe(true);
    expect(activatedState?.values["activationLeasesAgedForTurnId"]).toBe(activationTurnId);

    for (const idleTurns of [1, 2, 3, 4]) {
      const turnId = randomUUID();
      const freshInput = createStubProvider({
        responses: [{ type: "text", content: `idle turn ${idleTurns}` }],
      });
      __setStubModelForTests(freshInput.asChatModel());
      await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
        message: `Share an unrelated short fact for idle turn ${idleTurns}.`,
        ownerId: userId,
        agentId,
        actorRole: "owner",
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId,
      });
      await pollUntilComplete(await waitForRunningForegroundJob(jobManager), 60_000);

      const state = await graph.getState(config);
      const expectedLeases = idleTurns <= 3
        ? [{ name: "file", idleTurns }]
        : [];
      expect(state?.values["activatedToolNames"]).toEqual(
        expectedLeases.map((lease) => lease.name),
      );
      expect(state?.values["activatedToolLeases"]).toEqual(expectedLeases);
      expect(state?.values["activationLeasesAgedForTurnId"]).toBe(turnId);
      expect(state?.values["activationLeasesInitialized"]).toBe(true);
    }
  });
});
