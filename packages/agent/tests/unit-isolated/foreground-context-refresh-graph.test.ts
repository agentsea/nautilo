import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { PolicyResolver } from "@nautilo/trust";
import { z } from "zod";
import type { ChatModel } from "../../src/providers/types";
import type { RebuildForegroundContext } from "../../src/graph/foreground-context-refresh";

// Exercise the compiled production graph and real tool node. Only persistent
// preferences, provider credential admission, and model generation are
// replaced; this fixture has no database, network, or external service.
const previousToolCallLogging = process.env["NAUTILO_LOG_TOOL_CALLS"];
process.env["NAUTILO_LOG_TOOL_CALLS"] = "false";
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
const { streamForegroundGraph } = await import("../../src/graph/foreground-context-refresh");
const { __setStubModelForTests: setStubModel } = await import("../../src/providers/universal");
const { _resetAgentTurnContextsForTests } = await import("../../src/runtime/turn-context");
const previousTestMode = process.env["NAUTILO_TEST_MODE"];

const policy: PolicyResolver = {
  resolveContext: async () => { throw new Error("unused in graph fixture"); },
  buildEnvelope: async () => { throw new Error("unused in graph fixture"); },
  checkToolAccess: async () => ({ type: "allow" }),
  routeApproval: async () => ({ type: "prove_it", approvers: [] }),
};

function graphInput(request: HumanMessage): Record<string, unknown> {
  return {
    messages: [request],
    model: "openai:gpt-5.5-2026-04-23",
    userId: "refresh-owner",
    causalHumanUserId: "refresh-owner",
    agentId: "refresh-agent",
    actorRole: "owner",
    roomId: "refresh-room",
    turnId: "refresh-turn",
    foregroundContextRefreshEligible: true,
    foregroundContextRefreshSource: { acceptedMessages: [request] },
    memoryAccessEnvelope: {
      ownerId: "refresh-owner",
      actorId: "refresh-owner",
      agentId: "refresh-agent",
      roomId: "refresh-room",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { fixture_step: "allow" },
    },
  };
}

function messageCharacters(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message === "string") total += message.length;
    else if (message && typeof message === "object" && "content" in message) {
      total += JSON.stringify(message.content).length;
    }
  }
  return total;
}

function installStepTool(execute: (sequence: number) => Promise<string> | string): void {
  const catalog = new ToolCatalog();
  const schema = z.object({ sequence: z.number().int().positive() });
  catalog.register({
    name: "fixture_step",
    category: "development",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: "fixture_step",
      description: "Advance one deterministic test step.",
      schema,
      func: async (input: unknown) => execute(schema.parse(input).sequence),
    }),
  });
  initToolCatalog(catalog);
}

beforeEach(() => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  setStubModel(null);
  clearToolCatalog();
  _resetAgentTurnContextsForTests();
});

afterAll(() => {
  setStubModel(null);
  clearToolCatalog();
  _resetAgentTurnContextsForTests();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  if (previousToolCallLogging === undefined) delete process.env["NAUTILO_LOG_TOOL_CALLS"];
  else process.env["NAUTILO_LOG_TOOL_CALLS"] = previousToolCallLogging;
  mock.restore();
});

