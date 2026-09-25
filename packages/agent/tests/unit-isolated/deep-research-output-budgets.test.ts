import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ChatModel } from "../../src/providers/types";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";
import { runWithUsageContext } from "../../src/usage/usage-context";

const MODEL = "openrouter:moonshotai/kimi-k3";
const factoryCalls: Array<{ modelId: string; options: Record<string, unknown> }> = [];
const boundToolOptions: Array<Record<string, unknown> | undefined> = [];
let scenario: "router" | "researcher" | "compression-cancel" | "agent" = "router";
let compressionSignal: AbortSignal | undefined;
let compressionStarted: Promise<void>;
let markCompressionStarted: () => void;

function modelFor(maxTokens: unknown): ChatModel {
  const model: ChatModel = {
    bindTools: (_tools, options) => { boundToolOptions.push(options); return model; },
    async invoke(_messages, config?: RunnableConfig) {
      if ((scenario === "researcher" || scenario === "compression-cancel") && maxTokens === 1_111) {
        return new AIMessage({
          content: "",
          tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }],
        });
      }
      if (scenario === "researcher" && maxTokens === 2_222) {
        return new AIMessage("Compressed findings");
      }
      if (scenario === "compression-cancel" && maxTokens === 2_222) {
        compressionSignal = config?.signal;
        markCompressionStarted();
        return await new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(new Error("compression aborted"));
          if (compressionSignal?.aborted) rejectAbort();
          else compressionSignal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      if (scenario === "agent" && maxTokens === 1_111) {
        return new AIMessage(JSON.stringify({
          need_clarification: false,
          question: "",
          verification: "Starting research.",
        }));
      }
      if (scenario === "agent" && maxTokens === 3_333) {
        return new AIMessage("Final report");
      }
      return new AIMessage("ok");
    },
  };
  return model;
}

mock.module("../../src/providers/universal", () => ({
  createUniversalModel: async (modelId: string, options: Record<string, unknown>) => {
    factoryCalls.push({ modelId, options: { ...options } });
    return modelFor(options["maxTokens"]);
  },
}));

mock.module("../../src/subagents/deep-research/supervisor/graph", () => ({
  createSupervisorGraph: () => ({
    invoke: async (state: Record<string, unknown>) => ({
      ...state,
      notes: ["Sourced finding"],
      raw_notes: ["https://example.invalid/source"],
      research_iterations: 1,
    }),
  }),
}));

const trust = await import("@nautilo/trust");
const fundingAssertion = spyOn(trust, "assertCanUseServerProviderCredentials").mockResolvedValue(undefined);
const { createModel } = await import("../../src/subagents/deep-research/providers/router");
const { createResearcherGraph } = await import("../../src/subagents/deep-research/researcher/graph");
const { createDeepResearchGraph } = await import("../../src/subagents/deep-research/agent/graph");

const configuration = {
  allow_clarification: true,
  max_structured_output_retries: 3,
  max_concurrent_research_units: 5,
  max_researcher_iterations: 6,
  max_react_tool_calls: 2,
  max_tool_messages: 64,
  search_api: "none",
  search_max_results: 5,
  search_depth: "basic",
  prefer_native_search: false,
  summarization_enabled: true,
  summarization_max_items: 3,
  summarization_timeout_ms: 60_000,
  max_content_length: 50_000,
  supervisor_model: MODEL,
  supervisor_model_max_tokens: 4_444,
  research_model: MODEL,
  research_model_max_tokens: 1_111,
  summarization_model: MODEL,
  summarization_model_max_tokens: 8_192,
  compression_model: MODEL,
  compression_model_max_tokens: 2_222,
  final_report_model: MODEL,
  final_report_model_max_tokens: 3_333,
  anthropic_long_context_beta: false,
  openrouter_api_key: "test-openrouter-key",
  base_url_overrides: null,
  mcp_config: null,
  mcp_prompt: null,
} as Configuration;

function withServerFunding<T>(fn: () => T): T {
  return runWithUsageContext({ callType: "subagent", userId: "deep-research-human" }, fn);
}

beforeEach(() => {
  factoryCalls.length = 0;
  boundToolOptions.length = 0;
  scenario = "router";
  compressionSignal = undefined;
  fundingAssertion.mockClear();
  compressionStarted = new Promise((resolve) => { markCompressionStarted = resolve; });
});

test("router forwards an explicit output budget and preserves omitted legacy behavior", async () => {
  await withServerFunding(() => createModel(MODEL, configuration, { maxTokens: 7_777, useOpenAIResponsesApi: true }));
  await withServerFunding(() => createModel(MODEL, configuration, { maxTokens: undefined }));
  await withServerFunding(() => createModel(MODEL, configuration));

  expect(factoryCalls.map((call) => call.options["maxTokens"])).toEqual([
    7_777,
    undefined,
    undefined,
  ]);
  expect(factoryCalls[1]!.options).not.toHaveProperty("maxTokens");
  expect(factoryCalls[2]!.options).not.toHaveProperty("maxTokens");
  expect(fundingAssertion).toHaveBeenCalledTimes(3);
  expect(factoryCalls[0]!.options["useOpenAIResponsesApi"]).toBe(true);
  expect(factoryCalls[1]!.options).not.toHaveProperty("useOpenAIResponsesApi");
  expect(factoryCalls[2]!.options).not.toHaveProperty("useOpenAIResponsesApi");
});

