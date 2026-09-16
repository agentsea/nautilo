import { expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import {
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { PolicyResolver } from "@nautilo/trust";

import { NautiloStateAnnotation } from "../../src/agent/state";
import {
  createPostModelNode,
  type PostModelDeps,
} from "../../src/nodes/post-model";
import { bindProtectedProjectionReference } from
  "../../src/tools/memory/projection-sharing";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_ID = "10000000-0000-4000-8000-000000000003";
const ROOM_ID = "10000000-0000-4000-8000-000000000004";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000005";
const TOOL_CALL_ID = "projection-denial-call";

const policy = {
  checkToolAccess: async () => ({
    type: "require_approval" as const,
    route: { type: "prove_it" as const, approvers: [USER_ID] },
  }),
} as unknown as PolicyResolver;

const deps: PostModelDeps = {
  matchCommandApproval: async () => null,
  createCommandApproval: async () => ({ id: "unused", created: true }),
};

function graphFor(executions: string[]) {
  return new StateGraph(NautiloStateAnnotation)
    .addNode("post_model", createPostModelNode(policy, deps))
    .addNode("tools_like", (state) => {
      executions.push(...state.approvedToolCalls.map((call) => call.id ?? ""));
      return {};
    })
    .addEdge(START, "post_model")
    .addEdge("post_model", "tools_like")
    .addEdge("tools_like", END)
    .compile({ checkpointer: new MemorySaver() });
}

function inputFor(roomKind: "open" | "group") {
  const now = Date.now();
  return {
    messages: [new AIMessage({
      content: "",
      tool_calls: [{
        id: TOOL_CALL_ID,
        name: "share_memory",
        args: { mode: "project" },
      }],
    })],
    threadId: 51,
    langgraphThreadId: "projection-denial-status",
    userId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    actorRole: "owner",
    memoryAccessEnvelope: {
      memoryMode: "namespace" as const,
      ownerId: USER_ID,
      actorId: ACTOR_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      readableNamespaces: [NAMESPACE_ID],
      mutableNamespaces: [NAMESPACE_ID],
      writableNamespaces: [NAMESPACE_ID],
      toolPolicy: { share_memory: "require_prove_it" as const },
    },
    projectionSnapshots: [{
      toolCallId: TOOL_CALL_ID,
      requesterUserId: USER_ID,
      requesterActorId: ACTOR_ID,
      agentId: AGENT_ID,
      sourceFingerprints: [{ id: "memory-1", contentHash: "source-hash" }],
      content: "Synthetic projected content.",
      contentHash: "content-hash",
      destination: {
        roomId: "10000000-0000-4000-8000-000000000006",
        namespaceId: "10000000-0000-4000-8000-000000000007",
        label: "Synthetic destination",
        kind: roomKind,
        memberCount: 2,
        audienceFingerprint: "audience-hash",
      },
      audienceFingerprint: "audience-hash",
      createdAt: now,
      expiresAt: now + 60_000,
      creationKey: "projection:10000000-0000-4000-8000-000000000008",
    }],
  };
}

for (const scenario of [
  {
    name: "prove_it",
    roomKind: "open" as const,
    interruptType: "prove_it_challenge",
    resume: { approved: false },
  },
  {
    name: "approval.ask",
    roomKind: "group" as const,
    interruptType: "approval_ask",
    resume: { approved: false, verb: "deny" },
  },
]) {
  test(`${scenario.name} projection denial is an error result and never executes`, async () => {
    const executions: string[] = [];
    const graph = graphFor(executions);
    const config = {
      configurable: { thread_id: `projection-denial-${scenario.name}` },
    };

    const parked = await graph.invoke(inputFor(scenario.roomKind), config);
    expect(parked).toMatchObject({
      __interrupt__: [{ value: {
        type: scenario.interruptType,
        tools: [{ id: TOOL_CALL_ID, name: "share_memory" }],
      } }],
    });
    expect(executions).toEqual([]);

    const resumed = await graph.invoke(
      new Command({ resume: scenario.resume }),
      config,
    );
    const denial = resumed.messages.at(-1);
    expect(ToolMessage.isInstance(denial)).toBeTrue();
    expect(denial).toMatchObject({
      name: "share_memory",
      tool_call_id: TOOL_CALL_ID,
      status: "error",
      additional_kwargs: { nautilo_tool_status: "error" },
    });
    expect(resumed.approvedToolCalls).toEqual([]);
    expect(resumed.approvalDenied).toBeTrue();
    expect(executions).toEqual([]);
  });
}

test("PIN enrollment requires a distinct protected projection prove-it decision", async () => {
  for (const approved of [true, false]) {
  let enrolled = false;
  const executions: string[] = [];
  const protectedDeps: PostModelDeps = {
    ...deps,
    isPinEnrolled: async () => enrolled,
  };
  const graph = new StateGraph(NautiloStateAnnotation)
    .addNode("post_model", createPostModelNode(policy, protectedDeps))
    .addNode("tools_like", (state) => {
      executions.push(...state.approvedToolCalls.map((call) => call.id ?? ""));
      return {};
    })
    .addEdge(START, "post_model")
    .addEdge("post_model", "tools_like")
    .addEdge("tools_like", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = {
    configurable: { thread_id: `protected-projection-pin-enrollment-${approved}` },
  };
  const now = Date.now();
  const snapshot = bindProtectedProjectionReference({
    referenceVersion: 1,
    referenceId: `protected-projection-pin-reference-${approved}`,
    toolCallId: TOOL_CALL_ID,
    requesterUserId: USER_ID,
    requesterActorId: ACTOR_ID,
    agentId: AGENT_ID,
    createdAt: now,
    expiresAt: now + 60_000,
    sealedPreparation: `authenticated-projection-capsule-${approved}`,
  }, {
    proposedContent: "Exact public-safe projection.",
    roomLabel: "Destination",
    roomKind: "open",
    memberCount: 2,
  });
  const input = {
    ...inputFor("open"),
    messages: [new AIMessage({
      content: "",
      tool_calls: [{
        id: TOOL_CALL_ID,
        name: "share_memory",
        args: { mode: "project" },
      }],
    })],
    projectionSnapshots: [snapshot],
  };

  const enrollment = await graph.invoke(input, config) as Awaited<
    ReturnType<typeof graph.invoke>
  > & { __interrupt__?: Array<{ id?: string; value?: unknown }> };
  expect(enrollment).toMatchObject({
    __interrupt__: [{ value: {
      type: "identity_challenge",
      mode: "enrollPin",
      enrollmentToolCallIds: [TOOL_CALL_ID],
      protectedMemoryTools: [{
        toolCallId: TOOL_CALL_ID,
        mode: "project",
      }],
    } }],
  });
  expect(executions).toEqual([]);

  enrolled = true;
  const identityInterruptId = enrollment.__interrupt__?.[0]?.id;
  if (typeof identityInterruptId !== "string") {
    throw new Error("identity interrupt id unavailable");
  }
  const proveIt = await graph.invoke(
    new Command({ resume: {
      [identityInterruptId]: { verified: true },
    }, update: { identityEnrollmentToolCallIds: [TOOL_CALL_ID] } }),
    config,
  ) as Awaited<ReturnType<typeof graph.invoke>> & {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  expect(proveIt).toMatchObject({
    __interrupt__: [{ value: {
      type: "prove_it_challenge",
      tools: [{
        id: TOOL_CALL_ID,
        name: "share_memory",
        args: {
          mode: "project",
          proposed_content: "Exact public-safe projection.",
          target_room_name: "Destination",
        },
      }],
    } }],
  });
  expect(JSON.stringify(proveIt.__interrupt__)).not.toContain(
    `authenticated-projection-capsule-${approved}`,
  );
  expect(executions).toEqual([]);

  const proveItInterruptId = proveIt.__interrupt__?.[0]?.id;
  if (typeof proveItInterruptId !== "string") {
    throw new Error("prove-it interrupt id unavailable");
  }
  const completed = await graph.invoke(new Command({ resume: {
    [proveItInterruptId]: { approved },
  } }), config);
  expect(completed.identityEnrollmentToolCallIds).toEqual([]);
  expect(executions).toEqual(approved ? [TOOL_CALL_ID] : []);
  }
});

for (const scenario of [
  { name: "prove-it disappears", markerIds: ["changed-after-enroll"], allowAfterEnrollment: true },
  { name: "enrollment marker changes", markerIds: ["stale-tool-call"], allowAfterEnrollment: false },
]) {
  test(`PIN enrollment fails closed when ${scenario.name}`, async () => {
    let enrolled = false;
    let allow = false;
    const executions: string[] = [];
    const changingPolicy = {
      checkToolAccess: async () => allow
        ? { type: "allow" as const }
        : {
            type: "require_approval" as const,
            route: { type: "prove_it" as const, approvers: [USER_ID] },
          },
    } as unknown as PolicyResolver;
    const graph = new StateGraph(NautiloStateAnnotation)
      .addNode("post_model", createPostModelNode(changingPolicy, {
        ...deps,
        isPinEnrolled: async () => enrolled,
      }))
      .addNode("tools_like", (state) => {
        executions.push(...state.approvedToolCalls.map((call) => call.id ?? ""));
        return {};
      })
      .addEdge(START, "post_model")
      .addEdge("post_model", "tools_like")
      .addEdge("tools_like", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: `stale-enrollment-${scenario.allowAfterEnrollment}` },
    };
    const toolCallId = "changed-after-enroll";
    const enrollment = await graph.invoke({
      ...inputFor("group"),
      messages: [new AIMessage({
        content: "",
        tool_calls: [{
          id: toolCallId,
          name: "run_shell",
          args: { command: "sudo apt update" },
        }],
      })],
      projectionSnapshots: [],
    }, config) as Awaited<ReturnType<typeof graph.invoke>> & {
      __interrupt__?: Array<{ id?: string; value?: unknown }>;
    };
    expect(enrollment).toMatchObject({
      __interrupt__: [{ value: {
        type: "identity_challenge",
        mode: "enrollPin",
        enrollmentToolCallIds: [toolCallId],
      } }],
    });

    const identityInterruptId = enrollment.__interrupt__?.[0]?.id;
    if (typeof identityInterruptId !== "string") {
      throw new Error("identity interrupt id unavailable");
    }
    enrolled = true;
    allow = scenario.allowAfterEnrollment;
    let rejected: unknown;
    try {
      await graph.invoke(new Command({
        resume: { [identityInterruptId]: { verified: true } },
        update: { identityEnrollmentToolCallIds: scenario.markerIds },
      }), config);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain(
      "Identity enrollment tool batch changed before prove-it",
    );
    expect(executions).toEqual([]);
  });
}
