/**
 * ISSUE-M217 — hermetic regression for the Task / scope-subagent graph path.
 *
 * Reproduces the *production* metering path faithfully:
 *   taskRunExecutor -> runScopeSubagentUntilPause -> real graph.streamEvents(v2)
 *   -> real agentNode -> real invokeChatModelWithFallback -> real
 *   createUniversalModel/bindTools/invoke.
 *
 * The ONLY thing stubbed is provider network generation, patched at the lowest
 * seam (`_streamResponseChunks` / `_generate` on the concrete provider chat
 * class prototypes). Everything above that — constructor-time usage callback
 * wiring, bindTools, the LangChain callback manager, `handleLLMEnd`, the
 * AsyncLocalStorage usage context, and the graph's `callbacks: []` stream
 * isolation — runs for real. This is what makes it a real reproduction rather
 * than the earlier tautology (which mocked `invokeChatModelWithFallback` and
 * hand-invoked a known-good metered model, i.e. asserted its own stub).
 *
 * ROOT CAUSE (2026-07-20): orphan Task targets intentionally carry `roomId: ""`.
 * The callback previously preserved that empty string, so the fire-and-forget
 * insert rejected `room_id=''` as an invalid UUID and produced no usage row.
 * These regressions reproduce the orphan state and require nullable usage
 * attribution (`roomId: null`) for both Luna and Sonnet. They also prove the
 * constructor callback survives `bindTools`, `callbacks: []`, and the real
 * LangGraph streaming branch. The distinct 999-token `_generate` payload proves
 * the streaming branch — not the non-streaming path — is exercised.
 *
 * No server, DB, migrations, or live provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver } from "@langchain/langgraph";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createDiscoverToolsTool } from "../../src/tools/meta/discover-tools";
import type { RecordUsageInput } from "../../src/usage/record-usage";

const subEnvelope: MemoryAccessEnvelope = {
  memoryMode: "namespace",
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["n1"],
  mutableNamespaces: ["n1"],
  writableNamespaces: ["n1"],
  toolPolicy: {},
};

let runScopeSubagentUntilPause: (
  opts: import("../../src/subagents/scope-subagent/run").RunScopeSubagentOpts,
) => Promise<import("../../src/subagents/scope-subagent/run").RunScopeSubagentResult>;
let __setUsageRecorderForTests: typeof import("../../src/usage/usage-callback").__setUsageRecorderForTests;

const usageCalls: RecordUsageInput[] = [];
const savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch | undefined;

const SYNTHETIC_USAGE = { input_tokens: 12, output_tokens: 6, total_tokens: 18 };

function chunkWithUsage(usage: Record<string, number>): AIMessageChunk {
  const message = new AIMessageChunk("done");
  (message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = usage;
  return message;
}

/** One streamed chunk carrying provider `usage_metadata`, then done. */
async function* syntheticStream(): AsyncGenerator<ChatGenerationChunk> {
  yield new ChatGenerationChunk({
    text: "done",
    message: chunkWithUsage({ ...SYNTHETIC_USAGE }),
  });
}

async function syntheticGenerate(): Promise<unknown> {
  // Distinct token count so a test failure reveals if the NON-streaming
  // `_generate` branch fired instead of the streaming branch (production runs
  // under `graph.streamEvents` v2 → the streaming branch).
  return {
    generations: [
      {
        text: "done",
        message: chunkWithUsage({ input_tokens: 999, output_tokens: 999, total_tokens: 1998 }),
      },
    ],
    llmOutput: {},
  };
}

type Patchable = {
  _streamResponseChunks: (...args: unknown[]) => AsyncGenerator<unknown>;
  _generate: (...args: unknown[]) => Promise<unknown>;
};

const saved: Array<{ proto: Patchable; stream: unknown; generate: unknown }> = [];

function patchProviderNetworkSeam(proto: Patchable): void {
  saved.push({
    proto,
    stream: proto._streamResponseChunks,
    generate: proto._generate,
  });
  proto._streamResponseChunks = () => syntheticStream();
  proto._generate = () => syntheticGenerate();
}