test("researcher and compression use their distinct budgets when model IDs match", async () => {
  scenario = "researcher";
  const result = await withServerFunding(() => createResearcherGraph(configuration).invoke({
    research_topic: "RFC 1035 TTL semantics",
    research_brief: "Use only RFC 1035.",
    raw_notes: ["RFC 1035 Section 3.2.1"],
  })) as Record<string, unknown>;

  expect(result["compressed_research"]).toBe("Compressed findings");
  expect(factoryCalls.map((call) => ({
    modelId: call.modelId,
    maxTokens: call.options["maxTokens"],
    useOpenAIResponsesApi: call.options["useOpenAIResponsesApi"],
  }))).toEqual([
    { modelId: MODEL, maxTokens: 1_111, useOpenAIResponsesApi: true },
    { modelId: MODEL, maxTokens: 2_222, useOpenAIResponsesApi: undefined },
  ]);
  expect(fundingAssertion).toHaveBeenCalledTimes(4);
});

test("Opus 5.5 research routes use automatic tool choice on continuation turns", async () => {
  const modelIds = [
    "anthropic:claude-opus-5-5",
    "openrouter:anthropic/claude-opus-5.5",
    "venice:claude-opus-5-5",
  ];

  for (const modelId of modelIds) {
    factoryCalls.length = 0;
    boundToolOptions.length = 0;
    scenario = "researcher";
    await createResearcherGraph({
      ...configuration,
      research_model: modelId,
      research_model_max_tokens: 1_111,
    }).invoke({
      research_topic: "RFC 1035 TTL semantics",
      research_brief: "Use only RFC 1035.",
      raw_notes: ["Prior search cycle: RFC 1035 Section 3.2.1"],
      researcher_messages: [new AIMessage("Prior search cycle completed.")],
    });

    expect(boundToolOptions).toEqual([undefined]);
  }
});

test("clarification and final synthesis use their role budgets when model IDs match", async () => {
  scenario = "agent";
  const result = await withServerFunding(() => createDeepResearchGraph(undefined, configuration).invoke({
    messages: [{ role: "user", content: "Research RFC 1035 TTL semantics" }],
    research_brief: "Research RFC 1035 TTL semantics",
    report_language: "English",
  })) as Record<string, unknown>;

  expect(result["final_report"]).toBe("Final report");
  expect(factoryCalls.map((call) => ({
    modelId: call.modelId,
    maxTokens: call.options["maxTokens"],
    useOpenAIResponsesApi: call.options["useOpenAIResponsesApi"],
  }))).toEqual([
    { modelId: MODEL, maxTokens: 1_111, useOpenAIResponsesApi: undefined },
    { modelId: MODEL, maxTokens: 3_333, useOpenAIResponsesApi: undefined },
  ]);
  expect(fundingAssertion).toHaveBeenCalledTimes(4);
});

test("graph cancellation reaches compression transport and rejects promptly", async () => {
  scenario = "compression-cancel";
  const controller = new AbortController();
  const graphRun = withServerFunding(() => createResearcherGraph(configuration).invoke({
    research_topic: "RFC 1035 TTL semantics",
    research_brief: "Use only RFC 1035.",
    raw_notes: ["RFC 1035 Section 3.2.1"],
  }, { signal: controller.signal }));

  await compressionStarted;
  const abortedAt = performance.now();
  controller.abort();
  const error = await graphRun.catch((value: unknown) => value);

  expect(compressionSignal).toBeDefined();
  expect(compressionSignal?.aborted).toBe(true);
  expect(error).toBeInstanceOf(Error);
  expect(fundingAssertion).toHaveBeenCalledTimes(4);
  expect(performance.now() - abortedAt).toBeLessThan(250);
});


test("uncapped generative roles use the model allowance while compression keeps its own budget", async () => {
  const { fromRuntimeConfig } = await import("../../src/subagents/deep-research/shared/config");
  const cfg = fromRuntimeConfig({ ...configuration, supervisor_model_max_tokens: undefined,
    research_model_max_tokens: undefined, final_report_model_max_tokens: undefined }, { env: {} });
  expect(cfg.supervisor_model_max_tokens).toBeUndefined();
  expect(cfg.research_model_max_tokens).toBeUndefined();
  expect(cfg.final_report_model_max_tokens).toBeUndefined();
  expect(cfg.compression_model_max_tokens).toBe(2_222);
  const id = "openai:gpt-6-luna";
  await createModel(id, cfg, { messages: [{ role: "user", content: "Write a complete report." }] });
  expect(factoryCalls.at(-1)?.options["maxTokens"]).toBe(128_000);
  await createModel(id, cfg, { maxTokens: 7_777, messages: [{ role: "user", content: "Write a report." }] });
  expect(factoryCalls.at(-1)?.options["maxTokens"]).toBe(7_777);
  await createModel(id, cfg, { messages: [{ role: "user", content: "x".repeat(1_000_000 * 4) }] });
  expect(factoryCalls.at(-1)?.options["maxTokens"]).toBe(1_050_000 - 1_000_000 - 4096);
});
