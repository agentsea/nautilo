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
import type {
  ProtectedAgentMemoryProjectionPort,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";

import {
  createProtectedTaskAdditionalAuthorityResumeMapV1,
  type ProtectedTaskAdditionalAuthorityResumeBindingV1,
} from "../../src/graph/protected-task-additional-authority-resume";
import {
  createProtectedTaskMemoryProjectionPort,
  type ProtectedTaskMemoryProjectionHandoff,
  type ProtectedTaskProjectionAuthorityPlan,
  type ProtectedTaskProjectionPublicationAuthorization,
} from "../../src/tools/memory/protected-task-projection-authority";

const REQUIREMENTS = Object.freeze([Object.freeze({
  namespaceId: "550e8400-e29b-41d4-a716-446655440001",
  operations: Object.freeze(["encrypt" as const]),
})]);
const REQUEST_DIGEST = new Uint8Array(32).fill(17);
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
  referenceId: "projection-reference",
  toolCallId: "projection-tool-call",
  requesterUserId: "requester-user",
  requesterActorId: "requester-actor",
  agentId: "agent-1",
  createdAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  sealedPreparation: "sealed-preparation",
});
const PUBLISH_INPUT = Object.freeze({ authority: AUTHORITY, reference: REFERENCE });

function plan(
  kind: "current_v1" | "additional_authority_v1",
): ProtectedTaskProjectionAuthorityPlan {
  const common = {
    planVersion: 1 as const,
    operationId: "projection-operation",
    requestDigest: REQUEST_DIGEST.slice(),
    semanticAuthorityRequirements: REQUIREMENTS,
  };
  return kind === "current_v1"
    ? Object.freeze({ ...common, kind })
    : Object.freeze({
        ...common,
        kind,
        authorizationRequestId: "projection-authority-request",
        effectDisposition: "not_started_v1" as const,
      });
}

function additionalScenario(threadId: string) {
  const State = Annotation.Root({
    published: Annotation<boolean>({
      reducer: (_, next) => next,
      default: () => false,
    }),
  });
  const saver = new MemorySaver();
  const sealedPlan = plan("additional_authority_v1");
  let freshGrantNowHasAuthority = false;
  let publishEffects = 0;
  const authorizations: ProtectedTaskProjectionPublicationAuthorization[] = [];
  const handoff: ProtectedTaskMemoryProjectionHandoff = Object.freeze({
    prepare: async () => ({
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    }),
    restore: async () => ({
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    }),
    planPublication: async () => ({
      status: "success" as const,
      // The server-owned sealed preparation controls this result. A fresh
      // resumed grant must not silently turn it into a current-authority plan.
      value: sealedPlan,
    }),
    publishAuthorized: async ({ authorization }) => {
      authorizations.push(authorization);
      publishEffects += 1;
      return {
        status: "success" as const,
        value: {
          status: "created" as const,
          memoryId: "projected-memory",
          roomLabel: "Destination",
        },
      };
    },
  });
  const makeGraph = () => {
    const port = createProtectedTaskMemoryProjectionPort(handoff);
    return new StateGraph(State)
      .addNode("publish", async () => {
        const result = await port.publish(PUBLISH_INPUT);
        return { published: result.status === "success" };
      })
      .addEdge(START, "publish")
      .addEdge("publish", END)
      .compile({ checkpointer: saver });
  };
  return {
    authorizations,
    config: { configurable: { thread_id: threadId } },
    freshGrantNowHasAuthority: () => freshGrantNowHasAuthority,
    makeGraph,
    publishEffects: () => publishEffects,
    setFreshGrantNowHasAuthority: () => { freshGrantNowHasAuthority = true; },
    sealedPlan,
  };
}

