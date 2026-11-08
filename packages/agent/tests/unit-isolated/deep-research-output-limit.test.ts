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
const invocations: unknown[][] = [];

beforeEach(() => {
  modelCalls = 0;
  invocations.length = 0;
  queuedReplies = [];
  onInvoke = undefined;
});

mock.module("../../src/providers/universal", () => ({
  createUniversalModel: async (): Promise<ChatModel> => {
    modelCalls += 1;
    const model: ChatModel = {
      bindTools: () => model,
      invoke: async (messages) => {
        invocations.push(messages);
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

test("compression cutoff preserves every original note and discards the incomplete summary", async () => {
  const notes = Array.from({ length: 8 }, (_, index) => `Finding ${index}: https://example.invalid/source-${index}`);
  queuedReplies = [
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }] }),
    new AIMessage({ content: "INCOMPLETE_SUMMARY", additional_kwargs: { stop_reason: "max_tokens" } }),
  ];
  const result = await withServerFunding(() => createResearcherGraph(configuration).invoke({
    research_topic: "DNS findings", research_brief: "Use all sources.", raw_notes: notes,
  })) as Record<string, unknown>;
  expect(result["raw_notes"]).toEqual(notes);
  const recovered = String(result["compressed_research"]);
  expect(recovered).toContain("Original research notes follow in full");
  expect(recovered).not.toContain("INCOMPLETE_SUMMARY");
  for (const note of notes) {
    expect(recovered).toContain(note);
    expect(JSON.stringify(invocations[1])).toContain(note);
  }
  expect(modelCalls).toBe(2);
});

test("compression without evidence cannot turn a cutoff into successful research", async () => {
  queuedReplies = [
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "complete-1" }] }),
    new AIMessage({ content: "INCOMPLETE_SUMMARY", response_metadata: { finish_reason: "length" } }),
  ];
  const result = await withServerFunding(() => createResearcherGraph(configuration).invoke({
    research_topic: "DNS findings", research_brief: "Use all sources.",
  })).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).name).toBe("ModelOutputLimitError");
  expect(modelCalls).toBe(2);
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
  expect(JSON.stringify(invocations[3])).toContain("Complete summary");
  expect(JSON.stringify(invocations[3])).toContain("Use RFC 1035.");
  expect(JSON.stringify(invocations[3])).not.toContain("Research delegated:");
  expect(modelCalls).toBe(4);
});

test("parallel research findings return under their own tool-call identities", async () => {
  queuedReplies = [
    new AIMessage({ content: "", tool_calls: [
      { name: "ConductResearch", args: { research_topic: "DNS caching" }, id: "research-cache" },
      { name: "ConductResearch", args: { research_topic: "DNS delegation" }, id: "research-delegation" },
    ] }),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "done-cache" }] }),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "done-delegation" }] }),
    new AIMessage("Caching evidence: https://example.invalid/cache"),
    new AIMessage("Delegation evidence: https://example.invalid/delegation"),
    new AIMessage({ content: "", tool_calls: [{ name: "ResearchComplete", args: {}, id: "done-supervisor" }] }),
  ];
  const result = await withServerFunding(() => createSupervisorGraph({ ...configuration, max_concurrent_research_units: 2 }).invoke({
    research_brief: "Compare DNS caching and delegation.",
  }));
  expect(result).toMatchObject({ notes: [
    "Caching evidence: https://example.invalid/cache",
    "Delegation evidence: https://example.invalid/delegation",
  ] });
  const supervisorInput = invocations[5] as Array<{
    tool_call_id?: string; content?: unknown;
    tool_calls?: Array<{ id: string; args: { research_topic?: string } }>;
  }>;
  const calls = supervisorInput.flatMap(message => message.tool_calls ?? []);
  const cacheId = calls.find(call => call.args.research_topic === "DNS caching")?.id;
  const delegationId = calls.find(call => call.args.research_topic === "DNS delegation")?.id;
  expect(cacheId).toBeDefined();
  expect(delegationId).toBeDefined();
  expect(supervisorInput.find(message => message.tool_call_id === cacheId)?.content)
    .toBe("Caching evidence: https://example.invalid/cache");
  expect(supervisorInput.find(message => message.tool_call_id === delegationId)?.content)
    .toBe("Delegation evidence: https://example.invalid/delegation");
  expect(JSON.stringify(supervisorInput)).toContain("Compare DNS caching and delegation.");
  expect(modelCalls).toBe(6);
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
