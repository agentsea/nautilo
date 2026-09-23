/** Isolated because database/provider boundary mocks are process-global in Bun. */
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { ModelCatalogSchema } from "@nautilo/types";
import { resolveModelExecutionLimits } from "../../src/providers/models";
import { configureRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { estimateTokenCount } from "../../src/utils/history-manager";
import type { RecoverPreparedContext } from "../../src/utils/chat-model-invocation";

const FUNDING_HUMAN = "research-context-human";
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: mock(async (humanUserId: string) => {
    expect(humanUserId).toBe(FUNDING_HUMAN);
  }),
}));

const MODEL = "openai:gpt-5.6-sol";
const FALLBACK = "anthropic:claude-sonnet-4-6";
const rejected = new Error("context length exceeded");
let policy = { enabled: false, chain: [] as string[] };
let errors: unknown[] = [];
let streamAttempt: ((config: RunnableConfig | undefined, messages: BaseMessage[]) => Promise<void>) | undefined;
const attempts: Array<{ modelId: string; messages: BaseMessage[]; maxTokens: number }> = [];
const created: string[] = [];
const testEnv = { NAUTILO_TEST_MODE: "stub", OPENAI_API_KEY: "unit-test-openai", ANTHROPIC_API_KEY: "unit-test-anthropic" };
const priorEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
const priorFetch = globalThis.fetch;
let invocation: typeof import("../../src/utils/chat-model-invocation");

