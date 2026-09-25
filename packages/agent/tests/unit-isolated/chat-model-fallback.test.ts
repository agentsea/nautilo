/**
 * Lives in `tests/unit-isolated/` because it calls
 * `mock.module("@nautilo/db", …)` which persists for the lifetime of
 * the bun process and would otherwise break later test imports.
 */
/**
 * unit tests for `invokeChatModelWithFallback` with policy,
 * factory, model-health, provider, and database boundaries mocked.
 */

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChatModel } from "../../src/providers/types";
import type { ResolvedFallbackPolicy } from "../../src/utils/resolve-fallback-policy";
import { setAgentEventSink } from "../../src/runtime-hooks";
import { getOrCreateAgentTurnContextByKey, turnContextKey, _resetAgentTurnContextsForTests } from "../../src/runtime/turn-context";
import { ProviderTimeoutError } from "../../src/providers/errors";
import { isManagedGatewayOutcomeUnknownError } from "../../src/providers/openrouter-transport";
import type { ModelCatalog, ModelFallbackEvent, ServerEvent } from "@nautilo/types";
import { getCurrentTurnId, runWithTurn } from "@nautilo/logger";
import { classifyModelStreamProgress, resolveModelAttemptPolicy } from "../../src/utils/model-attempt-policy";
import { runWithTaskCausalHuman } from "../../src/runtime/causal-human-context";
import { getUsageContext } from "../../src/usage/usage-context";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";

const actualTrust = await import("@nautilo/trust");
const fundingAdmission = mock(async (_userId: string, _origin?: string) => undefined);
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: fundingAdmission,
}));

const A = "anthropic:claude-sonnet-4-6";
const B = "openai:gpt-5.5-2026-04-23";
const C = "google:gemini-2.5-pro";
const X = "openai:gpt-5.6-sol";
const G6 = "openai:gpt-6-astra";
const F = "fireworks:accounts/fireworks/models/deepseek-v4p1-flash";
// vision-skip tests — T1/T2 are real catalog IDs that
// `modelSupportsInput(_, "image")` returns false for (OpenRouter Kimi
// K2.6 and GLM 5.2 are text-only under the current signed catalog).
// V is vision-capable (Anthropic).
const T1 = "openrouter:moonshotai/kimi-k2.6";
const T2 = "openrouter:z-ai/glm-5.2";
const V = A;

const TOKEN_LIMIT_ERR = new Error("context length exceeded");

type AuraModel = ChatModel<BaseMessage, AIMessage>;

const createUniversalModelMock = mock(
  async (_modelId: string, _options?: Record<string, unknown>): Promise<AuraModel> => {
    throw new Error("createUniversalModelMock: not configured for this test");
  },
);
const markModelInvokeFailureMock = mock((_modelId: string, _message: string): void => {});

function modelIdsFromCalls(): string[] {
  return createUniversalModelMock.mock.calls.map((call) => String(call[0]));
}

function modelOptionsFromCalls(): Array<Record<string, unknown> | undefined> {
  return createUniversalModelMock.mock.calls.map((call) => call[1]);
}

let policyState: ResolvedFallbackPolicy = { enabled: false, chain: [] };

const TEST_PROVIDER_KEYS = {
  NAUTILO_TEST_MODE: "stub",
  ANTHROPIC_API_KEY: "test-anthropic",
  OPENAI_API_KEY: "test-openai",
  GOOGLE_API_KEY: "test-google",
  FIREWORKS_API_KEY: "test-fireworks",
  OPENROUTER_API_KEY: "test-openrouter",
} as const;
const priorProviderKeys = Object.fromEntries(
  [...Object.keys(TEST_PROVIDER_KEYS), "NAUTILO_MANAGED_GATEWAY_API_KEY", "NAUTILO_MANAGED_GATEWAY_BASE_URL"]
    .map((key) => [key, process.env[key]]),
);
const priorFetch = globalThis.fetch;

test("resolves each candidate's policy with explicit temporary or caller provenance", () => {
  const legacy = resolveModelAttemptPolicy(A);
  expect(legacy.modelId).toBe(A);
  expect(legacy.provenance.firstProgress.kind).toBe("temporary_legacy");
  expect(legacy.absoluteMs).toBeUndefined();
  const caller = resolveModelAttemptPolicy(B, { providerTimeoutMs: 12_345, callerSuppliedProviderTimeout: true });
  expect(caller.modelId).toBe(B);
  expect(caller.absoluteMs).toBe(12_345);
  expect(caller.provenance.absolute).toMatchObject({ kind: "caller_override", id: "invoke_options.providerTimeoutMs" });
  const firstOnly = resolveModelAttemptPolicy(A, { firstProgressTimeoutMs: 600_000 });
  expect(firstOnly.firstProgressMs).toBe(600_000);
  expect(firstOnly.progressIdleMs).toBe(legacy.progressIdleMs);
  expect(firstOnly.provenance.firstProgress).toMatchObject({ kind: "caller_override", id: "invoke_options.firstProgressTimeoutMs" });
  expect(firstOnly.provenance.progressIdle.kind).toBe("temporary_legacy");
  expect(firstOnly.absoluteMs).toBeUndefined();
  expect(resolveModelAttemptPolicy(A, { firstProgressTimeoutMs: 600_000, providerTimeoutMs: 42_000, callerSuppliedProviderTimeout: true }).absoluteMs).toBe(42_000);
});

test("normalizes only meaningful stream progress", () => {
  expect(classifyModelStreamProgress({ event: "on_chat_model_stream", data: { chunk: "visible" } }).meaningful).toBe(true);
  expect(classifyModelStreamProgress({ event: "on_chat_model_stream", data: { chunk: "" } }).meaningful).toBe(false);
  expect(classifyModelStreamProgress({ event: "on_chat_model_stream", data: { chunk: { usage_metadata: { output_tokens: 0 } } } }).meaningful).toBe(false);
  expect(classifyModelStreamProgress({ event: "on_chat_model_stream", data: { chunk: { tool_calls: [{ name: "repeated-aggregate" }] } } }).meaningful).toBe(false);
  expect(classifyModelStreamProgress({ event: "on_chat_model_stream", data: { chunk: { tool_call_chunks: [{ arguments: "{\"q\":\"x\"}" }] } } }).meaningful).toBe(true);
});

beforeAll(() => {
  Object.assign(process.env, TEST_PROVIDER_KEYS);
  globalThis.fetch = mock(async () => {
    throw new Error("network disabled in chat-model-fallback unit test");
  }) as unknown as typeof fetch;
  mock.module("@nautilo/db", () => ({
    db: {},
    profiles: {},
    agents: {},
    eq: () => ({}),
    getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {},
    refreshServerModelConfigCache: async () => null,
    primeServerModelConfigCache: () => {},
  }));

  mock.module("../../src/utils/resolve-fallback-policy", () => ({
    resolveFallbackPolicy: async () => policyState,
  }));

  mock.module("../../src/utils/model-health", () => ({
    isModelHealthy: () => true,
    markModelInvokeFailure: markModelInvokeFailureMock,
    clearHealthCache: () => {},
    checkModelHealth: async () => true,
    getHealthyModels: () => [],
  }));

  mock.module("../../src/providers/universal", () => ({
    createUniversalModel: (modelId: string, options?: Record<string, unknown>): Promise<AuraModel> =>
      createUniversalModelMock(modelId, options),
  }));
});

