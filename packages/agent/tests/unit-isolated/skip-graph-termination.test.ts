import { afterAll, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { ToolCatalog, initToolCatalog, clearToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { ChatModel } from "../../src/providers/types";

// Keep the production graph, admission and tool execution. Only persisted
// preferences and model generation are replaced; no database or provider runs.
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getRoomAgentModelControlSelection: async () => null,
  getProfileDefaultModelControlSelection: async () => null,
  getCachedServerModelConfigRow: () => null,
  kickServerModelConfigRefresh: () => {},
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));

const { createNautiloGraph } = await import("../../src/agent/graph");
const { __setStubModelForTests: setStubModel } = await import("../../src/providers/universal");
const { createSkipTool } = await import("../../src/tools/skip");
const { _resetAgentTurnContextsForTests } = await import("../../src/runtime/turn-context");
const previousTestMode = process.env["NAUTILO_TEST_MODE"];

afterAll(() => {
  setStubModel(null);
  clearToolCatalog();
  _resetAgentTurnContextsForTests();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  mock.restore();
});

test("a scheduled report-back ends after one real skip without a second model invocation", async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  const catalog = new ToolCatalog();
  catalog.register({
    name: "skip",
    factory: (context) => createSkipTool(context),
    category: "meta",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: [],
    resultScanPolicy: "never",
  });
  initToolCatalog(catalog);
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? new AIMessage({ content: "", tool_calls: [
            { id: "skip-call", name: "skip", args: { reason: "No actionable change." } },
          ] })
        : new AIMessage("Unexpected second model response.");
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), {
    resolveContext: async () => { throw new Error("unused in graph fixture"); },
    buildEnvelope: async () => { throw new Error("unused in graph fixture"); },
    checkToolAccess: async () => ({ type: "allow" }),
    routeApproval: async () => ({ type: "prove_it", approvers: [] }),
  });
  const config = { configurable: { thread_id: "skip-report-back-fixture" } };
  const result = await graph.invoke({
    messages: [new HumanMessage("[TASK RESULT] No actionable change. Notify only when something changes.")],
    model: "openai:gpt-5.5-2026-04-23",
    userId: "skip-owner",
    causalHumanUserId: "skip-owner",
    agentId: "skip-agent",
    actorRole: "owner",
    turnId: "skip-report-back-turn",
    trustedExecutionEntrypoint: "foreground.task_report_back",
    memoryAccessEnvelope: {
      ownerId: "skip-owner", actorId: "skip-owner", agentId: "skip-agent", roomId: "",
      readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [],
      toolPolicy: { skip: "allow" },
    },
  }, config) as NautiloState;

  expect(modelCalls).toBe(1);
  const results = result.messages.filter((message) => ToolMessage.isInstance(message));
  expect(results).toHaveLength(1);
  expect(results[0]?.name).toBe("skip");
  expect(JSON.parse(results[0]!.content as string)).toMatchObject({ skipped: true });
  const checkpoint = await graph.getState(config);
  if (!checkpoint) throw new Error("Expected a completed graph checkpoint");
  expect(checkpoint.values["messages"]).toEqual(result.messages);
  expect(checkpoint.values["approvedToolCalls"]).toEqual([]);
});
