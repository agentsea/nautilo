/** Real Agent graph/node and provider error classifier; only provider I/O and DB admission are replaced. */
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { ChatModel } from "../../src/providers/types";
import { __setStubModelForTests } from "../../src/providers/universal";
import { clearHealthCache } from "../../src/utils/model-health";

const marker = "PRIVATE_REPOSITORY_PROVIDER_ERROR_CANARY";
const cause = Object.assign(new Error(`bad request ${marker}`), { status: 400 });
let calls = 0;
const provider: ChatModel = {
  bindTools: () => provider,
  invoke: async () => { calls += 1; throw cause; },
};
const priorTestMode = process.env["NAUTILO_TEST_MODE"];
const db = await import("@nautilo/db");
const trust = await import("@nautilo/trust");
spyOn(db, "getCachedServerModelConfigRow").mockReturnValue(null);
spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
spyOn(trust, "assertCanUseServerProviderCredentials").mockResolvedValue(undefined);
const fallback = await import("../../src/utils/resolve-fallback-policy");
spyOn(fallback, "resolveFallbackPolicy").mockResolvedValue({ enabled: false, chain: [] });
const { agentNode } = await import("../../src/nodes/agent");
const preModel = await import("../../src/nodes/pre-model");
// Keep this test focused on the actual graph's model composition. Retrieval is
// unrelated authority and must not access a DB in a unit fixture.
spyOn(preModel, "preModelNode").mockImplementation(async state => ({ preparedMessages: state.messages }));
const { createNautiloGraph } = await import("../../src/agent/graph");

beforeAll(() => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  initToolCatalog(new ToolCatalog());
  __setStubModelForTests(provider);
});
beforeEach(() => { calls = 0; clearHealthCache(); });
afterAll(() => {
  __setStubModelForTests(null);
  clearToolCatalog();
  clearHealthCache();
  mock.restore();
  if (priorTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = priorTestMode;
});

function state() {
  return { messages: [new HumanMessage("Authorized private repository")],
    preparedMessages: [new HumanMessage("Authorized private repository")],
    model: "anthropic:claude-sonnet-4-6", modelFallbackMode: "none" as const,
    userId: "owner", causalHumanUserId: "owner", actorRole: "owner", agentId: "agent",
    roomId: "", currentThreadId: "task-thread", langgraphThreadId: "task-thread",
    turnId: "turn", subagentDepth: 1, taskRun: true, subagentRun: true,
    currentTaskId: "task", currentTaskRunId: "run", trustedExecutionEntrypoint: "background.task" as const } as NautiloState;
}

for (const confidential of [false, true]) {
  test(`actual agent node diagnostics preserve the trusted confidential choice (${confidential})`, async () => {
    const logger = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure: unknown = await agentNode(state(), undefined, undefined, false, undefined,
        undefined, undefined, confidential ? true : undefined).catch((error: unknown) => error);
      expect(failure).toBe(cause);
      expect(calls).toBe(1);
      expect(JSON.stringify(logger.mock.calls).includes(marker)).toBe(!confidential);
    } finally { logger.mockRestore(); }
  });

  test(`actual graph threads only its process-local confidential dependency (${confidential})`, async () => {
    const logger = spyOn(console, "error").mockImplementation(() => {});
    try {
      const graph = createNautiloGraph(undefined, null, confidential ? { confidential: true } : {});
      // A serialized lookalike must not turn on the private execution policy.
      const failure: unknown = await graph.invoke({ ...state(), confidential: true }).catch((error: unknown) => error);
      expect(failure).toBe(cause);
      expect(calls).toBe(1);
      expect(JSON.stringify(logger.mock.calls).includes(marker)).toBe(!confidential);
    } finally { logger.mockRestore(); }
  });
}
