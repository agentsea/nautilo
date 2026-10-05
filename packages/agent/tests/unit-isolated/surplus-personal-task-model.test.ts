/** Isolated so funding and database module mocks cannot leak into other suites. */
import { afterAll, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";

const MODEL_ID = "openrouter:openai/gpt-5.6-sol";
let preferSurplus = false;
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getCachedServerModelConfigRow: () => ({ preferSurplus }),
  kickServerModelConfigRefresh: () => {},
}));
const invocation = mock(async (..._args: unknown[]) => ({
  response: new AIMessage("personal Task completed"), modelUsed: MODEL_ID,
}));
mock.module("../../src/utils/chat-model-invocation", () => ({
  invokeChatModelWithFallback: invocation,
  resolvePreparedMessageBudget: async () => 4_096,
}));
const { agentNode } = await import("../../src/nodes/agent");
afterAll(() => clearToolCatalog());

test.each([false, true])("an exact personal Task keeps its admitted model with server Surplus preference %s", async (policyEnabled) => {
  preferSurplus = policyEnabled;
  invocation.mockClear();
  for (const key of ["OPENROUTER_API_KEY", "NAUTILO_GATEWAY_API_KEY", "NAUTILO_TEST_MODE"]) {
    delete process.env[key];
  }
  process.env["SURPLUS_API_KEY"] = "synthetic-server-surplus-key";
  initToolCatalog(new ToolCatalog());
  const fundingSession: ForegroundChatFundingSession = {
    kind: "personal",
    runAttempt: async () => { throw new Error("Provider boundary is mocked"); },
    recheckAttempt: async () => {},
  };
  const result = await agentNode({
    model: MODEL_ID,
    subagentDepth: 1,
    taskRun: true,
    trustedExecutionEntrypoint: "background.task",
    modelFallbackMode: "none",
    preparedMessages: [new HumanMessage("Synthetic tool-free Task")],
    messages: [new HumanMessage("Synthetic tool-free Task")],
    userId: "task-owner", causalHumanUserId: "task-owner",
    agentId: "task-agent", roomId: null, turnId: "personal-task-turn",
    actorRole: "owner", memoryAccessEnvelope: null,
    toolWhitelist: [], activatedToolNames: [], activatedToolLeases: [],
    currentThreadId: "personal-task-thread", currentFolder: "", workspacePath: "",
  } as unknown as NautiloState, undefined, undefined, false, undefined, undefined, fundingSession);
  expect(result.model).toBe(MODEL_ID);
  expect(invocation).toHaveBeenCalledTimes(1);
  const args = invocation.mock.calls[0]!;
  expect(args[1]).toEqual([]);
  expect(args[2]).toBe(MODEL_ID);
  expect(args[7]).toMatchObject({ fundingSession, modelFallbackMode: "none" });
});
