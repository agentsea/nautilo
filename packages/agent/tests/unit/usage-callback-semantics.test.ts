import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LLMResult } from "@langchain/core/outputs";
import {
  __setProviderCostRecorderForTests,
  __setUsageRecorderForTests,
  createUsageCallbackHandler,
  extractUsageFromLLMResult,
} from "../../src/usage/usage-callback";
import type { ProviderCostReceipt, ProviderCostRecorder } from "../../src/usage/provider-cost-recorder";
import { PROVIDER_TOOL_PRICING_VERSION } from "@nautilo/db";
import { runWithUsageContext } from "../../src/usage/usage-context";
import type { RecordUsageInput } from "../../src/usage/record-usage";

function invokeHandlerEnd(
  handler: ReturnType<typeof createUsageCallbackHandler>,
  output: LLMResult,
  runId = "test-run",
): void {
  if (!handler.handleLLMEnd) throw new Error("UsageCallbackHandler missing handleLLMEnd");
  handler.handleLLMEnd(output, runId);
}

function metadataResult(): LLMResult {
  return {
    generations: [
      [
        {
          text: "hi",
          message: {
            usage_metadata: {
              input_tokens: 5,
              output_tokens: 3,
            },
          },
        },
      ],
    ],
  } as unknown as LLMResult;
}

function openAiTokenUsageResult(): LLMResult {
  return {
    generations: [[{ text: "legacy" }]],
    llmOutput: {
      tokenUsage: {
        promptTokens: 9,
        completionTokens: 4,
        totalTokens: 13,
      },
    },
  } as unknown as LLMResult;
}

function emptyUsageResult(): LLMResult {
  return {
    generations: [[{ text: "no usage" }]],
  } as unknown as LLMResult;
}

