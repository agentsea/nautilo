import { describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import {
  OrdinaryContentAccessRetryRequiredError, ordinaryShareApprovalContext,
  ordinaryShareExecutionIdentity, ordinaryShareOperationId,
  type OrdinaryContentAccessBinding,
} from "../../src/runtime/ordinary-content-access";
import type { OrdinaryContentAccessRecoveryDeps, OrdinaryContentAccessRecoveryScope } from "../../src/graph/resume-ordinary-content-access";

const scope: OrdinaryContentAccessRecoveryScope = {
  originalJobId: "job", graphThreadId: "thread", laneKey: "lane", roomId: "room",
  humanUserId: "human", humanActorId: "actor", agentId: "agent",
};
const call = { id: "share", name: "share_artifact", args: { artifact_id: "artifact", target_handle: "peer", sensitivity: "sensitive" } };
const config = { configurable: { thread_id: scope.graphThreadId } };
const sourceObject = { kind: "artifact" as const, id: "artifact" };
let currentGraph: ReturnType<typeof makeGraph>;
mock.module("../../src/agent/graph", () => ({ createNautiloGraph: () => currentGraph }));
const { readOrdinaryContentAccessRecovery, resumeOrdinaryContentAccessRecovery,
  OrdinaryContentAccessRecoveryUnavailableError } = await import("../../src/graph/resume-ordinary-content-access");

function makeGraph(saver: MemorySaver, run: () => void, sibling: () => void) {
  return new StateGraph(NautiloStateAnnotation)
    .addNode("earlier_sibling", () => { sibling(); return {}; })
    .addNode("prepare", (state) => {
      const execution = ordinaryShareExecutionIdentity(state, call)!;
      const approvalContext = ordinaryShareApprovalContext(state, call);
      const binding: OrdinaryContentAccessBinding = { execution, approvalContext,
        pinEnrollmentRequired: false,
        intent: { toolName: "share_artifact", objects: [sourceObject], target: { kind: "person", handle: "peer" } },
        prepared: { status: "prepared", preview: { id: call.id, name: call.name, args: {} }, operations: [{
          sourceObject, command: { operationId: ordinaryShareOperationId(execution, sourceObject, 0), object: sourceObject,
            change: { kind: "grant_people", selectedActorIds: ["peer"] } },
          admission: { principal: { kind: "agent", userId: "human", actorId: "actor", agentId: "agent", sourceRoomId: "room" },
            audienceContract: "invoking_room", approvalContext },
          previewToken: "never-public-token", expiresAt: 1,
        }] } };
      return { approvedToolCalls: [call], ordinaryContentAccessBindings: { [call.id]: binding } };
    })
    .addNode("tools", () => { run(); return { approvedToolCalls: [], ordinaryContentAccessBindings: {} }; })
    .addEdge(START, "earlier_sibling").addEdge("earlier_sibling", "prepare")
    .addEdge("prepare", "tools").addEdge("tools", END).compile({ checkpointer: saver });
}

function initial() {
  return { messages: [new AIMessage({ id: "assistant", content: "", tool_calls: [call] })],
    userId: "human", causalHumanUserId: "human", agentId: "agent", roomId: "room",
    turnId: "turn", langgraphThreadId: "thread", approvalLaneKey: "lane", actorRole: "owner",
    memoryAccessEnvelope: { ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room",
      memoryMode: "namespace", readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
  } as Partial<NautiloState>;
}

const deps: OrdinaryContentAccessRecoveryDeps = { checkpointSaver: new MemorySaver(),
  ordinaryContentAccessForState: async () => ({ mode: "plaintext_only", port: {
    prepare: async () => { throw new Error("Recovery must not prepare"); },
    commit: async () => { throw new Error("Synthetic tools node owns this test"); },
  } }),
};

async function failed(overrides: Partial<NautiloState> = {}) {
  const saver = new MemorySaver();
  let siblings = 0;
  currentGraph = makeGraph(saver, () => { throw new OrdinaryContentAccessRetryRequiredError(); }, () => { siblings++; });
  const error = await currentGraph.invoke({ ...initial(), ...overrides }, config).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(OrdinaryContentAccessRetryRequiredError);
  return { saver, siblings: () => siblings, sibling: () => { siblings++; } };
}

describe("ordinary exact checkpoint recovery", () => {
  test("durable fork owner resumes its checkpoint without replaying siblings", async () => {
    const f = await failed({ trustedExecutionEntrypoint: "foreground.fork", currentThreadId: "parent" });
    const forkScope = { ...scope, executionOwner: { kind: "fork" as const, parentThreadId: "parent", transcriptThreadId: "parent" } };
    const coordinate = await readOrdinaryContentAccessRecovery(forkScope, deps);
    expect(coordinate).not.toBeNull();
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
    expect(await readOrdinaryContentAccessRecovery({ ...forkScope, executionOwner: { ...forkScope.executionOwner, transcriptThreadId: "other" } }, deps)).toBeNull();
    let tools = 0;
    currentGraph = makeGraph(f.saver, () => { tools++; }, f.sibling);
    await resumeOrdinaryContentAccessRecovery(coordinate!, deps, { process() {}, flush() {} });
    expect(tools).toBe(1);
    expect(f.siblings()).toBe(1);
  });

  test("Task recovery uses exact original Run without fabricated foreground causal identity", async () => {
    const f = await failed({ currentTaskId: "task", currentTaskRunId: "run", turnId: "run", taskRun: true,
      subagentDepth: 1, trustedExecutionEntrypoint: "background.task", causalHumanUserId: "" });
    const taskScope = { ...scope, executionOwner: { kind: "task" as const, taskId: "task", taskRunId: "run" } };
    const coordinate = await readOrdinaryContentAccessRecovery(taskScope, deps);
    expect(coordinate?.turnId).toBe("run");
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
    expect(await readOrdinaryContentAccessRecovery({ ...taskScope, executionOwner: { ...taskScope.executionOwner, taskRunId: "new-run" } }, deps)).toBeNull();
    let tools = 0;
    currentGraph = makeGraph(f.saver, () => { tools++; }, f.sibling);
    await resumeOrdinaryContentAccessRecovery(coordinate!, deps, { process() {}, flush() {} });
    expect(tools).toBe(1);
    expect(f.siblings()).toBe(1);
  });
  test("rebuilt graph continues only failed node, without preparation/sibling replay or public content", async () => {
    const f = await failed();
    const coordinate = await readOrdinaryContentAccessRecovery(scope, deps);
    expect(coordinate?.toolCallId).toBe("share");
    expect(JSON.stringify(coordinate)).not.toContain("artifact");
    expect(JSON.stringify(coordinate)).not.toContain("never-public-token");
    let tools = 0;
    currentGraph = makeGraph(f.saver, () => { tools++; }, f.sibling);
    await resumeOrdinaryContentAccessRecovery(coordinate!, deps, { process() {}, flush() {} });
    expect(tools).toBe(1);
    expect(f.siblings()).toBe(1);
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
  });

  test("rejects cross principal, Room, Agent and unsupported Task/fork", async () => {
    await failed();
    for (const field of ["humanUserId", "humanActorId", "roomId", "agentId", "laneKey"] as const) {
      expect(await readOrdinaryContentAccessRecovery({ ...scope, [field]: "other" }, deps)).toBeNull();
    }
    await currentGraph.updateState(config, { trustedExecutionEntrypoint: "foreground.fork" });
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
  });

  test("rejects superseded checkpoint, mode drift and missing required port", async () => {
    await failed();
    const coordinate = (await readOrdinaryContentAccessRecovery(scope, deps))!;
    expect(await readOrdinaryContentAccessRecovery(scope, { ...deps, ordinaryContentAccessForState: () => ({ mode: "unchanged" }) })).toBeNull();
    expect(await readOrdinaryContentAccessRecovery(scope, { ...deps, ordinaryContentAccessForState: () => ({ mode: "plaintext_only" }) })).toBeNull();
    await currentGraph.updateState(config, { turnId: "later-turn" });
    const error = await resumeOrdinaryContentAccessRecovery(coordinate, deps, { process() {}, flush() {} }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OrdinaryContentAccessRecoveryUnavailableError);
  });

  test("AbortError/unrelated failure and missing causal identity are not recovery evidence", async () => {
    const saver = new MemorySaver();
    currentGraph = makeGraph(saver, () => { throw new Error("unrelated failure"); }, () => {});
    const error = await currentGraph.invoke(initial(), config).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
    currentGraph = makeGraph(new MemorySaver(), () => { throw new DOMException("Stopped", "AbortError"); }, () => {});
    await currentGraph.invoke(initial(), config).catch(() => undefined);
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
    await failed();
    await currentGraph.updateState(config, { causalHumanUserId: "" });
    expect(await readOrdinaryContentAccessRecovery(scope, deps)).toBeNull();
  });
});
