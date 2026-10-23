/** Isolated so funding, provider-route, and database mocks cannot leak into other suites. */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";

const MODEL_ID = "openrouter:openai/gpt-5.6-sol";
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getCachedServerModelConfigRow: () => ({ preferSurplus: true }),
  kickServerModelConfigRefresh: () => {},
}));

const actualSurplusRoute = await import("../../src/providers/surplus-route");
const hydrateSurplusChatCatalog = mock(async () => {
  throw new Error("unexpected Surplus catalogue discovery");
});
mock.module("../../src/providers/surplus-route", () => ({
  ...actualSurplusRoute,
  hydrateSurplusChatCatalog,
}));

const invocation = mock(async (..._args: unknown[]) => ({
  response: new AIMessage("Direct provider completed the request."),
  modelUsed: MODEL_ID,
}));
mock.module("../../src/utils/chat-model-invocation", () => ({
  invokeChatModelWithFallback: invocation,
  resolvePreparedMessageBudget: async () => 4_096,
  estimateBoundToolTokens: () => 0,
}));

const { agentNode } = await import("../../src/nodes/agent");
const previousOpenRouterKey = process.env["OPENROUTER_API_KEY"];
const previousSurplusKey = process.env["SURPLUS_API_KEY"];

beforeEach(() => {
  hydrateSurplusChatCatalog.mockClear();
  invocation.mockClear();
  process.env["OPENROUTER_API_KEY"] = "synthetic-direct-key";
  process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
  initToolCatalog(new ToolCatalog());
});

afterAll(() => {
  clearToolCatalog();
  if (previousOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = previousOpenRouterKey;
  if (previousSurplusKey === undefined) delete process.env["SURPLUS_API_KEY"];
  else process.env["SURPLUS_API_KEY"] = previousSurplusKey;
});

function state(): NautiloState {
  const prompt = new HumanMessage("Complete this admitted direct-provider task.");
  return {
    model: MODEL_ID,
    subagentDepth: 1,
    taskRun: true,
    trustedExecutionEntrypoint: "background.task",
    modelFallbackMode: "none",
    preparedMessages: [prompt],
    messages: [prompt],
    userId: "task-owner",
    causalHumanUserId: "task-owner",
    agentId: "task-agent",
    roomId: null,
    turnId: "direct-admission-turn",
    actorRole: "owner",
    memoryAccessEnvelope: null,
    toolWhitelist: [],
    activatedToolNames: [],
    activatedToolLeases: [],
    currentThreadId: "direct-admission-thread",
    currentFolder: "",
    workspacePath: "",
  } as unknown as NautiloState;
}

function fundingSession(providerRoute?: string): ForegroundChatFundingSession {
  return {
    kind: "server",
    ...(providerRoute === undefined
      ? {}
      : { admission: { modelId: MODEL_ID, binding: { kind: "server", providerRoute } } }),
    runAttempt: async () => { throw new Error("Provider boundary is mocked"); },
    recheckAttempt: async () => {},
  };
}

test("an admitted direct-provider attempt skips unrelated Surplus catalogue discovery", async () => {
  const session = fundingSession("openrouter");

  const result = await agentNode(
    state(), undefined, undefined, false, undefined, undefined, session,
  );

  expect(result.model).toBe(MODEL_ID);
  expect(hydrateSurplusChatCatalog).not.toHaveBeenCalled();
  expect(invocation).toHaveBeenCalledTimes(1);
  expect(invocation.mock.calls[0]?.[7]).toMatchObject({
    fundingSession: session,
    modelFallbackMode: "none",
  });
});

test.each([
  ["an unbound attempt", undefined],
  ["an admitted Surplus attempt", "surplus"],
] as const)("%s still hydrates the Surplus catalogue", async (_label, providerRoute) => {
  const thrown = await agentNode(
    state(), undefined, undefined, false, undefined, undefined, fundingSession(providerRoute),
  ).catch((error: unknown) => error);

  expect(thrown).toEqual(new Error("unexpected Surplus catalogue discovery"));
  expect(hydrateSurplusChatCatalog).toHaveBeenCalledTimes(1);
  expect(invocation).not.toHaveBeenCalled();
});