let invokeChatModelWithFallback: (
  messages: BaseMessage[],
  tools: StructuredTool[],
  initialModelId: string,
  userId: string,
  agentId: string | null,
  laneKey: string | null,
  invocationConfig?: RunnableConfig,
  invokeOptions?: {
    fundingHumanUserId?: string;
    reasoningOutput?: boolean;
    reasoningOverrides?: Record<string, boolean>;
    useOpenAIResponsesApi?: boolean;
    resolveForegroundControls?: (modelId: string) => { canonicalModelId: string; reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; servingProfileId?: string } | undefined;
    /** strict / no-chain mode suppresses every cross-model hop. */
    modelFallbackMode?: "agent_chain" | "none";
    sameModelRetryMode?: "none" | "short";
    providerTimeoutMs?: number;
    firstProgressTimeoutMs?: number;
    preparedStableSystemPrefixLength?: number;
    providerCacheRoomId?: string | null;
  },
) => Promise<{ response: AIMessage; modelUsed: string }>;

// captured `model.fallback` events for the per-test sink.
const capturedEvents: ServerEvent[] = [];

let _setFirstTokenTimeoutMsForTests: (ms: number | undefined) => void;
let isPreparedContextExceededError: (error: unknown) => boolean;

beforeAll(async () => {
  const mod = await import("../../src/utils/chat-model-invocation");
  invokeChatModelWithFallback = (messages, tools, initialModelId, userId, agentId, laneKey, invocationConfig, invokeOptions) =>
    mod.invokeChatModelWithFallback(messages, tools, initialModelId, userId, agentId, laneKey,
      invocationConfig, { fundingHumanUserId: userId, ...invokeOptions });
  _setFirstTokenTimeoutMsForTests = mod._setFirstTokenTimeoutMsForTests;
  isPreparedContextExceededError = mod.isPreparedContextExceededError;
  // Wire a capturing sink so emitAgentEvent fans out to capturedEvents.
  setAgentEventSink({ emit: (e) => capturedEvents.push(e) });
});

