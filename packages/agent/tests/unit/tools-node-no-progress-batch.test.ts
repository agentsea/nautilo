import { afterEach, expect, spyOn, test } from "bun:test";
import * as runtimeConfig from "@nautilo/config";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import { createToolsNode, toolsNode } from "../../src/nodes/tools";
import { preModelNode } from "../../src/nodes/pre-model";
import { NoProgressError } from "../../src/graph/no-progress";

afterEach(clearToolCatalog);

test("checkpointed calls count as one failure round and allow model correction", async () => {
  const catalog = new ToolCatalog();
  let invocations = 0;
  catalog.register({
    name: "batch_fixture", exposure: "core", category: "development", trustTier: "guest", impact: "read-only",
    factory: () => new DynamicStructuredTool({
      name: "batch_fixture", description: "Batch failure fixture", schema: z.object({}),
      func: async () => { invocations++; throw new Error("Citation required"); },
    }),
  });
  initToolCatalog(catalog);
  let state = {
    messages: [], approvedToolCalls: [], actorRole: "owner", userId: "owner", personaId: "owner",
    turnId: "turn", agentId: "agent", roomId: "room", engagedSkillNames: [],
    memoryAccessEnvelope: null, relayCapabilities: {}, activatedToolNames: [], activatedToolLeases: [],
  } as unknown as NautiloState;
  for (let round = 1; round <= 3; round++) {
    const calls = Array.from({ length: 4 }, (_, i) => ({ id: `round-${round}-${i}`, name: "batch_fixture", args: {}, type: "tool_call" as const }));
    state = { ...state, messages: [...state.messages, new AIMessage({ content: "", tool_calls: calls })], approvedToolCalls: calls };
    for (let i = 0; i < calls.length; i++) {
      state = { ...state, ...await toolsNode(state) };
      expect([...(state.noProgressStreaks?.values() ?? [])].map((entry) => entry.count)).toEqual(i === 3 ? [round] : round === 1 ? [] : [round - 1]);
      if (round < 3 || i < 3) expect(state.noProgressPendingCorrection ?? null).toBeNull();
    }
  }
  expect(invocations).toBe(12);
  expect(state.noProgressPendingCorrection).not.toBeNull();
  // Simulate the model consuming its corrective instruction and retrying.
  const call = { id: "corrective-retry", name: "batch_fixture", args: {}, type: "tool_call" as const };
  state = { ...state, noProgressPendingCorrection: null, messages: [...state.messages, new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [call] };
  let providerCalls = 0;
  let protectedReceipts = 0;
  const graph = new StateGraph(NautiloStateAnnotation)
    .addNode("tools", createToolsNode({ liveShadowToolBoundaryForState: () => ({
      protectAssistantToolCall: async (source) => source,
      protectToolResult: async (receipt) => {
        protectedReceipts++;
        receipt.additional_kwargs = { ...receipt.additional_kwargs, fixture_protected_receipt: true };
        return receipt;
      },
    }) }))
    .addNode("pre_model", preModelNode)
    .addNode("provider", () => { providerCalls++; return {}; })
    .addEdge(START, "tools").addEdge("tools", "pre_model").addEdge("pre_model", "provider").addEdge("provider", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "terminal-receipt" }, version: "v2" as const };
  const receipts: ToolMessage[] = [];
  let failure: unknown;
  try {
    for await (const event of graph.streamEvents(state, config)) {
      if (event.event === "on_chain_end" && event.name === "tools") {
        const output = event.data.output as Partial<NautiloState>;
        const last = output.messages?.at(-1);
        if (last && ToolMessage.isInstance(last)) receipts.push(last);
      }
    }
  } catch (error) { failure = error; }
  if (!(failure instanceof NoProgressError)) throw new Error("Expected the unchanged no-progress outcome");
  expect(failure.message).toBe("no_progress");
  expect(invocations).toBe(13);
  expect(providerCalls).toBe(0);
  expect(protectedReceipts).toBe(1);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.tool_call_id).toBe(call.id);
  expect(receipts[0]?.content).toContain("Citation required");
  expect(receipts[0]?.additional_kwargs["fixture_protected_receipt"]).toBe(true);
  const saved = await graph.getState(config);
  const checkpoint = saved.values as NautiloState;
  expect(checkpoint.messages.at(-1)?.content).toBe(receipts[0]?.content);
  expect(checkpoint.noProgressPendingStop).toEqual({ toolName: failure.outcome.toolName,
    operationDiscriminator: failure.outcome.operationDiscriminator, normalizedError: failure.outcome.normalizedError });
  expect(checkpoint.approvedToolCalls).toEqual([]);
  const resumed = await graph.invoke(null, config).catch((error: unknown) => error);
  expect(resumed).toBeInstanceOf(NoProgressError);
  expect(invocations).toBe(13);
});

test("a pending stop runs before any pre-model state/config/provider preparation", async () => {
  const state = { noProgressPendingStop: { toolName: "fixture", operationDiscriminator: "read", normalizedError: "repair required" },
    get model(): string { throw new Error("Model preparation must not run"); } } as unknown as NautiloState;
  const prepare = spyOn(runtimeConfig, "fromRuntimeConfig").mockImplementation(() => { throw new Error("Configuration preparation must not run"); });
  try {
    const failure = await preModelNode(state).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NoProgressError);
    expect(prepare).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); }
});