beforeAll(async () => {
  Object.assign(process.env, testEnv);
  globalThis.fetch = mock(async () => { throw new Error("network disabled"); }) as unknown as typeof fetch;
  mock.module("@nautilo/db", () => ({
    db: {}, profiles: {}, agents: {}, eq: () => ({}),
    getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {}, refreshServerModelConfigCache: async () => null,
    primeServerModelConfigCache: () => {},
  }));
  mock.module("../../src/utils/resolve-fallback-policy", () => ({ resolveFallbackPolicy: async () => policy }));
  mock.module("../../src/providers/universal", () => ({
    createUniversalModel: async (modelId: string, options: { maxTokens: number }) => {
      created.push(modelId);
      return { bindTools: () => ({ invoke: async (messages: BaseMessage[], config?: RunnableConfig) => {
        attempts.push({ modelId, messages, maxTokens: options.maxTokens });
        await streamAttempt?.(config, messages);
        if (errors.length) throw errors.shift();
        return new AIMessage("Recovered audit continues");
      } }) };
    },
  }));
  invocation = await import("../../src/utils/chat-model-invocation");
});
beforeEach(() => {
  resetRuntimeModelCatalog();
  policy = { enabled: false, chain: [] };
  errors = []; attempts.length = 0; created.length = 0; streamAttempt = undefined;
});
afterAll(() => {
  resetRuntimeModelCatalog();
  mock.restore(); globalThis.fetch = priorFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const run = (messages: BaseMessage[], recoverContext?: RecoverPreparedContext, signal?: AbortSignal) =>
  invocation.invokeChatModelWithFallback(messages, [], MODEL, "research-owner", null, null,
    signal ? { signal } : undefined, {
      fundingHumanUserId: FUNDING_HUMAN,
      modelFallbackMode: "none",
      ...(recoverContext ? { recoverContext } : {}),
    });

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected invocation to reject");
}

describe("D581 ordinary model context recovery", () => {
  test("local preflight fits the actual model before its first request and retains canonical input", async () => {
    const limits = await resolveModelExecutionLimits(MODEL);
    const original = [new SystemMessage("Keep the audit instructions"), new HumanMessage("x".repeat(limits.contextTokens * 4))];
    const saved = original[1]!.content;
    const recover = mock((input: Parameters<RecoverPreparedContext>[0]) => {
      expect(input.source).toBe("preflight");
      expect(input.modelId).toBe(MODEL);
      expect(input.contextWindowTokens).toBe(limits.contextTokens);
      expect(input.maxMessageTokens).toBeLessThan(limits.contextTokens);
      return [original[0]!, new HumanMessage("Recover retained historical pages")];
    });
    const result = await run(original, recover);
    expect(result.modelUsed).toBe(MODEL);
    expect(created).toEqual([MODEL]);
    expect(attempts).toHaveLength(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(original[1]!.content).toBe(saved);
  });

  test("provider context rejection retries smaller messages on the same exact model", async () => {
    errors = [rejected];
    const original = [new HumanMessage("Evidence and notes ".repeat(500))];
    const recover = mock((input: Parameters<RecoverPreparedContext>[0]) => {
      expect(input.source).toBe("provider");
      expect(input.estimatedMessageTokens).toBe(estimateTokenCount(original));
      return [new HumanMessage("Retained notes and historical recovery references")];
    });
    expect((await run(original, recover)).modelUsed).toBe(MODEL);
    expect(created).toEqual([MODEL, MODEL]);
    expect(estimateTokenCount(attempts[1]!.messages)).toBeLessThan(estimateTokenCount(attempts[0]!.messages));
    expect(attempts[1]!.maxTokens).toBeGreaterThanOrEqual(attempts[0]!.maxTokens);
  });

  test("repeated provider rejections continue only while context strictly shrinks", async () => {
    errors = [rejected, rejected, rejected];
    const lengths = [200, 20];
    const recover = mock((input: Parameters<RecoverPreparedContext>[0]) => {
      const length = lengths.shift();
      return length ? [new HumanMessage("x".repeat(length))] : input.messages;
    });
    expect(await rejectionOf(run([new HumanMessage("x".repeat(2_000))], recover))).toBe(rejected);
    expect(created).toEqual([MODEL, MODEL, MODEL]);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(attempts.map((attempt) => estimateTokenCount(attempt.messages))).toEqual([500, 50, 5]);
  });

  test("background visible text before TOKEN_LIMIT prevents recovery and preserves existing callbacks", async () => {
    errors = [rejected];
    const observed = mock(() => {});
    streamAttempt = async (config, messages) => {
      const [manager] = await CallbackManager.configure(config?.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["fixture"] }, [messages]);
      await manager!.handleLLMNewToken("Visible audit finding", undefined, undefined, undefined, undefined, {
        chunk: new ChatGenerationChunk({ text: "Visible audit finding", message: new AIMessageChunk("Visible audit finding") }),
      });
    };
    const recover = mock(() => [new HumanMessage("smaller")]);
    expect(await rejectionOf(invocation.invokeChatModelWithFallback([new HumanMessage("source ".repeat(100))], [], MODEL,
      "owner", null, null, { callbacks: [{ handleLLMNewToken: observed }] }, {
        fundingHumanUserId: FUNDING_HUMAN,
        recoverContext: recover,
        modelFallbackMode: "none",
      }))).toBe(rejected);
    expect(recover).not.toHaveBeenCalled();
    expect(created).toEqual([MODEL]);
    expect(observed).toHaveBeenCalledTimes(1);
    // A completed/failed earlier invocation cannot poison a fresh attempt.
    streamAttempt = undefined; errors = [rejected];
    expect((await run([new HumanMessage("source ".repeat(100))], recover)).modelUsed).toBe(MODEL);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("hidden reasoning and tool argument chunks do not count as visible output", async () => {
    errors = [rejected];
    streamAttempt = async (config, messages) => {
      const [manager] = await CallbackManager.configure(config?.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["fixture"] }, [messages]);
      for (const content of [[], [{ type: "reasoning", text: "private reasoning" }], [{ type: "thinking", thinking: "private thinking" }]]) {
        await manager!.handleLLMNewToken("private provider delta", undefined, undefined, undefined, undefined, {
          chunk: new ChatGenerationChunk({ text: "private provider delta", message: new AIMessageChunk({ content,
            additional_kwargs: { reasoning_content: "private reasoning" }, tool_call_chunks: [{ name: "file", args: "{", id: "read", index: 0 }] }) }),
        });
      }
      await manager!.handleChatModelStreamEvent({ event: "content-block-delta", index: 0, delta: { type: "reasoning-delta", reasoning: "private reasoning" } });
    };
    const recover = mock(() => [new HumanMessage("smaller")]);
    expect((await run([new HumanMessage("source ".repeat(100))], recover)).modelUsed).toBe(MODEL);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(created).toEqual([MODEL, MODEL]);
  });

  test("content-block visible text also fences background context recovery", async () => {
    errors = [rejected];
    streamAttempt = async (config, messages) => {
      const [manager] = await CallbackManager.configure(config?.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["fixture"] }, [messages]);
      await manager!.handleChatModelStreamEvent({ event: "content-block-delta", index: 0, delta: { type: "text-delta", text: "Visible finding" } });
    };
    const recover = mock(() => [new HumanMessage("smaller")]);
    expect(await rejectionOf(run([new HumanMessage("source ".repeat(100))], recover))).toBe(rejected);
    expect(recover).not.toHaveBeenCalled();
    expect(created).toEqual([MODEL]);
  });

  test("irreducible messages preserve the original preflight error without provider retries or chain hops", async () => {
    policy = { enabled: true, chain: [FALLBACK] };
    const limits = await resolveModelExecutionLimits(MODEL);
    const original = [new SystemMessage("x".repeat(limits.contextTokens * 4))];
    const recover = mock(({ messages }: Parameters<RecoverPreparedContext>[0]) => messages);
    expect(await rejectionOf(invocation.invokeChatModelWithFallback(original, [], MODEL, "owner", null, null,
      undefined, { fundingHumanUserId: FUNDING_HUMAN, recoverContext: recover }))).toBeInstanceOf(invocation.PreparedContextExceededError);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(created).toEqual([]);
  });

  test("an authorized smaller fallback recovers against that candidate's actual allowance", async () => {
    const baseline = getActiveModelCatalogSync().catalog;
    const catalog = ModelCatalogSchema.parse({ ...baseline, catalogVersion: "2026.09.07.1",
      entries: baseline.entries.filter((entry) => entry.id === MODEL || entry.id === FALLBACK).map((entry) => {
        if (!entry.limits) throw new Error("Fixture model must have catalog execution limits");
        return { ...entry, limits: entry.id === FALLBACK
          ? { contextTokens: 16_000, outputTokens: 4_000 } : entry.limits };
      }) });
    configureRuntimeModelCatalog({ loader: {
      get: async () => ({ catalog, source: "remote-fresh", stale: false,
        fetchedAt: "2026-09-07T00:00:00Z", originUrl: "https://media.nautilo.ai/models/latest.json",
        reason: "", catalogVersion: catalog.catalogVersion }),
      refresh: async () => {}, clearCache: () => {},
    } });
    await hydrateRuntimeModelCatalog();
    policy = { enabled: true, chain: [FALLBACK] };
    errors = [new Error("unsupported image")];
    const recover = mock((input: Parameters<RecoverPreparedContext>[0]) => {
      expect(input.modelId).toBe(FALLBACK);
      expect(input.source).toBe("preflight");
      expect(input.contextWindowTokens).toBe(16_000);
      return [new HumanMessage("Saved audit notes and exact historical references")];
    });
    const result = await invocation.invokeChatModelWithFallback([new HumanMessage("x".repeat(100_000))],
      [], MODEL, "owner", null, null, undefined, { fundingHumanUserId: FUNDING_HUMAN, recoverContext: recover });
    expect(result.modelUsed).toBe(FALLBACK);
    expect(created).toEqual([MODEL, FALLBACK]);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("ordinary callers without recovery retain their error behavior", async () => {
    errors = [rejected];
    expect(await rejectionOf(run([new HumanMessage("ordinary conversation")]))).toBe(rejected);
    expect(created).toEqual([MODEL]);
  });

  test("cancellation during recovery prevents another provider request", async () => {
    errors = [rejected];
    const controller = new AbortController();
    const cancelled = new Error("cancelled by owner");
    expect(await rejectionOf(run([new HumanMessage("x".repeat(1_000))], () => {
      controller.abort(cancelled);
      return [new HumanMessage("smaller")];
    }, controller.signal))).toBe(cancelled);
    expect(created).toEqual([MODEL]);
  });

  test("bound tool names, descriptions and schemas consume the actual completion allowance", async () => {
    const limits = await resolveModelExecutionLimits(MODEL);
    const bound = new DynamicStructuredTool({ name: "research_evidence", description: "description ".repeat(1_000),
      schema: z.object({ note: z.string().describe("schema context ".repeat(1_000)) }), func: async () => "ok" });
    const schemaTokens = invocation.estimateBoundToolTokens([bound]);
    expect(schemaTokens).toBeGreaterThan(Math.ceil(bound.description.length / 4));
    const messages = [new HumanMessage("x".repeat((limits.contextTokens - schemaTokens - 4_096 + 1) * 4))];
    expect(await invocation.resolveCompletionBudget(MODEL, messages)).toBeGreaterThan(0);
    expect(await rejectionOf(invocation.resolveCompletionBudget(MODEL, messages, [bound]))).toBeInstanceOf(invocation.PreparedContextExceededError);
  });
});