afterAll(() => {
  resetRuntimeModelCatalog();
  setAgentEventSink(null);
  mock.restore();
  globalThis.fetch = priorFetch;
  for (const [key, value] of Object.entries(priorProviderKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("invokeChatModelWithFallback (chain)", () => {
  const messages = [new HumanMessage("hi")];
  const tools: StructuredTool[] = [];

  beforeEach(() => {
    Object.assign(process.env, TEST_PROVIDER_KEYS);
    delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
    delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
    policyState = { enabled: false, chain: [] };
    createUniversalModelMock.mockReset();
    fundingAdmission.mockReset();
    fundingAdmission.mockImplementation(async () => undefined);
    markModelInvokeFailureMock.mockReset();
    capturedEvents.length = 0;
    _resetAgentTurnContextsForTests();
    _setFirstTokenTimeoutMsForTests(undefined);
  });

  test("revoked server funding stops a fallback before another provider is created", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => { throw TOKEN_LIMIT_ERR; } }),
    }) as unknown as AuraModel);
    fundingAdmission.mockImplementationOnce(async () => undefined);
    fundingAdmission.mockImplementationOnce(async () => {
      throw new actualTrust.ServerProviderCredentialsDeniedError("user-1", "chat_model");
    });

    const error = await invokeChatModelWithFallback(messages, tools, A, "owner-1", "agent-1", null,
      undefined, { fundingHumanUserId: "user-1" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(actualTrust.ServerProviderCredentialsDeniedError);
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(fundingAdmission).toHaveBeenCalledTimes(2);
    expect(fundingAdmission.mock.calls.map((call) => call[0])).toEqual(["user-1", "user-1"]);
  });

  test("an admitted legacy Task resume funds from its recorded requestor", async () => {
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => new AIMessage("ok") }),
    }) as unknown as AuraModel);
    await runWithTaskCausalHuman("task-requestor", () => invokeChatModelWithFallback(
      messages, tools, A, "agent-owner", "agent-1", null, undefined,
      { fundingHumanUserId: "" },
    ));
    expect(fundingAdmission.mock.calls[0]?.[0]).toBe("task-requestor");
  });

  test("missing causal Human returns a typed denial before capability lookup or model dispatch", async () => {
    const error = await invokeChatModelWithFallback(messages, tools, A, "owner-1", "agent-1", null,
      undefined, { fundingHumanUserId: "" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(actualTrust.ServerProviderCredentialsDeniedError);
    expect(error).toMatchObject({ code: "server_provider_credentials_required", humanUserId: "" });
    expect(fundingAdmission).not.toHaveBeenCalled();
    expect(createUniversalModelMock).not.toHaveBeenCalled();
  });

  test.each([
    ["401", Object.assign(new Error("gateway private 401 canary"), { status: 401 })],
    ["402", Object.assign(new Error("gateway private 402 canary"), { status: 402 })],
    ["429", Object.assign(new Error("gateway private 429 canary"), { status: 429 })],
    ["502", Object.assign(new Error("gateway private 502 canary"), { status: 502 })],
    ["timeout", new ProviderTimeoutError(T1, 25)],
  ])("managed Gateway %s performs one invocation with no same-model retry or fallback hop", async (_kind, failure) => {
    process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = `ngw_${"a".repeat(43)}`;
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = "https://gateway.qa.example/v1";
    policyState = { enabled: true, chain: [T1, A, B] };
    let invokes = 0;
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(T1);
      return {
        bindTools: () => ({
          invoke: async () => {
            invokes += 1;
            throw failure;
          },
        }),
      } as unknown as AuraModel;
    });

    const thrown: unknown = await invokeChatModelWithFallback(
      messages,
      tools,
      T1,
      "user-1",
      "agent-1",
      null,
    ).catch((error: unknown) => error);

    expect(isManagedGatewayOutcomeUnknownError(thrown)).toBeTrue();
    expect((thrown as Error).message).toBe(failure.message);
    if ("status" in failure) {
      expect((thrown as { status?: number }).status).toBe(failure.status);
    }
    expect(invokes).toBe(1);
    expect(modelIdsFromCalls()).toEqual([T1]);
    expect(capturedEvents.filter((event) => event.type === "model.fallback")).toHaveLength(0);
  });

  test("unavailable selected model uses only an already-configured eligible fallback", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => new AIMessage(`from-${modelId}`) }),
    }) as unknown as AuraModel);

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);

    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([B]);
  });

  test("1. enabled false + primary errors → no fallback; single factory model", async () => {
    policyState = { enabled: false, chain: [B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw TOKEN_LIMIT_ERR;
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/context length exceeded/);

    expect(createUniversalModelMock).toHaveBeenCalledTimes(1);
    expect(modelIdsFromCalls()).toEqual([A]);
  });

  test("2. enabled true + empty chain + primary errors → no fallback", async () => {
    policyState = { enabled: true, chain: [] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw TOKEN_LIMIT_ERR;
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/context length exceeded/);

    expect(createUniversalModelMock).toHaveBeenCalledTimes(1);
    expect(modelIdsFromCalls()).toEqual([A]);
  });

  test("projects independent provider-native cache controls only onto their actual routes", async () => {
    const stable = "stable system and selected tool guidance";
    const prepared = [
      new SystemMessage(`${stable}\nvolatile Memory and message context`),
      new HumanMessage("hello"),
    ];
    const roomId = "22222222-2222-4222-8222-222222222222";
    const invokedMessages: BaseMessage[][] = [];
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({
        invoke: async (attemptMessages: BaseMessage[]) => {
          invokedMessages.push(attemptMessages);
          return new AIMessage("ok");
        },
      }),
    }) as unknown as AuraModel);

    await invokeChatModelWithFallback(
      prepared,
      tools,
      X,
      "user-1",
      "agent-1",
      `room:${roomId}`,
      undefined,
      {
        useOpenAIResponsesApi: true,
        preparedStableSystemPrefixLength: stable.length,
        providerCacheRoomId: roomId,
      },
    );
    expect(modelOptionsFromCalls()[0]).toMatchObject({
      openAIExplicitPromptCache: true,
    });
    expect(modelOptionsFromCalls()[0]).not.toHaveProperty("openRouterSessionId");
    expect(invokedMessages[0]?.[0]?.content).toEqual([
      {
        type: "input_text",
        text: stable,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
      { type: "input_text", text: "\nvolatile Memory and message context" },
    ]);

    createUniversalModelMock.mockClear();
    invokedMessages.length = 0;
    await invokeChatModelWithFallback(
      prepared,
      tools,
      T1,
      "user-1",
      "agent-1",
      `room:${roomId}`,
      undefined,
      {
        useOpenAIResponsesApi: true,
        preparedStableSystemPrefixLength: stable.length,
        providerCacheRoomId: roomId,
      },
    );
    expect(modelOptionsFromCalls()[0]).toMatchObject({
      openRouterSessionId: roomId,
    });
    expect(modelOptionsFromCalls()[0]).not.toHaveProperty("openAIExplicitPromptCache");
    expect(invokedMessages[0]?.[0]?.content).toBe(`${stable}\nvolatile Memory and message context`);

    createUniversalModelMock.mockClear();
    invokedMessages.length = 0;
    await invokeChatModelWithFallback(
      prepared,
      tools,
      F,
      "user-1",
      "agent-1",
      `room:${roomId}`,
      undefined,
      {
        useOpenAIResponsesApi: true,
        preparedStableSystemPrefixLength: stable.length,
        providerCacheRoomId: roomId,
      },
    );
    expect(modelOptionsFromCalls()[0]).toMatchObject({
      fireworksSessionAffinityId: roomId,
    });
    expect(modelOptionsFromCalls()[0]).not.toHaveProperty("openAIExplicitPromptCache");
    expect(modelOptionsFromCalls()[0]).not.toHaveProperty("openRouterSessionId");
    expect(invokedMessages[0]?.[0]?.content).toBe(`${stable}\nvolatile Memory and message context`);
  });

  test("3. chain [A,B,C], request A, A errors → B succeeds; A attempted once", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(B);
    expect(out.response).toBeInstanceOf(AIMessage);
    expect(modelIdsFromCalls()).toEqual([A, B]);
  });

  test("4. chain [A,B,C], A and B error → C succeeds", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A || modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === C) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-C"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(C);
    expect(modelIdsFromCalls()).toEqual([A, B, C]);
  });

  test("5. chain [A,B,C], all error → last error (from C) propagates", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> =>
      ({
        bindTools: () => ({
          invoke: async () => {
            throw new Error(`context length exceeded (${modelId})`);
          },
        }),
      }) as unknown as AuraModel,
    );

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/context length exceeded \(google:gemini-2\.5-pro\)/);

    expect(modelIdsFromCalls()).toEqual([A, B, C]);
  });

  test("6. chain [A,B,C], request X not in chain, X errors → implicit-head walks to chain[0]=A, then B succeeds", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === X || modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, X, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(B);
    // X is attempt #1 (selected). X fails → implicit-head walks the
    // full user chain from index 0: A (fails) → B (succeeds). X is never
    // re-attempted because it is not a chain entry; A and B are walked
    // in chain order.
    expect(modelIdsFromCalls()).toEqual([X, A, B]);
  });

  test("7. effective policy [A,B] (per-agent beats user [A,C,D]) → next is B not C", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId} — would be C if user chain leaked`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([A, B]);
  });

  test("OpenAI fallback hop receives Responses opt-in when reasoning is enabled", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(
      messages,
      tools,
      A,
      "user-1",
      "agent-1",
      null,
      undefined,
      { reasoningOverrides: {}, useOpenAIResponsesApi: true },
    );

    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([A, B]);
    const options = modelOptionsFromCalls();
    expect(options).toHaveLength(2);
    expect(options[0]?.["reasoningOutput"]).toBe(true);
    expect(options[0]?.["useOpenAIResponsesApi"]).toBe(true);
    expect(options[1]?.["reasoningOutput"]).toBe(true);
    expect(options[1]?.["useOpenAIResponsesApi"]).toBe(true);
  });

  test("per-model reasoning override false disables OpenAI Responses eligibility on fallback hop", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(
      messages,
      tools,
      A,
      "user-1",
      "agent-1",
      null,
      undefined,
      {
        reasoningOverrides: { [B]: false },
        useOpenAIResponsesApi: true,
      },
    );

    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([A, B]);
    const options = modelOptionsFromCalls();
    expect(options[0]?.["reasoningOutput"]).toBe(true);
    expect(options[1]?.["reasoningOutput"]).toBe(false);
    expect(options[1]?.["useOpenAIResponsesApi"]).toBe(true);
  });

  test("direct GPT-6 Responses reports the sent default or explicit effort with output hidden", async () => {
    const observed: Array<NonNullable<ReturnType<typeof getUsageContext>>["modelControl"]> = [];
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => {
        observed.push(getUsageContext()?.modelControl);
        return new AIMessage("ok");
      } }),
    }) as unknown as AuraModel);

    await invokeChatModelWithFallback(messages, tools, G6, "user-1", "agent-1", null, undefined, {
      modelFallbackMode: "none", sameModelRetryMode: "none",
      useOpenAIResponsesApi: true, reasoningOutput: false,
    });
    await invokeChatModelWithFallback(messages, tools, G6, "user-1", "agent-1", null, undefined, {
      modelFallbackMode: "none", sameModelRetryMode: "none",
      useOpenAIResponsesApi: true, reasoningOutput: false,
      resolveForegroundControls: (modelId) => ({ canonicalModelId: modelId, reasoningEffort: "high" }),
    });

    expect(modelOptionsFromCalls()).toMatchObject([
      { useOpenAIResponsesApi: true, reasoningOutput: false },
      { useOpenAIResponsesApi: true, reasoningOutput: false, reasoningEffort: "high" },
    ]);
    expect(observed).toEqual([
      { canonicalModelId: G6, effectiveModelId: G6, effectiveReasoningEffort: "medium" },
      { canonicalModelId: G6, effectiveModelId: G6, requestedReasoningEffort: "high", effectiveReasoningEffort: "high" },
    ]);
  });

  test("direct GPT-6 Responses reasoning rejection does not retry with reasoning disabled", async () => {
    const rejection = Object.assign(new Error("Invalid request: unsupported reasoning_effort"), { status: 400 });
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => { throw rejection; } }),
    }) as unknown as AuraModel);

    const thrown = await invokeChatModelWithFallback(messages, tools, G6, "user-1", "agent-1", null, undefined, {
      modelFallbackMode: "none", sameModelRetryMode: "none",
      useOpenAIResponsesApi: true, reasoningOutput: false,
    }).catch((error: unknown) => error);

    expect(thrown).toBe(rejection);
    expect(modelIdsFromCalls()).toEqual([G6]);
    expect(modelOptionsFromCalls()[0]?.["useOpenAIResponsesApi"]).toBe(true);
  });

  test("configured fallback recomputes direct GPT-6 Responses options in both directions", async () => {
    for (const chain of [[A, G6], [G6, A]] as const) {
      policyState = { enabled: true, chain: [...chain] };
      createUniversalModelMock.mockReset();
      createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => ({
        bindTools: () => ({ invoke: async () => {
          if (modelId === chain[0]) throw TOKEN_LIMIT_ERR;
          return new AIMessage("fallback-ok");
        } }),
      }) as unknown as AuraModel);
      const out = await invokeChatModelWithFallback(messages, tools, chain[0], "user-1", "agent-1", null, undefined, {
        useOpenAIResponsesApi: true, reasoningOutput: false,
        sameModelRetryMode: "none",
      });
      expect(out.modelUsed).toBe(chain[1]);
      expect(modelIdsFromCalls()).toEqual([...chain]);
      expect(modelOptionsFromCalls()).toMatchObject([
        { useOpenAIResponsesApi: true, reasoningOutput: false },
        { useOpenAIResponsesApi: true, reasoningOutput: false },
      ]);
    }
  });

  // hop event emission (privacy posture verified inline).

  const ROOM_LANE = "room:11111111-1111-4111-8111-111111111111";

  test("P3.1: chain hop emits model.fallback event with from/to/reason matching the failure category", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", ROOM_LANE);

    const hops = capturedEvents.filter(
      (e): e is ModelFallbackEvent => e.type === "model.fallback",
    );
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({
      type: "model.fallback",
      laneKey: ROOM_LANE,
      from: A,
      to: B,
      reason: "context_exceeded",
    });
    // turnId is whatever AsyncLocalStorage returns; in tests with no
    // runWithTurn wrap it falls through to "" — assertion is that the
    // field exists as a string, not a specific value.
    expect(typeof hops[0]?.turnId).toBe("string");
  });

  test("P3.2: chain A→B→C with two errors emits two hop events in order", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A || modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === C) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-C"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", ROOM_LANE);

    const hops = capturedEvents.filter(
      (e): e is ModelFallbackEvent => e.type === "model.fallback",
    );
    expect(hops).toHaveLength(2);
    expect(hops[0]).toMatchObject({ from: A, to: B, reason: "context_exceeded" });
    expect(hops[1]).toMatchObject({ from: B, to: C, reason: "context_exceeded" });
  });

  test("P3.3: enabled=false + primary errors → zero hop events", async () => {
    policyState = { enabled: false, chain: [B, C] };
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => {
      return {
        bindTools: () => ({
          invoke: async () => {
            throw TOKEN_LIMIT_ERR;
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", ROOM_LANE);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);

    const hops = capturedEvents.filter((e) => e.type === "model.fallback");
    expect(hops).toHaveLength(0);
  });

  test("P3.4: laneKey null (system tasks / no room context) → no hop events emitted even when chain walks", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      return {
        bindTools: () => ({
          invoke: async () => new AIMessage("from-B"),
        }),
      } as unknown as AuraModel;
    });

    // Confirm the chain DID walk (modelUsed === B) so the lack of
    // hops below is from laneKey gating, not from chain not firing.
    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(B);

    const hops = capturedEvents.filter((e) => e.type === "model.fallback");
    expect(hops).toHaveLength(0);
  });

  test("P3.5: PRIVACY — hop event carries zero echoed user content", async () => {
    // Drive an error whose message would expose user prompt content.
    // The hop event MUST NOT contain it.
    const PROMPT_LEAK = "ECHO_OF_USER_PROMPT_THAT_MUST_NOT_LEAK_VIA_HOP_EVENT";
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw new Error(`context length exceeded — prompt was: ${PROMPT_LEAK}`);
            },
          }),
        } as unknown as AuraModel;
      }
      return {
        bindTools: () => ({
          invoke: async () => new AIMessage("from-B"),
        }),
      } as unknown as AuraModel;
    });

    await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", ROOM_LANE);

    const hops = capturedEvents.filter(
      (e): e is ModelFallbackEvent => e.type === "model.fallback",
    );
    expect(hops).toHaveLength(1);
    const serialized = JSON.stringify(hops[0]);
    expect(serialized).not.toContain(PROMPT_LEAK);
    expect(serialized).not.toContain("context length exceeded");
    // The hop event's surface is purely categorical:
    expect(Object.keys(hops[0] ?? {}).sort()).toEqual(
      ["from", "laneKey", "reason", "to", "turnId", "type"].sort(),
    );
  });

  // automatic fallback only before assistant-visible output.

  const TURN = "turn-visible-output-fallback-gate";

  test("zero visible output — timeout on primary still falls back", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw new ProviderTimeoutError(A, 60_000);
            },
          }),
        } as unknown as AuraModel;
      }
      return {
        bindTools: () => ({
          invoke: async () => new AIMessage("from-B"),
        }),
      } as unknown as AuraModel;
    });

    const out = await runWithTurn(TURN, () =>
      invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null),
    );
    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([A, B]);
  });

  test("after visible output — timeout does not walk to next model", async () => {
    policyState = { enabled: true, chain: [A, B] };
    // visible output is read from the per-agent slot
    // (`turnContextKey(humanTurnId, agentId)`), so seed it there.
    getOrCreateAgentTurnContextByKey(turnContextKey(TURN, "agent-1")).assistantVisibleOutput = true;

    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw new ProviderTimeoutError(A, 60_000);
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await runWithTurn(TURN, () =>
        invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderTimeoutError);
    expect(modelIdsFromCalls()).toEqual([A]);
    const hops = capturedEvents.filter((e) => e.type === "model.fallback");
    expect(hops).toHaveLength(0);
  });

  test("stream chunks on turn context prevent first-token cutoff; invoke completes on primary", async () => {
    _setFirstTokenTimeoutMsForTests(80);
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId !== A) throw new Error(`unexpected model ${modelId}`);
      return {
        bindTools: () => ({
          invoke: async (_messages: BaseMessage[], options?: RunnableConfig) => {
            const turnId = getCurrentTurnId();
            const attemptId = options?.metadata?.["model_attempt_id"];
            for (let i = 0; i < 12; i++) {
              if (turnId && typeof attemptId === "string") {
                getOrCreateAgentTurnContextByKey(turnContextKey(turnId, "agent-1"))
                  .modelAttemptProgressSink?.reportMeaningfulProgress(attemptId);
              }
              await new Promise((r) => setTimeout(r, 15));
            }
            return new AIMessage("from-A-long-stream");
          },
        }),
      } as unknown as AuraModel;
    });

    const out = await runWithTurn(TURN, () =>
      invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null),
    );
    expect(out.modelUsed).toBe(A);
    expect(modelIdsFromCalls()).toEqual([A]);
  });

  test("a synchronous provider throw clears its bound attempt sink", async () => {
    const syncFailure = new Error("synchronous provider failure");
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({
      bindTools: () => ({
        invoke: () => { throw syncFailure; },
      }),
    }) as unknown as AuraModel);

    let thrown: unknown;
    try {
      await runWithTurn(TURN, () =>
        invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(syncFailure);
    expect(getOrCreateAgentTurnContextByKey(turnContextKey(TURN, "agent-1")).modelAttemptProgressSink).toBeUndefined();
  });

  test("every same-model retry and fallback invocation gets a distinct exact attempt ID", async () => {
    policyState = { enabled: true, chain: [A, B] };
    const attempts: Array<{ modelId: string; attemptId: unknown }> = [];
    let aCalls = 0;
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => ({
      bindTools: () => ({
        invoke: async (_messages: BaseMessage[], options?: RunnableConfig) => {
          const metadata = options?.metadata;
          attempts.push({
            modelId: typeof metadata?.["model_id"] === "string" ? metadata["model_id"] : "",
            attemptId: metadata?.["model_attempt_id"],
          });
          if (modelId === A) {
            aCalls += 1;
            if (aCalls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
            throw new ProviderTimeoutError(A, 60_000);
          }
          return new AIMessage("from-B");
        },
      }),
    }) as unknown as AuraModel);

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(B);
    expect(attempts.map((attempt) => attempt.modelId)).toEqual([A, A, B]);
    expect(attempts.every((attempt) => typeof attempt.attemptId === "string" && attempt.attemptId.length > 0)).toBe(true);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(3);
  });

  // implicit-head — the selected model is always attempt #1; a
  // recoverable failure walks the FULL user chain from the top even
  // when the selected model isn't a member of the chain. Dedupe guards
  // against re-attempting the originally-selected model during the walk.

  const IMAGE_MESSAGES = [
    new HumanMessage({
      content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    }),
  ];

  test("selected not in chain + recoverable error → walk advances to chain[0] and onward; model.fallback hop fires", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === X || modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, X, "user-1", "agent-1", ROOM_LANE);
    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([X, A, B]);

    // The first hop (X → A) is the implicit-head hop: from an
    // out-of-chain selected model to chain[0]. Assert it surfaces as a
    // model.fallback event so the workbench can render the notice.
    const hops = capturedEvents.filter(
      (e): e is ModelFallbackEvent => e.type === "model.fallback",
    );
    expect(hops).toHaveLength(2);
    expect(hops[0]).toMatchObject({ from: X, to: A, reason: "context_exceeded" });
    expect(hops[1]).toMatchObject({ from: A, to: B, reason: "context_exceeded" });
  });

  test("selected appears in chain → not re-attempted (dedupe guard fires on duplicate chain entry)", async () => {
    // Chain has A twice. Selected A fails → walk forward. Without the
    // dedupe guard, the second A (at index 2) would be
    // re-attempted. With it, we skip to C.
    policyState = { enabled: true, chain: [A, B, A, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A || modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === C) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-C"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(C);
    // A is attempted exactly once (attempt #1); the second A in the
    // chain is skipped by the dedupe guard; B and C are walked in order.
    expect(modelIdsFromCalls()).toEqual([A, B, C]);
  });

  test("enabled=false AND empty-chain → no fallback (unchanged)", async () => {
    // Combined guard: both disable conditions collapse to undefined.
    policyState = { enabled: false, chain: [] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(X);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw TOKEN_LIMIT_ERR;
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, X, "user-1", "agent-1", null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/context length exceeded/);
    expect(modelIdsFromCalls()).toEqual([X]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("vision thread, head IN chain → text-only chain entries skipped, vision-capable head reached", async () => {
    // Selected T1 (text-only) IS in the chain at index 0. Thread has
    // images → vision-skip preflight fires for T1 → walk from idx+1=1.
    // T2 at index 1 is text-only → skipped by the vision guard. V at
    // index 2 is vision-capable → used.
    policyState = { enabled: true, chain: [T1, T2, V] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === T1) {
        // Should never be invoked — vision-skip preflight hops away
        // before calling createUniversalModel.
        return {
          bindTools: () => ({
            invoke: async () => {
              throw new Error(`unexpected invoke of text-only ${modelId}`);
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === V) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-V"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(IMAGE_MESSAGES, tools, T1, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(V);
    // T1 is never constructed (vision-skip preflight hops before
    // createUniversalModel); T2 is skipped silently by the vision
    // guard; only V is constructed.
    expect(modelIdsFromCalls()).toEqual([V]);
  });

  test("vision thread, head OUT of chain → implicit-head walk skips text-only chain entries, reaches vision-capable one", async () => {
    // Selected T1 (text-only) is NOT in the chain. Thread has images →
    // vision-skip preflight fires for T1 → implicit-head starts
    // the walk at chain[0]. T2 at index 0 is text-only → skipped by
    // the vision guard. V at index 1 is vision-capable → used.
    policyState = { enabled: true, chain: [T2, V] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === T1) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw new Error(`unexpected invoke of text-only ${modelId}`);
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === V) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-V"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(IMAGE_MESSAGES, tools, T1, "user-1", "agent-1", null);
    expect(out.modelUsed).toBe(V);
    expect(modelIdsFromCalls()).toEqual([V]);
  });
});

// strict / no-chain mode. An exact Task `model_id` pin MUST NOT
// silently execute another model. `modelFallbackMode: "none"` suppresses every
// cross-model hop (provider error, context preflight, vision incompatibility,
// capability error) while preserving bounded same-model short retries.
// Foreground / non-exact callers stay on `"agent_chain"` (default) and retain
// the existing fallback chain — covered by regression tests below.
describe("invokeChatModelWithFallback — strict mode", () => {
  const messages = [new HumanMessage("hi")];
  const tools: StructuredTool[] = [];
  // vision-skip path: T1 is text-only (real catalog capability); an
  // image-bearing thread triggers the vision-skip preflight.
  const IMAGE_MESSAGES = [
    new HumanMessage({
      content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    }),
  ];
  const ROOM_LANE = "room:22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    policyState = { enabled: false, chain: [] };
    createUniversalModelMock.mockReset();
    capturedEvents.length = 0;
    _resetAgentTurnContextsForTests();
    _setFirstTokenTimeoutMsForTests(undefined);
  });

  test("strict: provider failure on X never attempts Y; original error propagates", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw TOKEN_LIMIT_ERR;
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
        modelFallbackMode: "none",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/context length exceeded/);

    // Only X (A) was constructed; Y (B/C) never were. No hop event emitted.
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("strict: context-too-large preflight on X never attempts Y; PreparedContextExceededError propagates", async () => {
    // T1's real catalog context window is 262_144 tokens. A message whose
    // estimated input tokens exceed (context - safety margin) triggers the
    // preflight PreparedContextExceededError before any model is constructed.
    policyState = { enabled: true, chain: [T1, V] };
    // ~1.1M chars → ~275K estimated tokens > 262_144 - 4_096 → preflight throws.
    const big = "x".repeat(1_100_000);
    const bigMessages = [new HumanMessage(big)];
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => {
      throw new Error(`unexpected factory call in strict preflight mode`);
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(bigMessages, tools, T1, "user-1", "agent-1", null, undefined, {
        modelFallbackMode: "none",
      });
    } catch (e) {
      thrown = e;
    }
    expect(isPreparedContextExceededError(thrown)).toBe(true);
    // No model was constructed (preflight hops before createUniversalModel),
    // and strict mode refused the chain hop.
    expect(modelIdsFromCalls()).toEqual([]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("strict: vision mismatch never attempts Y; no vision-capable hop", async () => {
    // T1 is text-only (real catalog capability). Thread has images → vision-
    // availability preflight fires → strict mode refuses the chain hop and
    // returns the typed capability reason before constructing any model.
    policyState = { enabled: true, chain: [T1, V] };
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => {
      throw new Error(`unexpected factory call in strict vision mode`);
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(IMAGE_MESSAGES, tools, T1, "user-1", "agent-1", null, undefined, {
        modelFallbackMode: "none",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/does not accept image input/);
    expect(modelIdsFromCalls()).toEqual([]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("strict: capability error on X never attempts Y", async () => {
    policyState = { enabled: true, chain: [A, B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            throw new Error("400 This model does not support image inputs");
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
        modelFallbackMode: "none",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/does not support image inputs/);
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("strict: bounded same-model short retries are preserved (X retried, not hopped to Y)", async () => {
    // A retryable 429 on the first invoke is retried against the SAME model
    // (invokeOnceWithShortRetries), which then succeeds. Strict mode must
    // not widen this into a hop to B.
    policyState = { enabled: true, chain: [A, B] };
    let aInvokes = 0;
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            aInvokes++;
            if (aInvokes === 1) {
              throw Object.assign(new Error("rate limited"), { status: 429 });
            }
            return new AIMessage("from-A-after-retry");
          },
        }),
      } as unknown as AuraModel;
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
      modelFallbackMode: "none",
    });
    expect(out.modelUsed).toBe(A);
    expect(aInvokes).toBe(2);
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("caller cancellation is never retried, cooled down, or widened into fallback", async () => {
    policyState = { enabled: true, chain: [A, B] };
    const parent = new AbortController();
    let invokes = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async (_messages: BaseMessage[], config?: RunnableConfig) => {
            invokes += 1;
            markStarted();
            return await new Promise<never>((_, reject) => {
              config?.signal?.addEventListener("abort", () => {
                reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
              }, { once: true });
            });
          },
        }),
      } as unknown as AuraModel;
    });

    const pending = invokeChatModelWithFallback(
      messages,
      tools,
      A,
      "user-1",
      "agent-1",
      null,
      { signal: parent.signal },
    );
    await started;
    const cancellation = new Error("job cancelled by user");
    parent.abort(cancellation);

    await pending.then(
      () => { throw new Error("expected cancellation"); },
      (error) => expect(error).toBe(cancellation),
    );
    expect(invokes).toBe(1);
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(markModelInvokeFailureMock).not.toHaveBeenCalled();
    expect(capturedEvents.filter((event) => event.type === "model.fallback")).toHaveLength(0);
  });

  test("durable background policy uses one exact attempt with its own provider deadline", async () => {
    policyState = { enabled: true, chain: [A, B] };
    let invokes = 0;
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            invokes += 1;
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(
        messages,
        tools,
        A,
        "user-1",
        "agent-1",
        null,
        undefined,
        {
          modelFallbackMode: "none",
          sameModelRetryMode: "none",
          providerTimeoutMs: 20_000,
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("rate limited");
    expect(invokes).toBe(1);
    expect(modelIdsFromCalls()).toEqual([A]);
    // The explicit caller deadline is owned by the Agent supervisor, not the
    // provider constructor's unrelated local 120s/default timer.
    expect(modelOptionsFromCalls()[0]?.["timeoutMs"]).toBeNull();
  });

  test("first-progress override permits delayed success, preserves idle timeout and cleans up cancellation without a second request", async () => {
    for (const outcome of ["delayed-success", "first-timeout", "idle-timeout", "parent-abort", "absolute-timeout"] as const) {
      createUniversalModelMock.mockReset();
      capturedEvents.length = 0;
      _resetAgentTurnContextsForTests();
      policyState = { enabled: true, chain: [A, B] };
      const legacy = resolveModelAttemptPolicy(A);
      const firstProgressTimeoutMs = legacy.firstProgressMs + legacy.progressIdleMs;
      let now = 0;
      let nextTimer = 0;
      const timers = new Map<number, { due: number; callback: () => void }>();
      const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms = 0) => {
        const id = ++nextTimer;
        timers.set(id, { due: now + ms, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(((id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
      }) as typeof clearTimeout);
      const advance = (ms: number) => {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
      };
      const parent = new AbortController();
      let begin!: () => void;
      const started = new Promise<void>((resolve) => { begin = resolve; });
      let finish!: (value: AIMessage) => void;
      let progress!: () => void;
      let providerSignal: AbortSignal | undefined;
      let invokes = 0;
      createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
        invoke: (_messages: BaseMessage[], options?: RunnableConfig) => {
          invokes++;
          providerSignal = options?.signal;
          const attemptId = options?.metadata?.["model_attempt_id"];
          progress = () => {
            expect(typeof attemptId).toBe("string");
            getOrCreateAgentTurnContextByKey(turnContextKey("first-progress-policy", "agent-1"))
              .modelAttemptProgressSink?.reportMeaningfulProgress(attemptId as string);
          };
          begin();
          return new Promise<AIMessage>((resolve, reject) => {
            finish = resolve;
            options?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
          });
        },
      }) }) as unknown as AuraModel);
      try {
        const pending = runWithTurn("first-progress-policy", () => invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null,
          { signal: parent.signal }, { firstProgressTimeoutMs, modelFallbackMode: "none", sameModelRetryMode: "none",
            ...(outcome === "absolute-timeout" ? { providerTimeoutMs: legacy.firstProgressMs / 2 } : {}) })).catch((error: unknown) => error);
        await started;
        expect([...timers.values()].map((timer) => timer.due).sort((a, b) => a - b)).toEqual(outcome === "absolute-timeout"
          ? [legacy.firstProgressMs / 2, firstProgressTimeoutMs] : [firstProgressTimeoutMs]);
        if (outcome !== "absolute-timeout") {
          advance(legacy.firstProgressMs + 1);
          expect(providerSignal?.aborted).toBe(false);
        }
        const cancellation = new Error("owner paused research");
        if (outcome === "delayed-success") finish(new AIMessage("delayed primary result"));
        else if (outcome === "parent-abort") parent.abort(cancellation);
        else if (outcome === "first-timeout") advance(firstProgressTimeoutMs);
        else if (outcome === "absolute-timeout") advance(legacy.firstProgressMs / 2);
        else {
          progress();
          expect([...timers.values()].map((timer) => timer.due - now)).toEqual([legacy.progressIdleMs]);
          advance(legacy.progressIdleMs);
        }
        const result = await pending;
        if (outcome === "delayed-success") expect(result).toMatchObject({ modelUsed: A, response: { content: "delayed primary result" } });
        else if (outcome === "parent-abort") expect(result).toBe(cancellation);
        else expect(result).toMatchObject({ details: { kind: outcome === "idle-timeout" ? "progress_idle_timeout" : outcome === "absolute-timeout" ? "absolute_timeout" : "first_progress_timeout",
          policyProvenance: { firstProgress: { kind: "caller_override" }, progressIdle: { kind: "temporary_legacy" } } } });
        expect(invokes).toBe(1);
        expect(modelIdsFromCalls()).toEqual([A]);
        expect(capturedEvents.filter((event) => event.type === "model.fallback")).toHaveLength(0);
        expect(timers.size).toBe(0);
        expect(getOrCreateAgentTurnContextByKey(turnContextKey("first-progress-policy", "agent-1")).modelAttemptProgressSink).toBeUndefined();
      } finally { parent.abort(); setTimer.mockRestore(); clearTimer.mockRestore(); }
    }
  });

  test("invalid first-progress overrides and already-aborted calls never invoke a provider", async () => {
    for (const firstProgressTimeoutMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const error: unknown = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined,
        { firstProgressTimeoutMs }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RangeError);
    }
    const parent = new AbortController();
    const reason = new Error("already cancelled");
    parent.abort(reason);
    const error: unknown = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, { signal: parent.signal },
      { firstProgressTimeoutMs: 600_000, modelFallbackMode: "none" }).catch((caught: unknown) => caught);
    expect(error).toBe(reason);
    expect(createUniversalModelMock).not.toHaveBeenCalled();
  });

  test("strict: exhausting same-model retries does NOT widen to chain (X only, then throw)", async () => {
    // Both same-model attempts fail with 429. Strict mode must NOT hop to B;
    // the rate-limit error propagates after the bounded retry is exhausted.
    policyState = { enabled: true, chain: [A, B] };
    let aInvokes = 0;
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      expect(modelId).toBe(A);
      return {
        bindTools: () => ({
          invoke: async () => {
            aInvokes++;
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        }),
      } as unknown as AuraModel;
    });

    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
        modelFallbackMode: "none",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Both bounded same-model attempts fired; no hop to B.
    expect(aInvokes).toBe(2);
    expect(modelIdsFromCalls()).toEqual([A]);
    expect(capturedEvents.filter((e) => e.type === "model.fallback")).toHaveLength(0);
  });

  test("regression: default (omitted) mode preserves normal fallback A→B with hop event", async () => {
    // Foreground / non-exact callers omit modelFallbackMode → default
    // "agent_chain" → existing fallback behavior is unchanged.
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-B"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", ROOM_LANE);
    expect(out.modelUsed).toBe(B);
    expect(modelIdsFromCalls()).toEqual([A, B]);
    const hops = capturedEvents.filter((e): e is ModelFallbackEvent => e.type === "model.fallback");
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({ from: A, to: B, reason: "context_exceeded" });
  });

  test("regression: explicit agent_chain mode preserves normal fallback A→B→C", async () => {
    policyState = { enabled: true, chain: [A, B, C] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => {
      if (modelId === A || modelId === B) {
        return {
          bindTools: () => ({
            invoke: async () => {
              throw TOKEN_LIMIT_ERR;
            },
          }),
        } as unknown as AuraModel;
      }
      if (modelId === C) {
        return {
          bindTools: () => ({
            invoke: async () => new AIMessage("from-C"),
          }),
        } as unknown as AuraModel;
      }
      throw new Error(`unexpected model ${modelId}`);
    });

    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
      modelFallbackMode: "agent_chain",
    });
    expect(out.modelUsed).toBe(C);
    expect(modelIdsFromCalls()).toEqual([A, B, C]);
  });
});

describe("invokeChatModelWithFallback — remote-only rows", () => {
  const messages = [new HumanMessage("hi")];
  const tools: StructuredTool[] = [];

  beforeEach(() => {
    resetRuntimeModelCatalog();
    policyState = { enabled: false, chain: [] };
    createUniversalModelMock.mockReset();
    capturedEvents.length = 0;
    _resetAgentTurnContextsForTests();
    _setFirstTokenTimeoutMsForTests(undefined);
  });

  afterAll(() => {
    resetRuntimeModelCatalog();
  });

  test("supported Anthropic and Fireworks B-only rows pass invocation preflight without restart", async () => {
    const catalog: ModelCatalog = {
      version: 1,
      catalogVersion: "2026.07.18.5",
      publishedAt: "2026-07-18T15:00:00Z",
      entries: [
        {
          id: "anthropic:claude-b-only",
          displayName: "Claude B-only",
          provider: "anthropic",
          routing: "first-party",
          priority: 1,
          defaultEnabled: true,
          limits: { contextTokens: 200_000, outputTokens: 32_000 },
          cost: { coefficient: 1.25 },
          privacy: { grade: 1 },
          intelligence: { tier: "strong" },
        },
        {
          id: "fireworks:accounts/fireworks/models/b-only",
          displayName: "Fireworks B-only",
          provider: "fireworks",
          routing: "fireworks",
          priority: 2,
          defaultEnabled: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          features: { tools: true, structuredOutputs: false, reasoning: true },
          limits: { contextTokens: 200_000, outputTokens: 32_000 },
          cost: { coefficient: 0.42 },
          privacy: { grade: 4 },
          intelligence: { tier: "strong" },
        },
      ],
    };
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-18T15:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => ({
      bindTools: () => ({
        invoke: async () => new AIMessage(`from-${modelId}`),
      }),
    }) as unknown as AuraModel);

    for (const id of [
      "anthropic:claude-b-only",
      "fireworks:accounts/fireworks/models/b-only",
    ]) {
      const out = await invokeChatModelWithFallback(
        messages,
        tools,
        id,
        "user-1",
        "agent-1",
        null,
      );
      expect(out.modelUsed).toBe(id);
    }
    const imageOut = await invokeChatModelWithFallback(
      [new HumanMessage({
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
        ],
      })],
      tools,
      "fireworks:accounts/fireworks/models/b-only",
      "user-1",
      "agent-1",
      null,
    );
    expect(imageOut.modelUsed).toBe("fireworks:accounts/fireworks/models/b-only");
    expect(modelIdsFromCalls()).toEqual([
      "anthropic:claude-b-only",
      "fireworks:accounts/fireworks/models/b-only",
      "fireworks:accounts/fireworks/models/b-only",
    ]);
  });

  const GLM = "fireworks:accounts/fireworks/models/glm-5p3";
  function safeTimeout(overrides: Partial<NonNullable<ProviderTimeoutError["details"]>> = {}) {
    return new ProviderTimeoutError(GLM, 180_000, { kind: "progress_idle_timeout", attemptId: "timed-out-attempt",
      policyProvenance: {}, elapsedMs: 185_030, visibleOutput: false, partialState: true,
      abortRequested: true, safeToFallback: true, ...overrides });
  }

  test("safe idle timeout retries the exact GLM with original inputs and a fresh attempt", async () => {
    policyState = { enabled: true, chain: [B] };
    const attempts: unknown[] = [];
    const inputs: BaseMessage[][] = [];
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
      invoke: async (input: BaseMessage[], options?: RunnableConfig) => {
        inputs.push(input); attempts.push(options?.metadata?.["model_attempt_id"]);
        if (attempts.length === 1) throw safeTimeout();
        return new AIMessage("continued research");
      },
    }) }) as unknown as AuraModel);
    const out = await invokeChatModelWithFallback(messages, tools, GLM, "user-1", "agent-1", null, undefined,
      { modelFallbackMode: "none" });
    expect(out.modelUsed).toBe(GLM);
    expect(modelIdsFromCalls()).toEqual([GLM]);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(capturedEvents.filter(e => e.type === "model.fallback")).toHaveLength(0);
  });

  test("actual supervisor timeout aborts the old request before the same-model retry", async () => {
    _setFirstTokenTimeoutMsForTests(30);
    let attempts = 0;
    let oldRequestAborted = false;
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
      invoke: async (_input: BaseMessage[], options?: RunnableConfig) => {
        attempts++;
        if (attempts === 1) return new Promise<AIMessage>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            oldRequestAborted = true;
            const reason: unknown = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("request aborted"));
          }, { once: true });
        });
        expect(oldRequestAborted).toBe(true);
        expect(options?.signal?.aborted).toBe(false);
        return new AIMessage("recovered");
      },
    }) }) as unknown as AuraModel);
    const out = await invokeChatModelWithFallback(messages, tools, GLM, "user-1", "agent-1", null, undefined,
      { modelFallbackMode: "none" });
    expect(out.modelUsed).toBe(GLM);
    expect(attempts).toBe(2);
  });

  test("safe timeout exhaustion is bounded to two same-model attempts", async () => {
    policyState = { enabled: true, chain: [B] };
    let attempts = 0;
    const failure = safeTimeout();
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
      invoke: async () => { attempts++; throw failure; },
    }) }) as unknown as AuraModel);
    const thrown = await invokeChatModelWithFallback(messages, tools, GLM, "user-1", "agent-1", null, undefined,
      { modelFallbackMode: "none" }).catch((error: unknown) => error);
    expect(thrown).toBe(failure);
    expect(attempts).toBe(2);
    expect(modelIdsFromCalls()).toEqual([GLM]);
  });

  for (const [label, failure] of [
    ["visible output", safeTimeout({ visibleOutput: true })],
    ["unsafe outcome", safeTimeout({ safeToFallback: false })],
    ["not aborted", safeTimeout({ abortRequested: false })],
    ["unknown provenance", new ProviderTimeoutError(GLM, 180_000)],
  ] as const) test(`timeout with ${label} is not replayed`, async () => {
    let attempts = 0;
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
      invoke: async () => { attempts++; throw failure; },
    }) }) as unknown as AuraModel);
    const thrown = await invokeChatModelWithFallback(messages, tools, GLM, "user-1", "agent-1", null, undefined,
      { modelFallbackMode: "none" }).catch((error: unknown) => error);
    expect(thrown).toBe(failure);
    expect(attempts).toBe(1);
  });

  test("cancelling during timeout backoff prevents another request", async () => {
    const controller = new AbortController();
    const cancelled = new Error("caller stopped research");
    let attempts = 0;
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({
      invoke: async () => {
        attempts++;
        setTimeout(() => controller.abort(cancelled), 10);
        throw safeTimeout();
      },
    }) }) as unknown as AuraModel);
    const thrown = await invokeChatModelWithFallback(messages, tools, GLM, "user-1", "agent-1", null,
      { signal: controller.signal }, { modelFallbackMode: "none" }).catch((error: unknown) => error);
    expect(thrown).toBe(cancelled);
    expect(attempts).toBe(1);
  });

});

describe("invokeChatModelWithFallback — foreground controls", () => {
  const messages = [new HumanMessage("hi")];
  const tools: StructuredTool[] = [];
  beforeEach(() => { policyState = { enabled: false, chain: [] }; createUniversalModelMock.mockReset(); _resetAgentTurnContextsForTests(); });

  test("uses an explicit selected effort instead of silently defaulting to medium", async () => {
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({ invoke: async () => new AIMessage("ok") }) }) as unknown as AuraModel);
    await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
      resolveForegroundControls: (modelId) => ({ canonicalModelId: modelId, reasoningEffort: "high" }),
    });
    expect(modelOptionsFromCalls()[0]).toMatchObject({ reasoningOutput: true, reasoningEffort: "high" });
  });

  test("re-resolves every fallback target rather than copying incompatible controls", async () => {
    policyState = { enabled: true, chain: [B] };
    createUniversalModelMock.mockImplementation(async (modelId: string): Promise<AuraModel> => ({
      bindTools: () => ({ invoke: async () => { if (modelId === A) throw TOKEN_LIMIT_ERR; return new AIMessage("fallback-ok"); } }),
    }) as unknown as AuraModel);
    const resolvedFor: string[] = [];
    const out = await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
      resolveForegroundControls: (modelId) => {
        resolvedFor.push(modelId);
        return modelId === A ? { canonicalModelId: A, reasoningEffort: "high" } : { canonicalModelId: B };
      },
    });
    expect(out.modelUsed).toBe(B);
    expect(resolvedFor).toEqual([A, B]);
    expect(modelOptionsFromCalls()[0]).toMatchObject({ reasoningEffort: "high" });
    expect(modelOptionsFromCalls()[1]).not.toHaveProperty("reasoningEffort");
  });

  test("rejects a tuple belonging to another candidate", async () => {
    createUniversalModelMock.mockImplementation(async (): Promise<AuraModel> => ({ bindTools: () => ({ invoke: async () => new AIMessage("not-reached") }) }) as unknown as AuraModel);
    let thrown: unknown;
    try {
      await invokeChatModelWithFallback(messages, tools, A, "user-1", "agent-1", null, undefined, {
        resolveForegroundControls: () => ({ canonicalModelId: B, reasoningEffort: "high" }),
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(`Resolved foreground controls belong to "${B}"`);
    expect(createUniversalModelMock).not.toHaveBeenCalled();
  });
});
