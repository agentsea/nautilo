import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
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
const unexpectedIo: string[] = [];
function rejectExternalIo(operation: string): never {
  unexpectedIo.push(operation);
  throw new Error(`External I/O is forbidden in the graph fixture: ${operation}`);
}
const previousFetch = globalThis.fetch;
globalThis.fetch = mock(async () => rejectExternalIo("fetch")) as unknown as typeof fetch;
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  agentDb: new Proxy({}, {
    get: (_target, property) => rejectExternalIo(`agentDb.${String(property)}`),
  }),
  getRoomAgentModelControlSelection: async () => null,
  getProfileDefaultModelControlSelection: async () => null,
  getCachedServerModelConfigRow: () => null,
  kickServerModelConfigRefresh: () => {},
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));

// A stub provider does not bypass fallback preference reads. Leaving this
// reader live silently waits for unavailable Postgres before EVERY model call.
mock.module("../../src/utils/resolve-fallback-policy", () => ({
  resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
}));
const { configureRuntimeModelCatalog, resetRuntimeModelCatalog } = await import(
  "../../src/config/model-catalog/runtime-catalog"
);
configureRuntimeModelCatalog({ catalogPointerUrl: null });

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

function installStepTool(
  execute: (sequence: number) => Promise<string> | string,
  approval: "none" | "confirm" = "none",
): void {
  const catalog = new ToolCatalog();
  const schema = z.object({ sequence: z.number().int().positive() });
  catalog.register({
    name: "fixture_step",
    category: "development",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    requiresApproval: approval === "confirm",
    ...(approval === "confirm" ? { approvalLevel: "confirm" as const } : {}),
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

function providerStepResponse(
  assistantId: string,
  providerCallId: string,
  sequence: number,
  visibleText: string,
): AIMessage {
  return new AIMessage({
    id: assistantId,
    content: [
      { type: "text", text: visibleText },
      {
        type: "tool_use",
        id: providerCallId,
        name: "fixture_step",
        input: { sequence },
      },
    ],
    tool_calls: [{
      id: providerCallId,
      name: "fixture_step",
      args: { sequence },
    }],
    additional_kwargs: {
      tool_calls: [{
        id: providerCallId,
        type: "function",
        function: {
          name: "fixture_step",
          arguments: JSON.stringify({ sequence }),
        },
      }],
    },
  });
}

function assertCallRepresentationsMatch(message: AIMessage): string[] {
  const structuredCalls = message.tool_calls ?? [];
  const structuredIds = structuredCalls.flatMap((call) =>
    typeof call.id === "string" ? [call.id] : [],
  );
  expect(structuredIds).toHaveLength(structuredCalls.length);
  const contentIds = Array.isArray(message.content)
    ? message.content.flatMap((block) =>
      block && typeof block === "object"
        && "type" in block && block.type === "tool_use"
        && "id" in block && typeof block.id === "string"
        ? [block.id]
        : [])
    : [];
  const raw = message.additional_kwargs?.["tool_calls"];
  const rawIds = Array.isArray(raw)
    ? raw.flatMap((call) =>
      call && typeof call === "object"
        && "id" in call && typeof call.id === "string"
        ? [call.id]
        : [])
    : [];
  expect(contentIds).toEqual(structuredIds);
  expect(rawIds).toEqual(structuredIds);
  return structuredIds;
}

const activeRuns: Array<{ controller: AbortController; settled: Promise<void> }> = [];

function drainGraph(...[graph, input, config, options]: Parameters<typeof streamForegroundGraph>): Promise<void> {
  const controller = new AbortController();
  const run = (async () => {
    for await (const _event of streamForegroundGraph(graph, input, {
      ...config,
      signal: controller.signal,
    }, options)) {
      // Exercise every production graph event, including checkpoint completion.
    }
  })();
  // Handle rejection immediately, even if the runner times out before the test
  // can await it. Teardown drains this same run before replacing global stubs.
  activeRuns.push({ controller, settled: run.then(() => {}, () => {}) });
  return run;
}

async function abortAndDrainGraphRuns(): Promise<void> {
  for (const { controller } of activeRuns) controller.abort();
  await Promise.all(activeRuns.map(({ settled }) => settled));
  activeRuns.length = 0;
}

beforeEach(() => {
  unexpectedIo.length = 0;
  process.env["NAUTILO_TEST_MODE"] = "stub";
  setStubModel(null);
  clearToolCatalog();
  _resetAgentTurnContextsForTests();
});

afterEach(async () => {
  await abortAndDrainGraphRuns();
  // Detect accidental I/O even when a production best-effort reader swallowed
  // the guard's exception and returned an apparently successful fallback.
  expect(unexpectedIo).toEqual([]);
});

afterAll(() => {
  globalThis.fetch = previousFetch;
  resetRuntimeModelCatalog();
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
  await drainGraph(graph, graphInput(request), config, {
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
  });

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
  await drainGraph(graph, graphInput(request), config, {
    rebuildForegroundContext: async ({ request: refresh }) => {
      reasons.push(refresh.reason);
      return [request];
    },
  });

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
    await drainGraph(graph, graphInput(request), config, {
      rebuildForegroundContext: async ({ state, request: refresh }) => {
        rebuilds += 1;
        expect(refresh.reason).toBe("context_pressure");
        return state.messages;
      },
    });
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

  await drainGraph(graph, input, config, {
    rebuildForegroundContext: rebuild,
  });
  expect(rebuilds).toBe(0);
  expect(modelCalls).toBe(1);

  await drainGraph(
    graph,
    new Command({ resume: { reply: "Use the first option.", fromUserId: "refresh-owner" } }),
    config,
    { rebuildForegroundContext: rebuild },
  );
  expect(rebuilds).toBe(1);
  expect(modelCalls).toBe(2);
  expect(providerHumanMessages[1]).toEqual([
    "Choose an option with me.",
    "Use the first option.",
  ]);
});

test("fresh repeated provider call ids stay distinct through model cycles, refresh, and a later user turn", async () => {
  const providerCallId = "provider-reused-call";
  const executions: number[] = [];
  installStepTool((sequence) => {
    executions.push(sequence);
    return "identical-result";
  });
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      if (modelCalls === 1 || modelCalls === 2 || modelCalls === 4) {
        return providerStepResponse(
          `assistant-call-${modelCalls}`,
          providerCallId,
          1,
          `Visible progress ${modelCalls}.`,
        );
      }
      if (modelCalls === 3 || modelCalls === 5) {
        return new AIMessage({
          id: `assistant-final-${modelCalls}`,
          content: `Finished turn ${modelCalls === 3 ? 1 : 2}.`,
        });
      }
      throw new Error("Unexpected provider cycle");
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const firstRequest = new HumanMessage({ id: "accepted-identity-first", content: "Run twice." });
  const config = {
    configurable: { thread_id: "canonical-tool-identity-across-turns" },
    recursionLimit: 200,
    version: "v2",
  };
  const refreshedCallIds: string[] = [];
  const rebuild: RebuildForegroundContext = async ({ state }) => {
    const latest = [...state.messages].reverse().find((message) =>
      AIMessage.isInstance(message) && message.tool_calls?.length);
    expect(latest && AIMessage.isInstance(latest)).toBe(true);
    if (latest && AIMessage.isInstance(latest)) {
      const [callId] = assertCallRepresentationsMatch(latest);
      expect(callId).toBeDefined();
      expect(state.messages.filter((message) =>
        ToolMessage.isInstance(message) && message.tool_call_id === callId)).toHaveLength(1);
      refreshedCallIds.push(callId!);
    }
    return state.messages.filter((message) => HumanMessage.isInstance(message));
  };

  await drainGraph(graph, graphInput(firstRequest), config, {
    rebuildForegroundContext: rebuild,
  });
  const secondRequest = new HumanMessage({ id: "accepted-identity-second", content: "Run once more." });
  await drainGraph(graph, {
    ...graphInput(secondRequest),
    turnId: "refresh-turn-second",
  }, config, {
    rebuildForegroundContext: rebuild,
  });

  expect(modelCalls).toBe(5);
  expect(executions).toEqual([1, 1, 1]);
  expect(refreshedCallIds).toHaveLength(3);
  expect(new Set(refreshedCallIds).size).toBe(3);
});

test("same-response duplicate provider ids execute as separate canonical invocations", async () => {
  const providerCallId = "provider-duplicate-in-batch";
  const executions: number[] = [];
  installStepTool((sequence) => {
    executions.push(sequence);
    return `completed:${sequence}`;
  });
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      if (modelCalls > 1) {
        return new AIMessage({ id: "assistant-batch-final", content: "Both calls completed." });
      }
      return new AIMessage({
        id: "assistant-batch",
        content: [
          { type: "tool_use", id: providerCallId, name: "fixture_step", input: { sequence: 1 } },
          { type: "tool_use", id: providerCallId, name: "fixture_step", input: { sequence: 2 } },
        ],
        tool_calls: [
          { id: providerCallId, name: "fixture_step", args: { sequence: 1 } },
          { id: providerCallId, name: "fixture_step", args: { sequence: 2 } },
        ],
        additional_kwargs: {
          tool_calls: [1, 2].map((sequence) => ({
            id: providerCallId,
            type: "function",
            function: { name: "fixture_step", arguments: JSON.stringify({ sequence }) },
          })),
        },
      });
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const config = {
    configurable: { thread_id: "canonical-tool-identity-same-response" },
    recursionLimit: 200,
    version: "v2",
  };
  await drainGraph(
    graph,
    graphInput(new HumanMessage({ id: "accepted-batch", content: "Run both steps." })),
    config,
  );

  expect(executions).toEqual([1, 2]);
    const checkpoint = await graph.getState(config);
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) {
      throw new Error("Duplicate-call graph did not persist a checkpoint");
    }
    const messages = checkpoint.values["messages"] as BaseMessage[];
  const callMessage = messages.find((message): message is AIMessage =>
    AIMessage.isInstance(message) && message.id === "assistant-batch");
    expect(callMessage).toBeDefined();
    if (callMessage === undefined) {
      throw new Error("Duplicate-call graph did not persist its AI response");
    }
    const canonicalIds = assertCallRepresentationsMatch(callMessage);
  expect(canonicalIds).toHaveLength(2);
  expect(new Set(canonicalIds).size).toBe(2);
  for (const canonicalId of canonicalIds) {
    expect(messages.filter((message) =>
      ToolMessage.isInstance(message) && message.tool_call_id === canonicalId)).toHaveLength(1);
  }
});

test("approval checkpoint resume preserves the admitted canonical call id and executes once", async () => {
  const providerCallId = "provider-approval-call";
  const executions: number[] = [];
  installStepTool((sequence) => {
    executions.push(sequence);
    return "approved-result";
  }, "confirm");
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? providerStepResponse("assistant-approval", providerCallId, 1, "I need approval.")
        : new AIMessage({ id: "assistant-approved-final", content: "Approved call completed." });
    },
  };
  const approvalPolicy: PolicyResolver = {
    ...policy,
    checkToolAccess: async () => ({
      type: "require_approval",
      route: { type: "prove_it", approvers: ["refresh-owner"] },
    }),
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), approvalPolicy, {
    matchCommandApproval: async () => null,
    matchCapabilityApproval: async () => null,
  });
  const config = {
    configurable: { thread_id: "canonical-tool-identity-approval-resume" },
    recursionLimit: 200,
    version: "v2",
  };
  const request = new HumanMessage({ id: "accepted-approval", content: "Run the approved step." });

  await drainGraph(graph, {
    ...graphInput(request),
    threadId: 1,
  }, config);
  expect(executions).toEqual([]);
    const parked = await graph.getState(config);
    expect(parked).toBeDefined();
    if (parked === undefined) {
      throw new Error("Approval graph did not persist its parked checkpoint");
    }
    const parkedMessages = parked.values["messages"] as BaseMessage[];
  const parkedCall = parkedMessages.find((message): message is AIMessage =>
    AIMessage.isInstance(message) && message.id === "assistant-approval");
  expect(parkedCall).toBeDefined();
  if (parkedCall === undefined) throw new Error("Approval checkpoint omitted the admitted call");
  const [parkedCallId] = assertCallRepresentationsMatch(parkedCall);
  expect(parkedCallId).toBeDefined();
  if (parkedCallId === undefined) throw new Error("Approval checkpoint call has no canonical id");

  await drainGraph(
    graph,
    new Command({ resume: { approved: true, verb: "once" } }),
    config,
  );
  expect(executions).toEqual([1]);
    const resumed = await graph.getState(config);
    expect(resumed).toBeDefined();
    if (resumed === undefined) {
      throw new Error("Approval graph did not persist its resumed checkpoint");
    }
    const resumedMessages = resumed.values["messages"] as BaseMessage[];
  const resumedCall = resumedMessages.find((message): message is AIMessage =>
    AIMessage.isInstance(message) && message.id === "assistant-approval");
  expect(resumedCall).toBeDefined();
  if (resumedCall === undefined) throw new Error("Approval resume omitted the admitted call");
  expect(assertCallRepresentationsMatch(resumedCall)).toEqual([parkedCallId]);
  expect(resumedMessages.filter((message) =>
    ToolMessage.isInstance(message) && message.tool_call_id === parkedCallId)).toHaveLength(1);
});

