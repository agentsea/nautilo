import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import {
  createProtectedTaskHumanResumeCommandV1,
  type ProtectedTaskHumanResumeBindingV1,
  type ProtectedTaskHumanResumeContextV1,
} from "../../src/graph/protected-task-human-resume";
import { awaitReplyNode } from "../../src/nodes/await-reply";

const TASK_ID = "task-exact";
const TASK_RUN_ID = "run-exact";
const GRAPH_THREAD_ID = "subagent:task:task-exact:protected";
const OWNER_ID = "owner-exact";
const HUMAN_ID = "human-exact";
const AGENT_ID = "agent-exact";
const ROOM_ID = "room-exact";
const LANE_KEY = `task:${TASK_ID}`;

function envelope(policy: string): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: HUMAN_ID,
    actorId: `actor-${policy}`,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    readableNamespaces: [`read-${policy}`],
    mutableNamespaces: [`write-${policy}`],
    writableNamespaces: [`write-${policy}`],
    toolPolicy: { search_memory: policy === "fresh" ? "allow" : "forbidden" },
  };
}

function initialState(): Partial<NautiloState> {
  return {
    messages: [new AIMessage("park")],
    taskRun: true,
    subagentRun: true,
    trustedExecutionEntrypoint: "background.task",
    currentTaskId: TASK_ID,
    currentTaskRunId: TASK_RUN_ID,
    currentThreadId: GRAPH_THREAD_ID,
    langgraphThreadId: GRAPH_THREAD_ID,
    turnId: TASK_RUN_ID,
    userId: OWNER_ID,
    causalHumanUserId: HUMAN_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    callingRoomId: ROOM_ID,
    actorRole: "owner",
    approvalLaneKey: LANE_KEY,
    memoryAccessEnvelope: envelope("stale"),
    relayCapabilities: { staleRelay: true },
  };
}

function context(): ProtectedTaskHumanResumeContextV1 {
  return {
    taskId: TASK_ID,
    taskRunId: TASK_RUN_ID,
    graphThreadId: GRAPH_THREAD_ID,
    ownerId: OWNER_ID,
    causalHumanUserId: HUMAN_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    callingRoomId: ROOM_ID,
    actorRole: "owner",
    approvalLaneKey: LANE_KEY,
    memoryAccessEnvelope: envelope("fresh"),
    relayCapabilities: { freshRelay: true },
  };
}

function makeGraph(
  saver: MemorySaver,
  interruptNode: (state: NautiloState) => Partial<NautiloState>,
  onContinued: (state: NautiloState) => void,
  effects: { predecessors: number },
) {
  return new StateGraph(NautiloStateAnnotation)
    .addNode("predecessor", () => {
      effects.predecessors += 1;
      return {};
    })
    .addNode("interrupt", interruptNode)
    .addNode("continued", (state) => {
      onContinued(state);
      return {};
    })
    .addEdge(START, "predecessor")
    .addEdge("predecessor", "interrupt")
    .addEdge("interrupt", "continued")
    .addEdge("continued", END)
    .compile({ checkpointer: saver });
}

async function parked(
  graph: ReturnType<typeof makeGraph>,
  state: Partial<NautiloState> = initialState(),
) {
  const config = { configurable: { thread_id: GRAPH_THREAD_ID } };
  await graph.invoke(state, config);
  const snapshot = await graph.getState(config);
  const interruptId = snapshot.tasks[0]?.interrupts[0]?.id;
  if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
  return { config, snapshot, interruptId };
}