beforeAll(async () => {
  // In-memory checkpointer keeps the real graph + `getState` path intact
  // without a Postgres saver (the only DB seam the runner touches).
  const memorySaver = new MemorySaver();
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => memorySaver,
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async () => ({ insertedRows: [] }),
  }));

  const realTrust = await import("@nautilo/trust");
  mock.module("@nautilo/trust", () => ({
    ...realTrust,
    getPolicyResolver: () => ({
      resolveContext: async () => {
        throw new Error("not used in hermetic subagent graph test");
      },
      buildEnvelope: async () => {
        throw new Error("not used in hermetic subagent graph test");
      },
      checkToolAccess: async () => ({ type: "allow" }),
      routeApproval: async () => ({ type: "prove_it", approvers: [] }),
    }),
  }));

  // Lowest-seam network stub: patch the concrete provider chat classes so no
  // real HTTP happens, while the full real callback/usage path above runs.
  patchProviderNetworkSeam(ChatOpenAI.prototype as unknown as Patchable);
  patchProviderNetworkSeam(ChatAnthropic.prototype as unknown as Patchable);

  savedEnv["NAUTILO_TEST_MODE"] = process.env["NAUTILO_TEST_MODE"];
  savedEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
  savedEnv["OPENAI_BASE_URL"] = process.env["OPENAI_BASE_URL"];
  savedEnv["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === "/v1/models/gpt-5.6-luna") {
      return new Response(null, { status: 401, statusText: "Test capability probe" });
    }
    throw new Error(`Unexpected HTTP request in hermetic task-run usage test: ${url}`);
  }) as typeof globalThis.fetch;
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["OPENAI_API_KEY"] = "test-dummy-openai-key";
  process.env["OPENAI_BASE_URL"] = "https://api.openai.com/v1";
  process.env["ANTHROPIC_API_KEY"] = "test-dummy-anthropic-key";

  const catalog = new ToolCatalog();
  catalog.register({
    name: "discover_tools",
    factory: (context) => createDiscoverToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  initToolCatalog(catalog);

  ({ runScopeSubagentUntilPause } = await import("../../src/subagents/scope-subagent/run"));
  ({ __setUsageRecorderForTests } = await import("../../src/usage/usage-callback"));
});

afterAll(() => {
  for (const entry of saved) {
    entry.proto._streamResponseChunks = entry.stream as Patchable["_streamResponseChunks"];
    entry.proto._generate = entry.generate as Patchable["_generate"];
  }
  mock.restore();
  if (savedFetch) globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  usageCalls.length = 0;
  __setUsageRecorderForTests((input) => {
    usageCalls.push(input);
  });
});

const baseOpts = {
  parentThreadId: "parent-thread",
  parentTurnId: "turn-1",
  parentOwnerId: "owner-1",
  brief: "complete the background task",
  subEnvelope,
  actorRole: "owner" as const,
  assistantName: "Genie",
  soulFile: "",
  currentFolder: "/tmp",
  workspacePath: "/tmp",
  subagentDepth: 1,
  subagentMaxDepth: 5,
  securityAuditClientMeta: null,
  roomRoster: [],
  // Orphan Task target: there is intentionally no Room UUID.
  roomId: "",
  taskRun: true,
  modelFallbackMode: "none" as const,
};

describe("task-run usage through scope subagent stream (ISSUE-M217)", () => {
  test("openai:gpt-5.6-luna records exactly one subagent row through the real task graph path", async () => {
    const result = await runScopeSubagentUntilPause({
      ...baseOpts,
      modelId: "openai:gpt-5.6-luna",
    });

    expect(result.status).toBe("completed");
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]).toMatchObject({
      model: "openai:gpt-5.6-luna",
      callType: "subagent",
      userId: "owner-1",
      roomId: null,
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
    });
  });

  test("anthropic:claude-sonnet-4-6 records exactly one subagent row through the real task graph path", async () => {
    const result = await runScopeSubagentUntilPause({
      ...baseOpts,
      modelId: "anthropic:claude-sonnet-4-6",
    });

    expect(result.status).toBe("completed");
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]).toMatchObject({
      model: "anthropic:claude-sonnet-4-6",
      callType: "subagent",
      userId: "owner-1",
      roomId: null,
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
    });
  });
});
