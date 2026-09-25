import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { ChatModel } from "../../src/providers/types";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";

import { runWithUsageContext } from "../../src/usage/usage-context";

const trust = await import("@nautilo/trust");
spyOn(trust, "assertCanUseServerProviderCredentials").mockImplementation(async (humanUserId) => {
  expect(humanUserId).toBe("deep-research-human");
});

function withServerFunding<T>(fn: () => T): T {
  return runWithUsageContext({ callType: "subagent", userId: "deep-research-human" }, fn);
}

const modelId = "anthropic:claude-opus-5-5";
let modelCalls = 0;
let reply = new AIMessage("");
let queuedReplies: AIMessage[] = [];
let onInvoke: (() => void) | undefined;

beforeEach(() => {
  modelCalls = 0;
  queuedReplies = [];
  onInvoke = undefined;
});

mock.module("../../src/providers/universal", () => ({
  createUniversalModel: async (): Promise<ChatModel> => {
    modelCalls += 1;
    const model: ChatModel = {
      bindTools: () => model,
      invoke: async () => {
        onInvoke?.();
        return queuedReplies.shift() ?? reply;
      },
    };
    return model;
  },
}));

const { createResearcherGraph } = await import("../../src/subagents/deep-research/researcher/graph");
const { createSupervisorGraph } = await import("../../src/subagents/deep-research/supervisor/graph");

const configuration = {
  research_model: modelId,
  research_model_max_tokens: 10_000,
  compression_model: modelId,
  supervisor_model: modelId,
  max_researcher_iterations: 2,
  max_concurrent_research_units: 1,
  max_react_tool_calls: 2,
  summarization_max_items: 3,
  compression_model_max_tokens: 4096,
  max_tool_messages: 64,
  search_api: "none",
  search_max_results: 5,
  prefer_native_search: false,
  anthropic_long_context_beta: false,
  mcp_prompt: null,
  mcp_config: null,
  anthropic_api_key: "synthetic-key",
  base_url_overrides: null,
} as Configuration;

test("researcher rejects a truncated Opus tool call before executing tools or compression", async () => {
  for (const metadata of [
    { additional_kwargs: { stop_reason: "max_tokens" } },
    { response_metadata: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]) {
    modelCalls = 0;
    reply = new AIMessage({
      content: "Partial research",
      tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }],
      ...metadata,
    });

    const result = await withServerFunding(() => createResearcherGraph(configuration).invoke({
      research_topic: "RFC 1035 TTL semantics",
      research_brief: "Use only RFC 1035.",
    })).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe("ModelOutputLimitError");
    expect(modelCalls).toBe(1);
  }
});

test("supervisor rejects cutoff before completion, tool dispatch or child research", async () => {
  for (const toolCalls of [
    [],
    [{ name: "ResearchComplete", args: {}, id: "complete-1" }],
    [{ name: "ConductResearch", args: { research_topic: "RFC 1035" }, id: "research-1" }],
  ]) {
    modelCalls = 0;
    reply = new AIMessage({ content: "Partial research", tool_calls: toolCalls,
      response_metadata: { finish_reason: "length" } });
    const result = await withServerFunding(() => createSupervisorGraph(configuration).invoke({ research_brief: "Use RFC 1035." }))
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe("ModelOutputLimitError");
    expect((result as Error).message).not.toContain("saved");
    expect(modelCalls).toBe(1);
  }
});

test("compression cutoff rejects the parent research graph without accepting partial notes", async () => {
  queuedReplies = [
    new AIMessage({ content: "", tool_calls: [{ name: "ConductResearch", args: { research_topic: "RFC 1035" }, id: "research-1" }] }),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }] }),
    new AIMessage({ content: "Partial summary", additional_kwargs: { stop_reason: "max_tokens" } }),
  ];
  const result = await withServerFunding(() => createSupervisorGraph(configuration).invoke({ research_brief: "Use RFC 1035." }))
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).name).toBe("ModelOutputLimitError");
  expect((result as Error).message).not.toContain("saved");
  expect(modelCalls).toBe(3);
});

test("complete supervisor, researcher and compression responses still produce notes", async () => {
  queuedReplies = [
    new AIMessage({ content: "", tool_calls: [{ name: "ConductResearch", args: { research_topic: "RFC 1035" }, id: "research-1" }] }),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }] }),
    new AIMessage({ content: "Complete summary", response_metadata: { finish_reason: "stop" } }),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-2" }] }),
  ];
  const result = await withServerFunding(() => createSupervisorGraph(configuration).invoke({ research_brief: "Use RFC 1035." }));
  expect(result).toMatchObject({ notes: ["Complete summary"] });
  expect(modelCalls).toBe(4);
});

for (const cancelAt of [1, 2, 3]) {
  test(`cancellation during research model call ${cancelAt} rejects without successful notes`, async () => {
    const controller = new AbortController();
    const cancellation = new Error("Research cancelled");
    queuedReplies = [
      new AIMessage({ content: "", tool_calls: [{ name: "ConductResearch", args: { research_topic: "RFC 1035" }, id: "research-1" }] }),
      new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }] }),
      new AIMessage("Unaccepted summary"),
    ];
    onInvoke = () => {
      if (modelCalls === cancelAt) {
        controller.abort(cancellation);
        throw cancellation;
      }
    };
    const result = await withServerFunding(() => createSupervisorGraph(configuration).invoke(
      { research_brief: "Use RFC 1035." }, { signal: controller.signal },
    )).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(modelCalls).toBe(cancelAt);
    expect(controller.signal.aborted).toBe(true);
  });
}


const { createFinalReportGenerationNode } = await import("../../src/subagents/deep-research/agent/graph");
test("final synthesis rejects truncated output instead of returning it as a complete report", async () => {
  modelCalls = 0;
  reply = new AIMessage({ content: "Partial final report", response_metadata: { finish_reason: "length" } });
  const node = createFinalReportGenerationNode({ ...configuration, final_report_model: modelId });
  const result = await withServerFunding(() => node({ notes: ["Complete finding"], messages: [], research_brief: "Audit", report_language: "English" } as never))
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).cause).toBeInstanceOf(Error);
  expect(((result as Error).cause as Error).message).toContain("model output limit before completion");
  expect(modelCalls).toBe(1);
});

test("oversized synthesis input fails before calling the provider without cutting findings", async () => {
  modelCalls = 0;
  const notes = ["x".repeat(4_100_000)];
  const node = createFinalReportGenerationNode({ ...configuration, final_report_model: modelId });
  const result = await withServerFunding(() => node({ notes, messages: [], research_brief: "Audit", report_language: "English" } as never))
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect(((result as Error).cause as Error).name).toBe("PreparedContextExceededError");
  expect(modelCalls).toBe(0);
  expect(notes[0]!.length).toBe(4_100_000);
});

test("final synthesis rejects cancellation even if the provider returns partial text", async () => {
  const controller = new AbortController();
  const cancellation = new Error("Research cancelled");
  reply = new AIMessage("Partial final report");
  onInvoke = () => controller.abort(cancellation);
  const node = createFinalReportGenerationNode({ ...configuration, final_report_model: modelId });
  const result = await withServerFunding(() => node(
    { notes: ["Complete finding"], messages: [], research_brief: "Audit", report_language: "English" } as never,
    { signal: controller.signal },
  )).catch((error: unknown) => error);
  expect(result).toBe(cancellation);
  expect(modelCalls).toBe(1);
});
