import { describe, expect, test } from "bun:test";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { protectedTaskSemanticAuthorityRequirementsDigest } from "@nautilo/db";
import type { ProtectedMemoryAuthority } from "@nautilo/lattice-bridge";

import {
  createProtectedTaskAdditionalAuthorityResumeMapV1,
  type ProtectedTaskAdditionalAuthorityResumeBindingV1,
} from "../../src/graph/protected-task-additional-authority-resume";
import {
  createProtectedTaskMemoryAccessPort,
  type ProtectedTaskMemoryAccessAuthorityPlan,
  type ProtectedTaskMemoryAccessAuthorization,
  type ProtectedTaskMemoryAccessHandoff,
} from "../../src/tools/memory/protected-task-access-authority";

const REQUIREMENTS = Object.freeze([Object.freeze({
  namespaceId: "550e8400-e29b-41d4-a716-446655440001",
  operations: Object.freeze(["encrypt" as const]),
})]);
const AUTHORITY: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace",
  subjectUserId: "requester-user",
  agentId: "agent-1",
  readableNamespaceIds: Object.freeze([
    "550e8400-e29b-41d4-a716-446655440000",
  ]),
  mutableNamespaceIds: Object.freeze([
    "550e8400-e29b-41d4-a716-446655440000",
  ]),
  writableNamespaceId: "550e8400-e29b-41d4-a716-446655440000",
});
const REFERENCE = Object.freeze({
  referenceVersion: 1 as const,
  referenceId: "access-reference",
  toolCallId: "access-tool-call",
  requesterUserId: "requester-user",
  agentId: "agent-1",
  taskContinuation: Object.freeze({
    kind: "protected_task_v1" as const,
    requesterActorId: "requester-actor",
    createdAt: 1,
    sealedPreparation: "sealed-access-preparation",
  }),
});
const CHANGE_INPUT = Object.freeze({
  operationId: "access-operation",
  authority: AUTHORITY,
  memoryId: "memory-1",
  action: Object.freeze({ kind: "grant_user" as const, userHandle: "recipient" }),
  approvalReference: REFERENCE,
});

function plan(
  kind: "current_v1" | "additional_authority_v1",
): ProtectedTaskMemoryAccessAuthorityPlan {
  const common = {
    planVersion: 1 as const,
    operationId: CHANGE_INPUT.operationId,
    requestDigest: new Uint8Array(32).fill(17),
    semanticAuthorityRequirements: REQUIREMENTS,
  };
  return kind === "current_v1"
    ? Object.freeze({ ...common, kind })
    : Object.freeze({
        ...common,
        kind,
        authorizationRequestId: "access-authority-request",
        effectDisposition: "not_started_v1" as const,
      });
}

function additionalScenario(threadId: string) {
  const State = Annotation.Root({
    changed: Annotation<boolean>({
      reducer: (_, next) => next,
      default: () => false,
    }),
  });
  const saver = new MemorySaver();
  const sealedPlan = plan("additional_authority_v1");
  const authorizations: ProtectedTaskMemoryAccessAuthorization[] = [];
  let effects = 0;
  const handoff: ProtectedTaskMemoryAccessHandoff = Object.freeze({
    prepareApproval: async () => ({
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    }),
    restoreApproval: async () => ({
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    }),
    planChange: async () => ({
      status: "success" as const,
      value: sealedPlan,
    }),
    changeAuthorized: async ({ authorization }: Parameters<
      ProtectedTaskMemoryAccessHandoff["changeAuthorized"]
    >[0]) => {
      authorizations.push(authorization);
      effects += 1;
      return {
        status: "success" as const,
        value: {
          status: "updated" as const,
          memoryId: CHANGE_INPUT.memoryId,
        },
      };
    },
  });
  const makeGraph = () => {
    const port = createProtectedTaskMemoryAccessPort(handoff);
    return new StateGraph(State)
      .addNode("change", async () => {
        const result = await port.change(CHANGE_INPUT);
        return { changed: result.status === "success" };
      })
      .addEdge(START, "change")
      .addEdge("change", END)
      .compile({ checkpointer: saver });
  };
  return {
    authorizations,
    config: { configurable: { thread_id: threadId } },
    effects: () => effects,
    makeGraph,
    sealedPlan,
  };
}