test("legacy approval checkpoint resumes its original provider-shaped call exactly once", async () => {
  const legacyCallId = "legacy-provider-call:0";
  const executions: number[] = [];
  installStepTool((sequence) => {
    executions.push(sequence);
    return "legacy-approved-result";
  }, "confirm");
  const approvalPolicy: PolicyResolver = {
    ...policy,
    checkToolAccess: async () => ({
      type: "require_approval",
      route: { type: "prove_it", approvers: ["refresh-owner"] },
    }),
  };
  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      return new AIMessage({ id: "assistant-legacy-final", content: "Legacy call completed." });
    },
  };
  setStubModel(model);
  const graph = createNautiloGraph(new MemorySaver(), approvalPolicy, {
    matchCommandApproval: async () => null,
    matchCapabilityApproval: async () => null,
  });
  const config = {
    configurable: { thread_id: "legacy-tool-identity-approval-resume" },
    recursionLimit: 200,
    version: "v2",
  };
  const request = new HumanMessage({ id: "accepted-legacy-approval", content: "Resume the parked step." });
  const legacyResponse = providerStepResponse(
    "assistant-legacy-approval",
    legacyCallId,
    1,
    "This old checkpoint needs approval.",
  );
  expect(legacyResponse.additional_kwargs).not.toHaveProperty("nautilo_tool_invocations");

  // Model a checkpoint written before ingress normalization by installing the
  // old provider-shaped response as the agent node's completed output. The
  // production preflight and approval nodes then park and resume it normally.
  await graph.updateState(config, {
    ...graphInput(request),
    threadId: 2,
    messages: [request, legacyResponse],
  }, "agent");
  for await (const _event of graph.streamEvents(null, config)) {
    // Drain through the real post-model approval interrupt.
  }
  expect(executions).toEqual([]);
  expect(modelCalls).toBe(0);
    const parked = await graph.getState(config);
    expect(parked).toBeDefined();
    if (parked === undefined) {
      throw new Error("Legacy approval graph did not persist its parked checkpoint");
    }
    const parkedMessages = parked.values["messages"] as BaseMessage[];
  const parkedCall = parkedMessages.find((message): message is AIMessage =>
    AIMessage.isInstance(message) && message.id === "assistant-legacy-approval");
  expect(parkedCall).toBeDefined();
  if (parkedCall === undefined) throw new Error("Legacy approval checkpoint omitted its call");
  expect(assertCallRepresentationsMatch(parkedCall)).toEqual([legacyCallId]);
  expect(parkedCall.additional_kwargs).not.toHaveProperty("nautilo_tool_invocations");

  await drainGraph(
    graph,
    new Command({ resume: { approved: true, verb: "once" } }),
    config,
  );
  expect(executions).toEqual([1]);
  expect(modelCalls).toBe(1);
    const resumed = await graph.getState(config);
    expect(resumed).toBeDefined();
    if (resumed === undefined) {
      throw new Error("Legacy approval graph did not persist its resumed checkpoint");
    }
    const resumedMessages = resumed.values["messages"] as BaseMessage[];
  const resumedCall = resumedMessages.find((message): message is AIMessage =>
    AIMessage.isInstance(message) && message.id === "assistant-legacy-approval");
  expect(resumedCall).toBeDefined();
  if (resumedCall === undefined) throw new Error("Legacy approval resume omitted its call");
  expect(assertCallRepresentationsMatch(resumedCall)).toEqual([legacyCallId]);
  expect(resumedCall.additional_kwargs).not.toHaveProperty("nautilo_tool_invocations");
  expect(resumedMessages.filter((message) =>
    ToolMessage.isInstance(message) && message.tool_call_id === legacyCallId)).toHaveLength(1);
});