describe("usage callback handler semantics (ISSUE-M217 phase 3)", () => {
  beforeEach(() => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    __setUsageRecorderForTests(null);
    __setProviderCostRecorderForTests(null);
  });

  afterEach(() => {
    __setUsageRecorderForTests(null);
    __setProviderCostRecorderForTests(null);
    delete process.env["NAUTILO_TEST_MODE"];
  });

  it("records one row for one synthetic completion", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => {
      calls.push(input);
    });
    invokeHandlerEnd(createUsageCallbackHandler("anthropic:claude-sonnet-4-6"), metadataResult());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inputTokens).toBe(5);
    expect(calls[0]?.outputTokens).toBe(3);
  });

  it("leaves Surplus completions to the durable attempt ledger", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => { calls.push(input); });
    runWithUsageContext({
      callType: "chat",
      funding: { kind: "server", humanUserId: "user-1", providerRoute: "surplus" },
    }, () => invokeHandlerEnd(createUsageCallbackHandler("venice:openai-gpt-55"), metadataResult()));
    expect(calls).toHaveLength(0);
  });

  it("records two rows for two sequential completions in one ambient turn", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => {
      calls.push(input);
    });
    const handler = createUsageCallbackHandler("openai:gpt-5.6-sol");
    runWithUsageContext(
      {
        callType: "chat",
        userId: "user-1",
        roomId: "room-1",
        metadata: { turnId: "turn-1", taskId: "task-1", taskRunId: "run-1", jobId: "job-1" },
      },
      () => {
        invokeHandlerEnd(handler, metadataResult());
        invokeHandlerEnd(handler, metadataResult(), "test-run-2");
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.callType === "chat")).toBe(true);
    expect(calls.every((c) => c.userId === "user-1")).toBe(true);
    expect(calls.every((c) => c.roomId === "room-1")).toBe(true);
    expect(calls.every((c) => c.taskId === "task-1")).toBe(true);
    expect(calls.every((c) => c.metadata?.["turnId"] === "turn-1")).toBe(true);
  });

  it("normalizes blank room attribution to null and preserves valid room ids", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => {
      calls.push(input);
    });
    const handler = createUsageCallbackHandler("openai:gpt-5.6-luna");

    runWithUsageContext(
      { callType: "subagent", userId: "user-1", roomId: "" },
      () => invokeHandlerEnd(handler, metadataResult()),
    );
    runWithUsageContext(
      {
        callType: "chat",
        userId: "user-1",
        roomId: "00000000-0000-0000-0000-000000000101",
      },
      () => invokeHandlerEnd(handler, metadataResult(), "test-run-valid-room"),
    );

    expect(calls.map((call) => call.roomId)).toEqual([
      null,
      "00000000-0000-0000-0000-000000000101",
    ]);
  });

  it("extracts usage_metadata and OpenAI llmOutput fallback shapes", () => {
    expect(extractUsageFromLLMResult(metadataResult())).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      actualCostUsd: null,
    });
    expect(extractUsageFromLLMResult(openAiTokenUsageResult())).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      actualCostUsd: null,
    });
  });

  it("recovers OpenRouter cache writes only when its raw usage metadata survives", () => {
    const output = {
      generations: [[{
        text: "cached",
        message: {
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_token_details: { cache_read: 90 },
          },
          response_metadata: {
            usage: {
              prompt_tokens_details: {
                cached_tokens: 90,
                cache_write_tokens: 95,
              },
            },
          },
        },
      }]],
    } as unknown as LLMResult;

    expect(extractUsageFromLLMResult(output)).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      reasoningTokens: 0,
      cachedInputTokens: 90,
      cacheCreationTokens: 95,
      actualCostUsd: null,
    });
  });

  it("does not double count a cache write already normalized by LangChain", () => {
    const output = {
      generations: [[{
        text: "cached",
        message: {
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_token_details: {
              cache_read: 90,
              cache_creation: 95,
            },
          },
          response_metadata: {
            usage: {
              prompt_tokens_details: {
                cached_tokens: 90,
                cache_write_tokens: 95,
              },
            },
          },
        },
      }]],
    } as unknown as LLMResult;

    expect(extractUsageFromLLMResult(output)?.cacheCreationTokens).toBe(95);
    expect(extractUsageFromLLMResult(output)?.cachedInputTokens).toBe(90);
  });

  it("skips recording when no usage signal is present", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => {
      calls.push(input);
    });
    invokeHandlerEnd(createUsageCallbackHandler("openai:gpt-5.6-terra"), emptyUsageResult());
    expect(calls).toHaveLength(0);
  });

  it("binds each handler to the model id passed at construction (fallback identity)", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => {
      calls.push(input);
    });
    invokeHandlerEnd(createUsageCallbackHandler("openai:gpt-5.6-terra"), metadataResult());
    invokeHandlerEnd(createUsageCallbackHandler("anthropic:claude-opus-4-8"), metadataResult(), "test-run-2");
    expect(calls.map((c) => c.model)).toEqual([
      "openai:gpt-5.6-terra",
      "anthropic:claude-opus-4-8",
    ]);
  });

  it("carries a foreground serving tuple into the usage record", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => calls.push(input));
    runWithUsageContext({
      callType: "chat",
      modelControl: {
        canonicalModelId: "fireworks:accounts/fireworks/models/kimi-k3", effectiveModelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
        servingProfileId: "fast", servingSelector: "model-override:fireworks:accounts/fireworks/routers/kimi-k3-fast",
      },
    }, () => invokeHandlerEnd(createUsageCallbackHandler("fireworks:accounts/fireworks/models/kimi-k3"), metadataResult()));
    expect(calls[0]?.modelControl).toEqual({
      canonicalModelId: "fireworks:accounts/fireworks/models/kimi-k3", effectiveModelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
      servingProfileId: "fast", servingSelector: "model-override:fireworks:accounts/fireworks/routers/kimi-k3-fast",
    });
  });

  it("carries the exact non-secret personal funding decision into the usage record", () => {
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => calls.push(input));
    runWithUsageContext({
      callType: "chat",
      userId: "00000000-0000-0000-0000-000000000101",
      funding: {
        kind: "personal",
        humanUserId: "00000000-0000-0000-0000-000000000101",
        payerHumanId: "00000000-0000-0000-0000-000000000101",
        providerRoute: "openrouter-direct",
        credentialId: "00000000-0000-0000-0000-000000000202",
        credentialRevision: 4,
      },
    }, () => invokeHandlerEnd(
      createUsageCallbackHandler("openrouter:anthropic/claude-sonnet-4.6"),
      metadataResult(),
    ));

    expect(calls[0]).toMatchObject({
      userId: "00000000-0000-0000-0000-000000000101",
      funding: {
        kind: "personal",
        providerRoute: "openrouter-direct",
        credentialId: "00000000-0000-0000-0000-000000000202",
        credentialRevision: 4,
      },
    });
    expect(calls[0]?.metadata).toBeUndefined();
  });

  it("swallows recorder failures without throwing from handleLLMEnd", () => {
    __setUsageRecorderForTests(() => {
      throw new Error("db down");
    });
    expect(() => {
      invokeHandlerEnd(createUsageCallbackHandler("openai:gpt-5.6-sol"), metadataResult());
    }).not.toThrow();
  });

  it("records native web-search requests once and skips a separate surcharge when actual total cost is inclusive", () => {
    const receipts: ProviderCostReceipt[] = [];
    __setProviderCostRecorderForTests(() => (async (receipt) => {
      receipts.push(receipt);
    }) as ProviderCostRecorder);
    const nativeSearch = (cost?: number): LLMResult => ({
      generations: [[{
        text: "searched",
        message: {
          usage_metadata: { input_tokens: 5, output_tokens: 3 },
          additional_kwargs: { tool_outputs: [{ type: "web_search_call" }] },
          response_metadata: {
            usage: {
              server_tool_use: { web_search_requests: 1 },
              ...(cost === undefined ? {} : { cost }),
            },
          },
        },
      }]],
    }) as unknown as LLMResult;

    runWithUsageContext({ callType: "web_search", userId: "human-1" }, () => {
      invokeHandlerEnd(createUsageCallbackHandler("openai:gpt-6.1-sol"), nativeSearch(), "native-run");
    });
    expect(receipts).toEqual([{
      provider: "openai",
      operation: "native_web_search",
      receiptId: "native-run:native-web-search",
      estimatedCostUsd: "0.02000000",
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
      pricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      measuredUnits: 2,
      unitType: "request",
    }]);

    runWithUsageContext({ callType: "web_search", userId: "human-1" }, () => {
      invokeHandlerEnd(createUsageCallbackHandler("openai:gpt-6.1-sol"), nativeSearch(0.25), "inclusive-run");
    });
    expect(receipts).toHaveLength(1);
  });
});