function binding(
  interruptId: string,
  sealedPlan: Extract<ProtectedTaskMemoryAccessAuthorityPlan, {
    kind: "additional_authority_v1";
  }>,
): ProtectedTaskAdditionalAuthorityResumeBindingV1 {
  return {
    interruptId,
    authorizationRequestId: sealedPlan.authorizationRequestId,
    effectDisposition: sealedPlan.effectDisposition,
    operationId: sealedPlan.operationId,
    requestDigest: sealedPlan.requestDigest.slice(),
    requiredAuthorityDigest:
      protectedTaskSemanticAuthorityRequirementsDigest(
        sealedPlan.semanticAuthorityRequirements,
      ),
  };
}

describe("protected Task Memory access authority", () => {
  test("consumes the exact additional-authority acknowledgement before one effect after restart", async () => {
    const run = additionalScenario("protected-access-resume");
    const initial = run.makeGraph();
    await initial.invoke({ changed: false }, run.config);
    const parked = await initial.getState(run.config);
    const interruptId = parked.tasks[0]?.interrupts[0]?.id;
    if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
    expect(run.effects()).toBe(0);

    const exactBinding = binding(interruptId, run.sealedPlan as Extract<
      ProtectedTaskMemoryAccessAuthorityPlan,
      { kind: "additional_authority_v1" }
    >);
    const completed = await run.makeGraph().invoke(new Command({
      resume: createProtectedTaskAdditionalAuthorityResumeMapV1(exactBinding),
    }), run.config);

    expect(completed.changed).toBe(true);
    expect(run.effects()).toBe(1);
    expect(run.authorizations).toHaveLength(1);
    expect(run.authorizations[0]).toMatchObject({
      kind: "additional_authority_v1",
      plan: { operationId: CHANGE_INPUT.operationId },
      acknowledgement: {
        authorizationRequestId: "access-authority-request",
        operationId: CHANGE_INPUT.operationId,
      },
    });
  });

  test("rejects a substituted acknowledgement before the effect", async () => {
    const run = additionalScenario("protected-access-wrong-ack");
    const initial = run.makeGraph();
    await initial.invoke({ changed: false }, run.config);
    const parked = await initial.getState(run.config);
    const interruptId = parked.tasks[0]?.interrupts[0]?.id;
    if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
    const exact = createProtectedTaskAdditionalAuthorityResumeMapV1(binding(
      interruptId,
      run.sealedPlan as Extract<ProtectedTaskMemoryAccessAuthorityPlan, {
        kind: "additional_authority_v1";
      }>,
    ))[interruptId]!;
    const error = await run.makeGraph().invoke(new Command({ resume: {
      [interruptId]: { ...exact, operationId: "substituted-operation" },
    } }), run.config).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "additional-authority acknowledgement is invalid",
    );
    expect(run.effects()).toBe(0);
  });

  test("forwards an exact current plan without interruption", async () => {
    let forwarded: ProtectedTaskMemoryAccessAuthorization | null = null;
    const port = createProtectedTaskMemoryAccessPort({
      prepareApproval: async () => ({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      }),
      restoreApproval: async () => ({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      }),
      planChange: async () => ({
        status: "success" as const,
        value: plan("current_v1"),
      }),
      changeAuthorized: async ({ authorization }: Parameters<
        ProtectedTaskMemoryAccessHandoff["changeAuthorized"]
      >[0]) => {
        forwarded = authorization;
        return {
          status: "success" as const,
          value: {
            status: "unchanged" as const,
            memoryId: CHANGE_INPUT.memoryId,
          },
        };
      },
    });
    expect(await port.change(CHANGE_INPUT)).toEqual({
      status: "success",
      value: { status: "unchanged", memoryId: CHANGE_INPUT.memoryId },
    });
    expect(forwarded).toMatchObject({
      kind: "current_v1",
      plan: { operationId: CHANGE_INPUT.operationId },
    });
  });
});
