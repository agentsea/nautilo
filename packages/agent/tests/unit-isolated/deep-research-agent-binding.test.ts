/** Actual agent-node schema binding with an isolated model; no provider, database, or tool execution. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { ChatModel } from "../../src/providers/types";
import { __setStubModelForTests } from "../../src/providers/universal";
import { registerAllTools } from "../../src/tools/register-all";

const trust = await import("@nautilo/trust");
spyOn(trust, "assertCanUseServerProviderCredentials").mockResolvedValue(undefined);
const { agentNode } = await import("../../src/nodes/agent");

const MODEL = "anthropic:claude-sonnet-4-6";
const previousTestMode = process.env["NAUTILO_TEST_MODE"];
const previousTavilyKey = process.env["TAVILY_API_KEY"];
const boundToolNames: string[][] = [];

const model: ChatModel = {
  bindTools(tools) {
    boundToolNames.push(tools.flatMap((tool) => (
      tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
        ? [tool.name]
        : []
    )));
    return model;
  },
  async invoke() {
    return new AIMessage("Binding inspected.");
  },
};

beforeAll(() => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["TAVILY_API_KEY"] = "deep-research-binding-fixture";
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  __setStubModelForTests(model);
});

afterAll(() => {
  __setStubModelForTests(null);
  clearToolCatalog();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  if (previousTavilyKey === undefined) delete process.env["TAVILY_API_KEY"];
  else process.env["TAVILY_API_KEY"] = previousTavilyKey;
});

function state(
  trustedExecutionEntrypoint: NautiloState["trustedExecutionEntrypoint"],
  subagentDepth: number,
): NautiloState {
  const prompt = new HumanMessage("Research the fixture.");
  return {
    messages: [prompt],
    preparedMessages: [prompt],
    model: MODEL,
    modelFallbackMode: "none",
    userId: "owner-1",
    causalHumanUserId: "human-1",
    actorRole: "owner",
    agentId: "agent-1",
    roomId: "room-1",
    approvalLaneKey: "room:room-1",
    currentThreadId: "room:room-1",
    turnId: "turn-1",
    subagentDepth,
    subagentRun: subagentDepth > 0,
    taskRun: trustedExecutionEntrypoint === "background.task",
    trustedExecutionEntrypoint,
    activatedToolNames: ["run_deep_research"],
    toolWhitelist: ["run_deep_research"],
    foregroundModelControlSnapshot: {
      roomSelection: null,
      agentSelection: null,
      serverReasoningPolicy: null,
      turnModelId: null,
    },
  } as NautiloState;
}

test("agent provider binding exposes deep research only to a valid foreground main turn", async () => {
  boundToolNames.length = 0;

  await agentNode(state("foreground.main", 0));
  await agentNode(state("foreground.fork", 0));
  await agentNode(state("background.task", 1));

  expect(boundToolNames).toEqual([
    ["run_deep_research"],
    [],
    [],
  ]);
});