test("fixture teardown aborts and drains a pending graph before replacing its model stub", async () => {
  let enteredProvider!: () => void;
  const providerEntered = new Promise<void>((resolve) => { enteredProvider = resolve; });
  let providerAborted = false;
  const blockedModel: ChatModel = {
    bindTools: () => blockedModel,
    invoke: async (_messages, options) => {
      const signal = options?.["signal"];
      if (!(signal instanceof AbortSignal)) throw new Error("Fixture graph did not forward its abort signal");
      return new Promise<AIMessage>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          providerAborted = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("Fixture graph aborted"));
        }, { once: true });
        enteredProvider();
      });
    },
  };
  installStepTool(() => "unused");
  setStubModel(blockedModel);
  const graph = createNautiloGraph(new MemorySaver(), policy);
  const request = new HumanMessage({ id: "accepted-abort", content: "Wait for cancellation." });
  const run = drainGraph(graph, graphInput(request), {
    configurable: { thread_id: "foreground-refresh-aborted-fixture" },
    recursionLimit: 200,
    version: "v2",
  });
  await providerEntered;
  await abortAndDrainGraphRuns();
  expect(run).rejects.toBeDefined();
  expect(providerAborted).toBe(true);

  let replacementCalls = 0;
  const replacementModel: ChatModel = {
    bindTools: () => replacementModel,
    invoke: async () => {
      replacementCalls += 1;
      return new AIMessage("Only the new graph uses this stub.");
    },
  };
  setStubModel(replacementModel);
  await drainGraph(createNautiloGraph(new MemorySaver(), policy), graphInput(request), {
    configurable: { thread_id: "foreground-refresh-after-aborted-fixture" },
    recursionLimit: 200,
    version: "v2",
  });
  expect(replacementCalls).toBe(1);
});
