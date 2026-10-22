import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { ChatModel } from "../../src/providers/types";
import { z } from "zod";

const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");
const actualSessionNotifications = await import(
  "../../src/notifications/session-notifications"
);
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getRoomAgentModelControlSelection: async () => null,
  getProfileDefaultModelControlSelection: async () => null,
  getCachedServerModelConfigRow: () => null,
}));
mock.module("../../src/notifications/session-notifications", () => ({
  ...actualSessionNotifications,
  drainSessionNotifications: async () => [],
}));

type GraphModule = typeof import("../../src/agent/graph");
type UniversalModule = typeof import("../../src/providers/universal");
type SettlementModule = typeof import(
  "../../src/graph/protected-task-node-settlement-scope"
);

let createNautiloGraph: GraphModule["createNautiloGraph"];
let setStubModel: UniversalModule["__setStubModelForTests"];
let createSettlementScope:
  SettlementModule["createProtectedTaskNodeSettlementScope"];
const previousTestMode = process.env["NAUTILO_TEST_MODE"];

beforeAll(async () => {
  ({ createNautiloGraph } = await import("../../src/agent/graph"));
  ({ __setStubModelForTests: setStubModel } = await import(
    "../../src/providers/universal"
  ));
  ({ createProtectedTaskNodeSettlementScope: createSettlementScope } =
    await import("../../src/graph/protected-task-node-settlement-scope"));
});

afterAll(() => {
  setStubModel?.(null);
  clearToolCatalog();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  mock.restore();
});

test("compiled graph retains a deferred tool node through abort", async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  const handlerStarted = Promise.withResolvers<void>();
  const releaseHandler = Promise.withResolvers<void>();
  const catalog = new ToolCatalog();
  catalog.register({
    name: "deferred_test_tool",
    exposure: "core",
    category: "development",
    trustTier: "standard",
    impact: "low",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: "deferred_test_tool",
      description: "Test-only deferred tool",
      schema: z.object({}).strict(),
      func: async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return "finished";
      },
    }),
  });
  initToolCatalog(catalog);

  let modelCalls = 0;
  const model: ChatModel = {
    bindTools: () => model,
    invoke: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{
              id: "deferred-call-1",
              name: "deferred_test_tool",
              args: {},
            }],
          })
        : new AIMessage("done");
    },
  };
  setStubModel(model);

  const controller = new AbortController();
  const settlement = createSettlementScope(controller.signal);
  const graph = createNautiloGraph(
    undefined,
    {
      resolveContext: async () => {
        throw new Error("unused in compiled settlement fixture");
      },
      buildEnvelope: async () => {
        throw new Error("unused in compiled settlement fixture");
      },
      checkToolAccess: async () => ({ type: "allow" as const }),
      routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
    },
    { protectedTaskNodeSettlementScope: settlement },
  );
  const graphRun = graph.invoke({
    messages: [new HumanMessage("Run the deferred test tool")],
    model: "openai:gpt-5.5-2026-04-23",
    userId: "owner-1",
    causalHumanUserId: "owner-1",
    agentId: "agent-1",
    actorRole: "owner",
    roomId: "room-1",
    turnId: "turn-1",
    currentThreadId: "thread-1",
    langgraphThreadId: "thread-1",
    memoryAccessEnvelope: {
      memoryMode: "namespace",
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { deferred_test_tool: "allow" },
    },
    toolWhitelist: ["deferred_test_tool"],
    activatedToolNames: ["deferred_test_tool"],
    activatedToolLeases: [],
    engagedSkillNames: [],
    currentFolder: "/tmp",
    workspacePath: "/tmp",
  }, {
    configurable: { thread_id: "compiled-protected-settlement" },
    signal: controller.signal,
  }).then(
    () => undefined,
    () => undefined,
  );

  await handlerStarted.promise;
  controller.abort();
  const draining = settlement.closeAndWait();
  let drained = false;
  void draining.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  let lateBodyStarted = false;
  await settlement.run("post_model", () => {
    lateBodyStarted = true;
  }).catch((error: unknown) => {
    expect(error).toBeInstanceOf(Error);
  });
  expect(lateBodyStarted).toBe(false);

  releaseHandler.resolve();
  await draining;
  await graphRun;
  expect(drained).toBe(true);
});

test("real graph observes a fenced consumer failure before its next node effect", async () => {
  const schema = Annotation.Root({ value: Annotation<number>() });
  const settlement = createSettlementScope();
  const consumerFailure = new Error("protected transcript publication failed");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  let secondNodeStarted = false;
  try {
    const graph = new StateGraph(schema)
      .addNode("first", () => settlement.run(
        "agent",
        () => ({ value: 1 }),
      ))
      .addNode("second", () => settlement.run("post_model", () => {
        secondNodeStarted = true;
        return { value: 2 };
      }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();
    let observed: unknown;
    try {
      for await (const event of graph.streamEvents(
        { value: 0 },
        { version: "v2", callbacks: [] },
      )) {
        if (event.event === "on_chain_end" && event.name === "first") {
          settlement.fail(consumerFailure);
        }
      }
    } catch (error) {
      observed = error;
    }
    await settlement.closeAndWait();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(observed).toBe(consumerFailure);
    expect(secondNodeStarted).toBe(false);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("real event stream abort drains an admitted node without a later effect", async () => {
  const schema = Annotation.Root({ value: Annotation<number>() });
  const authorization = new AbortController();
  const settlement = createSettlementScope(authorization.signal);
  const admittedStarted = Promise.withResolvers<void>();
  const releaseAdmitted = Promise.withResolvers<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  let postAbortEventEffects = 0;
  let laterNodeStarted = false;
  try {
    const graph = new StateGraph(schema)
      .addNode("admitted", () => settlement.run("agent", async () => {
        admittedStarted.resolve();
        await releaseAdmitted.promise;
        return { value: 1 };
      }))
      .addNode("later", () => settlement.run("post_model", () => {
        laterNodeStarted = true;
        return { value: 2 };
      }))
      .addEdge(START, "admitted")
      .addEdge("admitted", "later")
      .addEdge("later", END)
      .compile();
    const streamResult = (async () => {
      try {
        for await (const _event of graph.streamEvents(
          { value: 0 },
          {
            version: "v2",
            callbacks: [],
            signal: authorization.signal,
          },
        )) {
          if (authorization.signal.aborted) continue;
          postAbortEventEffects += 1;
        }
        return null;
      } catch (error) {
        return error;
      }
    })();

    await admittedStarted.promise;
    authorization.abort(new Error("authorization revoked"));
    const eventEffectsAtAbort = postAbortEventEffects;
    const draining = settlement.closeAndWait();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAdmitted.resolve();
    await streamResult;
    await draining;
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(postAbortEventEffects).toBe(eventEffectsAtAbort);
    expect(laterNodeStarted).toBe(false);
    expect(unhandled).toEqual([]);
  } finally {
    releaseAdmitted.resolve();
    process.off("unhandledRejection", onUnhandled);
  }
});