test("compiled graph keeps more than one hundred visible text/tool segments bounded and exactly once", async () => {
  const cycleCount = 101;
  const executions: number[] = [];
  const providerCharacters: number[] = [];
  let modelCalls = 0;
  let finalResponses = 0;
  installStepTool((sequence) => {
    executions.push(sequence);
    return `completed:${sequence}`;
  });
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async (messages) => {
      providerCharacters.push(messageCharacters(messages));
      modelCalls += 1;
      if (modelCalls <= cycleCount) {
        return new AIMessage({
          id: `assistant-step-${modelCalls}`,
          content: `Visible progress ${modelCalls}.`,
          tool_calls: [{
            id: `tool-step-${modelCalls}`,
            name: "fixture_step",
            args: { sequence: modelCalls },
          }],
        });
      }
      finalResponses += 1;
      return new AIMessage({ id: "assistant-final", content: "All steps complete." });
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const request = new HumanMessage({ id: "accepted-long-run", content: "Run every step." });
  const config = {
    configurable: { thread_id: "foreground-refresh-long-run" },
    recursionLimit: 5_000,
    version: "v2",
  };
  let refreshes = 0;
  for await (const _event of streamForegroundGraph(graph, graphInput(request), config, {
    rebuildForegroundContext: async ({ state, request: refresh }) => {
      refreshes += 1;
      expect(refresh.reason).toBe("visible_assistant_text");
      const latestCall = [...state.messages].reverse().find((message) =>
        AIMessage.isInstance(message) && message.tool_calls?.length);
      expect(latestCall && AIMessage.isInstance(latestCall)).toBe(true);
      for (const call of latestCall && AIMessage.isInstance(latestCall)
        ? latestCall.tool_calls ?? []
        : []) {
        expect(state.messages.filter((message) =>
          ToolMessage.isInstance(message) && message.tool_call_id === call.id)).toHaveLength(1);
      }
      return [request];
    },
  })) {
    // Drain every real graph event; completion is asserted from checkpoint.
  }

  expect(refreshes).toBe(cycleCount);
  expect(modelCalls).toBe(cycleCount + 1);
  expect(finalResponses).toBe(1);
  expect(executions).toEqual(Array.from({ length: cycleCount }, (_, index) => index + 1));
  expect(Math.max(...providerCharacters)).toBeLessThan(100_000);
  const checkpoint = await graph.getState(config);
  const messages = checkpoint?.values["messages"] as BaseMessage[];
  expect(messages.filter((message) => message.id === "assistant-final")).toHaveLength(1);
  expect(checkpoint?.values["foregroundContextRefresh"]).toBeNull();
}, 60_000);

test("compiled graph refreshes tool-only pressure before a doomed provider call", async () => {
  const providerCharacters: number[] = [];
  let executions = 0;
  let modelCalls = 0;
  installStepTool(() => {
    executions += 1;
    return "x".repeat(4_200_000);
  });
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async (messages) => {
      providerCharacters.push(messageCharacters(messages));
      modelCalls += 1;
      if (modelCalls === 1) {
        return new AIMessage({
          id: "assistant-pressure-tool",
          content: "",
          tool_calls: [{ id: "pressure-tool", name: "fixture_step", args: { sequence: 1 } }],
        });
      }
      if (modelCalls === 2) {
        return new AIMessage({ id: "assistant-pressure-final", content: "Pressure handled." });
      }
      throw new Error("Unexpected provider replay after pressure refresh");
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const request = new HumanMessage({ id: "accepted-pressure", content: "Read the large result once." });
  const config = {
    configurable: { thread_id: "foreground-refresh-pressure" },
    recursionLimit: 200,
    version: "v2",
  };
  const reasons: string[] = [];
  for await (const _event of streamForegroundGraph(graph, graphInput(request), config, {
    rebuildForegroundContext: async ({ request: refresh }) => {
      reasons.push(refresh.reason);
      return [request];
    },
  })) {
    // Drain.
  }

  expect(reasons).toEqual(["context_pressure"]);
  expect(executions).toBe(1);
  expect(modelCalls).toBe(2);
  expect(providerCharacters).toHaveLength(2);
  expect(providerCharacters[1]!).toBeLessThan(100_000);
});

test("compiled graph rejects an unchanged oversized rebuild without refreshing again", async () => {
  let modelCalls = 0;
  let rebuilds = 0;
  installStepTool(() => "x".repeat(4_200_000));
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      return new AIMessage({
        id: "assistant-unchanged-tool",
        content: "",
        tool_calls: [{ id: "unchanged-tool", name: "fixture_step", args: { sequence: 1 } }],
      });
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const request = new HumanMessage({ id: "accepted-unchanged", content: "Read the large result once." });
  const config = {
    configurable: { thread_id: "foreground-refresh-unchanged" },
    recursionLimit: 200,
    version: "v2",
  };
  const run = async () => {
    for await (const _event of streamForegroundGraph(graph, graphInput(request), config, {
      rebuildForegroundContext: async ({ state, request: refresh }) => {
        rebuilds += 1;
        expect(refresh.reason).toBe("context_pressure");
        return state.messages;
      },
    })) {
      // Drain.
    }
  };

  expect(run()).rejects.toMatchObject({ code: "NAUTILO_PREPARED_CONTEXT_EXCEEDED" });
  expect(rebuilds).toBe(1);
  expect(modelCalls).toBe(1);
});

test("compiled graph parks a visible question and refreshes only after the resumed reply", async () => {
  installStepTool(() => "unused");
  const providerHumanMessages: string[][] = [];
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async (messages) => {
      providerHumanMessages.push(messages.flatMap((message) =>
        HumanMessage.isInstance(message) && typeof message.content === "string"
          ? [message.content]
          : []));
      modelCalls += 1;
      return modelCalls === 1
        ? new AIMessage({ id: "assistant-question", content: "Which option should I use?" })
        : new AIMessage({ id: "assistant-answer", content: "I used the first option." });
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const request = new HumanMessage({ id: "accepted-await", content: "Choose an option with me." });
  const config = {
    configurable: { thread_id: "foreground-refresh-await-reply" },
    recursionLimit: 200,
    version: "v2",
  };
  const input = {
    ...graphInput(request),
    awaitResponse: true,
    awaitRoomId: "refresh-room",
    awaitFromUserIds: ["refresh-owner"],
    awaitTaskId: "task",
    awaitTaskRunId: "run",
    awaitOwnerId: "refresh-owner",
  };
  let rebuilds = 0;
  const rebuild: RebuildForegroundContext = async ({ state }) => {
    rebuilds += 1;
    const humans = state.messages.filter((message) => HumanMessage.isInstance(message));
    expect(humans.map((message) => message.content)).toContain("Use the first option.");
    return humans;
  };

  for await (const _event of streamForegroundGraph(graph, input, config, {
    rebuildForegroundContext: rebuild,
  })) {
    // First segment parks with a pending, non-ready refresh.
  }
  expect(rebuilds).toBe(0);
  expect(modelCalls).toBe(1);

  for await (const _event of streamForegroundGraph(
    graph,
    new Command({ resume: { reply: "Use the first option.", fromUserId: "refresh-owner" } }),
    config,
    { rebuildForegroundContext: rebuild },
  )) {
    // The resumed reply is checkpointed before the ready refresh segment ends.
  }
  expect(rebuilds).toBe(1);
  expect(modelCalls).toBe(2);
  expect(providerHumanMessages[1]).toEqual([
    "Choose an option with me.",
    "Use the first option.",
  ]);
});
