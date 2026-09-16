import { expect, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import * as trust from "@nautilo/trust";
import { NautiloStateAnnotation } from "../../../agent/src/agent/state";
import * as graphs from "../../../agent/src/agent/graph";
import * as checkpoints from "../../../agent/src/checkpoints/checkpoint-saver";
import { runScopeSubagentUntilPause, type RunScopeSubagentOpts } from "../../../agent/src/subagents/scope-subagent/run";
import { freshForegroundActivationState } from "../../src/executors/langgraph-executor";
import { freshForkActivationState } from "../../src/executors/fork-langgraph-executor";

test("fresh main, report-back and fork inputs clear stale research channels through actual checkpoint reducers", async () => {
  const saver = new MemorySaver();
  const graph = new StateGraph(NautiloStateAnnotation).addNode("observe", () => ({})).addEdge(START, "observe").addEdge("observe", END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "foreground-recovery-reset" } };
  for (const fresh of [freshForegroundActivationState({}), freshForegroundActivationState({ metadata: { originatedBy: "task" } }), freshForkActivationState({})]) {
    await graph.invoke({ researchContextRecovery: { taskRunId: "old-run", throughIndex: 0, indexRef: "old-index", pendingRefs: ["old-reference"] }, researchContextPageBytes: 1234,
      researchContinuationRequired: true, subagentRun: true, taskRun: true }, config);
    const result = await graph.invoke(fresh, config);
    expect(result.researchContextRecovery).toBeNull();
    expect(result.researchContextPageBytes).toBeNull();
    expect(result.researchContinuationRequired).toBe(false);
    expect(result.subagentRun).toBe(false);
    expect(result.taskRun).toBe(false);
  }
});

test("actual scope runner sends fresh resets only on cold start; checkpoint and approval resumes retain parked state", async () => {
  const inputs: unknown[] = [];
  const fake = {
    invoke: async () => ({}),
    stream: async () => (async function* () { yield undefined; })(),
    streamEvents: async function* (input: unknown) { inputs.push(input); yield { event: "on_chain_start", name: "qualification" }; },
    getState: async () => ({ values: { messages: [new AIMessage("qualification response")] } }),
    updateState: async () => ({}),
  };
  const graph = spyOn(graphs, "createNautiloGraph").mockReturnValue(fake);
  const saver = spyOn(checkpoints, "createCheckpointSaver").mockReturnValue(new MemorySaver() as unknown as ReturnType<typeof checkpoints.createCheckpointSaver>);
  const policy = spyOn(trust, "getPolicyResolver").mockReturnValue(null);
  const opts = {
    parentThreadId: "parent", parentTurnId: "turn", parentOwnerId: "owner", scopeId: "scope", brief: "Perform this separate task.",
    toolWhitelist: ["file"], subEnvelope: { memoryMode: "scope", ownerId: "owner", actorId: "owner", agentId: "agent", roomId: "", scopeId: "scope", toolPolicy: {} },
    actorRole: "owner", assistantName: "Genie", soulFile: "", modelId: "openai:gpt-5.6-sol", currentFolder: "/repo", workspacePath: "/workspace",
    subagentDepth: 1, subagentMaxDepth: 5, securityAuditClientMeta: null, roomRoster: [], roomId: "", currentTaskId: "new-task", currentTaskRunId: "new-run", taskRun: true,
    subagentThreadId: "separate-task-thread",
  } satisfies RunScopeSubagentOpts;
  try {
    await runScopeSubagentUntilPause(opts);
    expect(inputs[0]).toMatchObject({ currentTaskId: "new-task", currentTaskRunId: "new-run", researchContextRecovery: null, researchContextPageBytes: null, researchContinuationRequired: false, toolWhitelist: ["file"] });
    await runScopeSubagentUntilPause({ ...opts, continueFromCheckpoint: true });
    expect(inputs[1]).toBeNull();
    await runScopeSubagentUntilPause({ ...opts, resume: { approved: true } });
    expect(inputs[2]).toMatchObject({ resume: { approved: true } });
    expect(inputs[2]).not.toHaveProperty("researchContextRecovery");
    expect(inputs[2]).not.toHaveProperty("messages");
  } finally { graph.mockRestore(); saver.mockRestore(); policy.mockRestore(); }
});