function binding(
  interruptId: string,
  sealedPlan: Extract<ProtectedTaskProjectionAuthorityPlan, {
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

describe("protected Task projection authority", () => {
  test("consumes the exact acknowledgement before one publication effect after restart", async () => {
    const run = additionalScenario("protected-projection-resume");
    const initial = run.makeGraph();
    await initial.invoke({ published: false }, run.config);
    const parked = await initial.getState(run.config);
    const interruptId = parked.tasks[0]?.interrupts[0]?.id;
    if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
    expect(run.publishEffects()).toBe(0);

    run.setFreshGrantNowHasAuthority();
    expect(run.freshGrantNowHasAuthority()).toBe(true);
    const exactBinding = binding(interruptId, run.sealedPlan as Extract<
      ProtectedTaskProjectionAuthorityPlan,
      { kind: "additional_authority_v1" }
    >);
    const completed = await run.makeGraph().invoke(new Command({
      resume: createProtectedTaskAdditionalAuthorityResumeMapV1(exactBinding),
    }), run.config);
    expect(completed.published).toBe(true);
    expect(run.publishEffects()).toBe(1);
    expect(run.authorizations).toHaveLength(1);
    expect(run.authorizations[0]).toMatchObject({
      kind: "additional_authority_v1",
      plan: { kind: "additional_authority_v1" },
      acknowledgement: {
        authorizationRequestId: "projection-authority-request",
        operationId: "projection-operation",
      },
    });
  });

  test("rejects a substituted acknowledgement before publication", async () => {
    const run = additionalScenario("protected-projection-wrong-ack");
    const initial = run.makeGraph();
    await initial.invoke({ published: false }, run.config);
    const parked = await initial.getState(run.config);
    const interruptId = parked.tasks[0]?.interrupts[0]?.id;
    if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
    const exactBinding = binding(interruptId, run.sealedPlan as Extract<
      ProtectedTaskProjectionAuthorityPlan,
      { kind: "additional_authority_v1" }
    >);
    const acknowledgement = createProtectedTaskAdditionalAuthorityResumeMapV1(
      exactBinding,
    )[interruptId]!;
    const failure = await run.makeGraph().invoke(new Command({ resume: {
      [interruptId]: {
        ...acknowledgement,
        requestDigest: new Uint8Array(32).fill(99),
      },
    } }), run.config).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "additional-authority acknowledgement is invalid",
    );
    expect(run.publishEffects()).toBe(0);
  });

  test("publishes immediately only for an exact current-authority plan", async () => {
    let effects = 0;
    let forwarded: ProtectedTaskProjectionPublicationAuthorization | null = null;
    const currentPlan = plan("current_v1");
    const port: ProtectedAgentMemoryProjectionPort =
      createProtectedTaskMemoryProjectionPort({
        prepare: async () => ({
          status: "unavailable",
          reason: "authorization_required",
        }),
        restore: async () => ({
          status: "unavailable",
          reason: "authorization_required",
        }),
        planPublication: async () => ({ status: "success", value: currentPlan }),
        publishAuthorized: async ({ authorization }) => {
          effects += 1;
          forwarded = authorization;
          return { status: "success", value: {
            status: "created",
            memoryId: "projected-memory",
            roomLabel: "Destination",
          } };
        },
      });
    expect(await port.publish(PUBLISH_INPUT)).toMatchObject({ status: "success" });
    expect(effects).toBe(1);
    expect(forwarded).toMatchObject({ kind: "current_v1" });
  });

  test("rejects a malformed sealed plan before publication", async () => {
    let effects = 0;
    const port = createProtectedTaskMemoryProjectionPort({
      prepare: async () => ({
        status: "unavailable",
        reason: "authorization_required",
      }),
      restore: async () => ({
        status: "unavailable",
        reason: "authorization_required",
      }),
      planPublication: async () => ({
        status: "success",
        value: { ...plan("current_v1"), extra: "substitution" } as never,
      }),
      publishAuthorized: async () => {
        effects += 1;
        return { status: "unavailable", reason: "authorization_required" };
      },
    });
    const failure = await port.publish(PUBLISH_INPUT).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "projection authority plan is invalid",
    );
    expect(effects).toBe(0);
  });
});