describe("protected Task Human graph continuation", () => {
  test("approval resumes the exact interrupt, reconstructs its receipt echoes, and refreshes transient authority", async () => {
    const saver = new MemorySaver();
    const effects = { predecessors: 0 };
    let decision: unknown;
    let continuedState: NautiloState | undefined;
    const nodeEnvelopes: Array<MemoryAccessEnvelope | null> = [];
    const approvalId = "local-mcp-install:exact";
    const graph = makeGraph(
      saver,
      state => {
        nodeEnvelopes.push(state.memoryAccessEnvelope);
        decision = interrupt({
          type: "approval_ask",
          approvalId,
          tools: [{ name: "manage_local_mcp", id: "tool-1", args: { action: "install" } }],
          reason: "Install this exact local MCP?",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "deny"],
          localMcpInstall: {
            version: "local-mcp-install-v1",
            digest: "digest-exact",
            preview: {},
          },
        });
        return {};
      },
      state => { continuedState = state; },
      effects,
    );
    const pending = await parked(graph);

    const command = createProtectedTaskHumanResumeCommandV1(
      pending.snapshot,
      { kind: "approval", interruptId: pending.interruptId, requestId: approvalId, verb: "once" },
      context(),
    );
    await graph.invoke(command, pending.config);

    expect(decision).toEqual({
      approved: true,
      verb: "once",
      localMcpInstallApprovalId: approvalId,
      localMcpInstallDigest: "digest-exact",
      localMcpInstallLaneKey: LANE_KEY,
    });
    expect(effects.predecessors).toBe(1);
    expect(nodeEnvelopes).toEqual([envelope("stale"), envelope("fresh")]);
    expect(continuedState?.memoryAccessEnvelope).toEqual(envelope("fresh"));
    expect(continuedState?.relayCapabilities).toEqual({ freshRelay: true });
    const refreshedEnvelope = continuedState?.memoryAccessEnvelope;
    expect(refreshedEnvelope && "writableNamespaces" in refreshedEnvelope
      ? refreshedEnvelope.writableNamespaces
      : []).not.toContain("write-stale");
    expect(continuedState?.relayCapabilities?.["staleRelay"]).toBeUndefined();
  });

  test("prove-it and identity use their exact interrupt and preserve enrollment replay identity", async () => {
    for (const kind of ["prove_it", "identity"] as const) {
      const saver = new MemorySaver();
      const effects = { predecessors: 0 };
      let decision: unknown;
      let continuedState: NautiloState | undefined;
      const graph = makeGraph(
        saver,
        () => {
          decision = kind === "prove_it"
            ? interrupt({ type: "prove_it_challenge", tools: [] })
            : interrupt({
                type: "identity_challenge",
                mode: "enrollPin",
                enrollmentToolCallIds: ["tool-enroll"],
              });
          return {};
        },
        state => { continuedState = state; },
        effects,
      );
      const state = kind === "identity"
        ? {
            ...initialState(),
            messages: [new AIMessage({
              content: "",
              tool_calls: [{ id: "tool-enroll", name: "run_shell", args: { command: "true" } }],
            })],
          }
        : initialState();
      const pending = await parked(graph, state);
      const binding: ProtectedTaskHumanResumeBindingV1 = kind === "prove_it"
        ? { kind, interruptId: pending.interruptId, approved: true }
        : { kind, interruptId: pending.interruptId, verified: true };
      await graph.invoke(
        createProtectedTaskHumanResumeCommandV1(pending.snapshot, binding, context()),
        pending.config,
      );

      expect(decision).toEqual(kind === "prove_it"
        ? { approved: true }
        : { verified: true });
      expect(effects.predecessors).toBe(1);
      if (kind === "identity") {
        expect(continuedState?.identityEnrollmentToolCallIds).toEqual(["tool-enroll"]);
      }
    }
  });

  test("await-reply uses the graph node to append one reply without replaying its predecessor", async () => {
    const saver = new MemorySaver();
    const effects = { predecessors: 0 };
    let continuedState: NautiloState | undefined;
    const graph = makeGraph(
      saver,
      state => awaitReplyNode(state),
      state => { continuedState = state; },
      effects,
    );
    const pending = await parked(graph, {
      ...initialState(),
      awaitResponse: true,
      awaitRoomId: ROOM_ID,
      awaitFromUserIds: [HUMAN_ID],
      awaitTaskId: TASK_ID,
      awaitTaskRunId: TASK_RUN_ID,
      awaitOwnerId: OWNER_ID,
    });
    await graph.invoke(createProtectedTaskHumanResumeCommandV1(
      pending.snapshot,
      {
        kind: "await_reply",
        interruptId: pending.interruptId,
        reply: "Continue with the reviewed option.",
        fromUserId: HUMAN_ID,
      },
      context(),
    ), pending.config);

    expect(effects.predecessors).toBe(1);
    expect(continuedState?.awaitResponse).toBe(false);
    const replies = continuedState?.messages.filter(message =>
      HumanMessage.isInstance(message)
      && message.content === "Continue with the reviewed option."
    );
    expect(replies).toHaveLength(1);
  });

  test("denial refreshes revoked authority without executing the guarded effect", async () => {
    const saver = new MemorySaver();
    const effects = { predecessors: 0 };
    let protectedEffects = 0;
    let continuedState: NautiloState | undefined;
    const approvalId = "approval-denied";
    const graph = makeGraph(
      saver,
      () => {
        const decision: unknown = interrupt({
          type: "approval_ask",
          approvalId,
          tools: [{ name: "run_shell", id: "tool-denied", args: {} }],
          reason: "Run the reviewed command?",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "deny"],
        });
        if (decision !== null && typeof decision === "object"
          && (decision as Record<string, unknown>)["approved"] === true) {
          protectedEffects += 1;
        }
        return {};
      },
      state => { continuedState = state; },
      effects,
    );
    const pending = await parked(graph);
    await graph.invoke(createProtectedTaskHumanResumeCommandV1(
      pending.snapshot,
      {
        kind: "approval",
        interruptId: pending.interruptId,
        requestId: approvalId,
        verb: "deny",
      },
      { ...context(), relayCapabilities: undefined },
    ), pending.config);

    expect(effects.predecessors).toBe(1);
    expect(protectedEffects).toBe(0);
    expect(continuedState?.memoryAccessEnvelope).toEqual(envelope("fresh"));
    expect(continuedState?.relayCapabilities).toEqual({});
    expect(continuedState?.relayCapabilities?.["staleRelay"]).toBeUndefined();
  });

  test("retired broker approvals reject allow but accept atomic denial", async () => {
    for (const scenario of [
      {
        approvalId: "legacy-local-git-batch",
        tools: [
          { name: "local_git", id: "tool-git", args: { operation: "status" } },
          { name: "apply_patch", id: "tool-patch", args: { patch: "fixture" } },
        ],
      },
      {
        approvalId: "github-publish:legacy-publication",
        tools: [{ name: "apply_patch", id: "tool-patch", args: { patch: "fixture" } }],
      },
    ]) {
      const saver = new MemorySaver();
      const effects = { predecessors: 0 };
      let decision: unknown;
      const graph = makeGraph(
        saver,
        () => {
          decision = interrupt({
            type: "approval_ask",
            approvalId: scenario.approvalId,
            tools: scenario.tools,
            reason: "Resume the historical local operation?",
            reasonCode: "destructive-tool",
            allowedVerbs: ["once", "deny"],
          });
          return {};
        },
        () => undefined,
        effects,
      );
      const pending = await parked(graph);

      expect(() => createProtectedTaskHumanResumeCommandV1(
        pending.snapshot,
        {
          kind: "approval",
          interruptId: pending.interruptId,
          requestId: scenario.approvalId,
          verb: "once",
        },
        context(),
      )).toThrow("retired broker approval");

      await graph.invoke(createProtectedTaskHumanResumeCommandV1(
        pending.snapshot,
        {
          kind: "approval",
          interruptId: pending.interruptId,
          requestId: scenario.approvalId,
          verb: "deny",
        },
        context(),
      ), pending.config);

      expect(decision).toEqual({ approved: false, verb: "deny" });
      expect(effects.predecessors).toBe(1);
    }
  });

  test("wrong request, kind, sender, or widened binding fails before the resumed node", async () => {
    const saver = new MemorySaver();
    const effects = { predecessors: 0 };
    let resumedEffects = 0;
    const graph = makeGraph(
      saver,
      () => {
        interrupt({
          type: "await_human_reply",
          targetRoomId: ROOM_ID,
          awaitingFromUserIds: [HUMAN_ID],
          taskId: TASK_ID,
          taskRunId: TASK_RUN_ID,
          ownerId: OWNER_ID,
        });
        resumedEffects += 1;
        return {};
      },
      () => undefined,
      effects,
    );
    const pending = await parked(graph);

    const invalid = [
      { kind: "prove_it", interruptId: pending.interruptId, approved: true },
      { kind: "await_reply", interruptId: pending.interruptId, reply: "go", fromUserId: "wrong" },
      { kind: "await_reply", interruptId: pending.interruptId, reply: "go", fromUserId: HUMAN_ID, extra: true },
    ];
    for (const binding of invalid) {
      expect(() => createProtectedTaskHumanResumeCommandV1(
        pending.snapshot,
        binding as never,
        context(),
      )).toThrow("Protected Task Human");
    }
    expect(effects.predecessors).toBe(1);
    expect(resumedEffects).toBe(0);
  });
});
