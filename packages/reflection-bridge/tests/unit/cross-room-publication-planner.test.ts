import { describe, expect, test } from "bun:test";

import {
  crossRoomApplicationPlanToken,
  ExactCrossRoomPublicationPlanner,
  type CrossRoomCandidatePlan,
} from "../../src/server";

const token = crossRoomApplicationPlanToken("plan:one");
const first = {
  kind: "record" as const,
  role: "changed" as const,
  recordRef: "record:a",
  processingGeneration: 1,
  representationGeneration: 1,
  authorityGeneration: 3,
  read: { namespaceRef: "namespace:a", bindingRef: "binding:a" },
};
const second = {
  ...first,
  role: "candidate" as const,
  recordRef: "record:b",
  authorityGeneration: 4,
  read: { namespaceRef: "namespace:b", bindingRef: "binding:b" },
};
const candidatePlan: CrossRoomCandidatePlan = {
  workRef: "record:a",
  workGeneration: 1,
  policyVersion: "candidate-policy-v1",
  inputs: [first, second],
  commitments: {
    authority: "authority",
    search: "search",
    representation: "ordinary:v1",
  },
  budget: {
    maxInputItems: 2,
    maxInputBytes: 10_000,
    maxModelCalls: 2,
    maxOutputItems: 1,
    maxOutputBytes: 10_000,
  },
  idempotencyKey: "cross-room:one",
};

function planner(options: Readonly<{
  selection?: "ordinary" | "protected";
  memoryFenceCalls?: unknown[];
  memoryFenceStatus?: () => "current" | "stale" | "unavailable";
  outputAudienceCalls?: string[][];
  secondRecordAudience?: readonly string[];
  sourceAuthorityHumanRefs?: readonly string[];
  sourceAuthorityUnavailable?: boolean;
  inputAccessAudienceUnavailable?: boolean;
  outputAccessAudienceUnavailable?: boolean;
  revalidationAccessAudienceUnavailable?: boolean;
  changedLifecycle?: "current" | "stale";
}> = {}) {
  const audiences = new Map([
    ["access:a", ["human:alice", "human:bob"]],
    ["access:b", [...(options.secondRecordAudience
      ?? ["human:alice", "human:carol"])]],
    ["access:output", ["human:alice"]],
  ]);
  return new ExactCrossRoomPublicationPlanner({
    selection: {
      selectedRepresentation: options.selection ?? "ordinary",
      migrationGeneration: 1,
    },
    repository: {
      async read(input: { recordRef: string }) {
        return {
          status: "available",
          record: {
            recordRef: input.recordRef,
            lifecycle: input.recordRef === "record:a"
              ? options.changedLifecycle ?? "current"
              : "current",
            structuralHeight: 0,
            processingGeneration: 1,
            semantic: {
              observedContentFingerprint: `fingerprint:${input.recordRef}`,
              posture: "derived",
              statement: input.recordRef,
              sourceDependencies: [],
              anchors: [],
              childRecordRefs: [],
              producer: { producerRef: "reflection", policyVersion: "v1" },
              terminalAuthorityLeafHandles: [input.recordRef],
            },
          },
        } as const;
      },
    } as never,
    authority: {
      async readCurrent(recordRef: string) {
        return {
          recordRef,
          recordLifecycle: recordRef === "record:a"
            ? options.changedLifecycle ?? "current"
            : "current",
          recordDisposition: "available",
          projectionGeneration: recordRef === "record:a" ? 3 : 4,
          sourceChangeGeneration: 1,
          processingState: "current",
          alternatives: [{
            accessNamespaceId: recordRef === "record:a" ? "access:a" : "access:b",
            includesPublicBoundary: false,
            alternativeCommitment: new Uint8Array(32),
          }],
          terminalAuthorityLeafHandles: [recordRef],
          representationGeneration: 1,
        } as const;
      },
    } as never,
    sourceAuthority: {
      async resolve() {
        if (options.sourceAuthorityUnavailable === true) {
          return { status: "unavailable" as const };
        }
        return {
          status: "available" as const,
          leaf: {
            terminalAuthorityLeafHandle: "namespace:memory",
            alternatives: [{
              humanRefs: options.sourceAuthorityHumanRefs
                ?? ["human:alice", "human:bob"],
              includesPublicBoundary: false,
            }],
          },
        };
      },
    },
    memoryFences: {
      async fence(input) {
        options.memoryFenceCalls?.push(input);
        const status = options.memoryFenceStatus?.() ?? "current";
        return status === "unavailable"
          ? { status, reason: "storage_unavailable" as const }
          : { status };
      },
    },
    recordBindings: {
      read(recordRef: string) {
        const namespace = recordRef === "record:a" ? "access:a" : "publication:b";
        const bindingRef = `journal:namespace:${namespace}:ordinary:v1`;
        return Promise.resolve({
          originPublicationBindingRef: bindingRef,
          currentAccessBindingRefs: [bindingRef],
          representationGeneration: 1,
          authorityProjectionGeneration: 1,
        });
      },
    },
    accessAudiences: {
      async readExactSet(namespaceIds: readonly string[]) {
        if (
          options.inputAccessAudienceUnavailable === true
          || options.revalidationAccessAudienceUnavailable === true
            && namespaceIds.length > 1
        ) {
          return { status: "unavailable" as const };
        }
        const resolved = namespaceIds.map((namespaceId) => audiences.get(namespaceId));
        return resolved.some((value) => value === undefined)
          ? { status: "unavailable" as const }
          : { status: "available" as const, audiences: resolved as string[][] };
      },
      async resolveOrCreateExact(humanRefs: readonly string[]) {
        if (options.outputAccessAudienceUnavailable === true) {
          throw new TypeError("redacted test failure");
        }
        options.outputAudienceCalls?.push([...humanRefs]);
        return {
          accessRoomId: "room:output",
          accessNamespaceId: "access:output",
          humanRefs,
        };
      },
    },
  });
}

describe("exact cross-Room publication planner", () => {
  test("replans dependency loss from remaining evidence without old audience", async () => {
    const predecessor = {
      recordRef: "record:a",
      lifecycle: "current" as const,
      structuralHeight: 1,
      processingGeneration: 1,
      semantic: {
        observedContentFingerprint: "fingerprint:record:a",
        posture: "derived" as const,
        statement: "Old parent.",
        sourceDependencies: [],
        anchors: [],
        childRecordRefs: ["record:b"],
        producer: { producerRef: "reflection", policyVersion: "v1" },
        terminalAuthorityLeafHandles: ["namespace:a", "namespace:b"],
      },
    };
    const result = await planner().planDependencyLoss({
      predecessor,
      proposal: {
        operation: "supersede_parent",
        parentRecordRef: "record:a",
        statement: "Remaining evidence.",
        childRecordRefs: ["record:b"],
        sourceDependencies: [],
      },
      idempotencyKey: "sleep-dependency-loss:record:a:1",
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.plan.predecessorOnlyRecordRef).toBe("record:a");
    expect(result.plan.selectedInputs.map((input) => input.kind === "record"
      ? `${input.role}:${input.recordRef}`
      : input.logicalSourceRef)).toEqual([
      "changed:record:a",
      "candidate:record:b",
    ]);
    expect(result.plan.selectedInputs[1]?.read.namespaceRef).toBe("publication:b");
    expect(result.plan.output).toMatchObject({
      accessNamespaceRef: "access:output",
      publicationBindingRef: "journal:namespace:access:output:ordinary:v1",
    });
  });

  test("keeps a stale dependency-loss predecessor valid through the final fence", async () => {
    const subject = planner({ changedLifecycle: "stale" });
    const predecessor = {
      recordRef: "record:a",
      lifecycle: "stale" as const,
      structuralHeight: 1,
      processingGeneration: 1,
      semantic: {
        observedContentFingerprint: "fingerprint:record:a",
        posture: "derived" as const,
        statement: "Old parent.",
        sourceDependencies: [],
        anchors: [],
        childRecordRefs: ["record:b"],
        producer: { producerRef: "reflection", policyVersion: "v1" },
        terminalAuthorityLeafHandles: ["namespace:a", "namespace:b"],
      },
    };
    const planned = await subject.planDependencyLoss({
      predecessor,
      proposal: {
        operation: "supersede_parent",
        parentRecordRef: "record:a",
        statement: "Remaining evidence.",
        childRecordRefs: ["record:b"],
        sourceDependencies: [],
      },
      idempotencyKey: "sleep-dependency-loss:record:a:2",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    expect(await subject.revalidate({
      plan: planned.plan,
      predecessorRecordRef: "record:a",
    })).toEqual({
      status: "current",
      predecessorAudience: "different",
    });
  });

  test("materializes only the selected dependencies' Human intersection", async () => {
    const result = await planner().plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "create_parent",
        statement: "A shared conclusion.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.plan.output).toMatchObject({
      accessRoomRef: "room:output",
      accessNamespaceRef: "access:output",
      publicationBindingRef: "journal:namespace:access:output:ordinary:v1",
      includesPublicBoundary: false,
    });
    expect(result.plan.selectedInputs.map((input) => input.kind === "record"
      ? input.recordRef
      : input.logicalSourceRef)).toEqual(["record:a", "record:b"]);
    expect(result.plan.modelExposureDependencies).toBeUndefined();
  });

  test("fixes audience from broad cited and restricted uncited model exposure", async () => {
    const audienceCalls: string[][] = [];
    const result = await planner({
      outputAudienceCalls: audienceCalls,
      secondRecordAudience: ["human:alice"],
    }).planExposure({
      applicationPlanToken: token,
      candidatePlan,
      modelExposureDependencies: [
        {
          kind: "record",
          recordRef: "record:a",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: ["record:a"],
        },
        {
          kind: "record",
          recordRef: "record:b",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: ["record:b"],
        },
      ],
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(audienceCalls).toEqual([["human:alice"]]);
    expect(result.plan.selectedInputs).toEqual(candidatePlan.inputs);
    expect(result.plan.modelExposureDependencies).toHaveLength(2);
  });

  test("keeps stale changed Record in the full exposure audience during repair", async () => {
    const audienceCalls: string[][] = [];
    const result = await planner({
      outputAudienceCalls: audienceCalls,
      changedLifecycle: "stale",
      secondRecordAudience: ["human:alice"],
    }).planExposure({
      applicationPlanToken: token,
      candidatePlan,
      modelExposureDependencies: [
        {
          kind: "record",
          recordRef: "record:a",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: ["record:a"],
        },
        {
          kind: "record",
          recordRef: "record:b",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: ["record:b"],
        },
      ],
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(audienceCalls).toEqual([["human:alice"]]);
    expect(result.plan.selectedInputs).toEqual(candidatePlan.inputs);
    expect(result.plan.modelExposureDependencies).toHaveLength(2);
  });

  test.each([
    ["omitted", [{
      kind: "record" as const,
      recordRef: "record:a",
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["record:a"],
    }], "unavailable"],
    ["duplicate", [
      {
        kind: "record" as const,
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["record:a"],
      },
      {
        kind: "record" as const,
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["record:a"],
      },
    ], "unavailable"],
    ["stale", [
      {
        kind: "record" as const,
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["record:a"],
      },
      {
        kind: "record" as const,
        recordRef: "record:b",
        observedProcessingGeneration: 99,
        terminalAuthorityLeafHandles: ["record:b"],
      },
    ], "stale"],
  ] as const)("rejects %s exposure coordinates", async (_name, exposure, status) => {
    expect(await planner().planExposure({
      applicationPlanToken: token,
      candidatePlan,
      modelExposureDependencies: exposure,
    })).toEqual(status === "stale"
      ? { status: "stale", failureDetail: "publication_plan_stale" }
      : { status: "unavailable", failureDetail: "publication_plan_invalid" });
  });

  test("includes an uncited Memory source in the fixed model audience", async () => {
    const memoryRef = "00000000-0000-4000-8000-000000000009";
    const memory = {
      kind: "source" as const,
      sourceKind: "memory" as const,
      role: "candidate" as const,
      logicalSourceRef: `memory:${memoryRef}`,
      contentGeneration: 2,
      representationGeneration: 3,
      authorityGeneration: 1,
      read: { namespaceRef: "namespace:memory", bindingRef: "binding:memory" },
      crossRoomFence: {
        memoryRef,
        embeddingRevision: 2,
        embeddingProvenance: {
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small" as const,
          dimensions: 1_536 as const,
          contractVersion: 1 as const,
        },
        updatedAtCoordinate: "2026-08-20T00:00:00.000Z",
        authorityNamespaceRefs: ["namespace:memory"],
        audience: {
          humanRefs: ["human:alice"],
          includesPublicBoundary: false,
        },
      },
    };
    const audienceCalls: string[][] = [];
    const result = await planner({
      outputAudienceCalls: audienceCalls,
      sourceAuthorityHumanRefs: ["human:alice"],
    }).planExposure({
      applicationPlanToken: token,
      candidatePlan: { ...candidatePlan, inputs: [first, memory] },
      modelExposureDependencies: [
        {
          kind: "record",
          recordRef: "record:a",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: ["record:a"],
        },
        {
          kind: "source",
          sourceKind: "memory",
          logicalSourceRef: `memory:${memoryRef}`,
          observedRevision: "2",
          observedContentFingerprint: "fingerprint:memory",
          terminalAuthorityLeafHandle: "namespace:memory",
        },
      ],
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(audienceCalls).toEqual([["human:alice"]]);
    expect(result.plan.modelExposureDependencies?.[1]).toMatchObject({
      kind: "source",
      logicalSourceRef: `memory:${memoryRef}`,
    });
  });



  test("keeps an exact same-Room Message in exposure authority without cross-Room discovery", async () => {
    const message = {
      kind: "source" as const,
      sourceKind: "message" as const,
      role: "candidate" as const,
      logicalSourceRef: "message:17",
      contentGeneration: 0,
      representationGeneration: 1,
      authorityGeneration: 1,
      read: {namespaceRef: "namespace:message", bindingRef: "binding:message"},
    };
    const messageDependency = {
      kind: "source" as const,
      sourceKind: "message" as const,
      logicalSourceRef: "message:17",
      observedRevision: "0",
      observedContentFingerprint: "fingerprint:message:17:0",
      terminalAuthorityLeafHandle: "namespace:message",
    };
    const audienceCalls: string[][] = [];
    const memoryFenceCalls: unknown[] = [];
    const result = await planner({
      outputAudienceCalls: audienceCalls,
      sourceAuthorityHumanRefs: ["human:alice"],
      memoryFenceCalls,
    }).planExposure({
      applicationPlanToken: token,
      candidatePlan: {...candidatePlan, inputs: [first, message]},
      modelExposureDependencies: [{
        kind: "record",
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["record:a"],
      }, messageDependency],
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(audienceCalls).toEqual([["human:alice"]]);
    expect(memoryFenceCalls).toEqual([]);
    expect(result.plan.selectedInputs[1]).toEqual(message);
    expect(result.plan.modelExposureDependencies?.[1]).toEqual(messageDependency);
  });

  test("preserves changed-first canonical order when its ID sorts after a candidate", async () => {
    const changed = {
      ...first,
      recordRef: "record:z",
      authorityGeneration: 4,
    };
    const candidate = {
      ...second,
      recordRef: "record:a",
      authorityGeneration: 3,
    };
    const result = await planner().plan({
      applicationPlanToken: token,
      candidatePlan: {
        ...candidatePlan,
        workRef: changed.recordRef,
        inputs: [changed, candidate],
      },
      proposal: {
        operation: "create_parent",
        statement: "A shared conclusion independent of identifier order.",
        childRecordRefs: [candidate.recordRef, changed.recordRef],
        sourceDependencies: [],
      },
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.plan.selectedInputs.map((input) => input.kind === "record"
      ? `${input.role}:${input.recordRef}`
      : `${input.role}:${input.logicalSourceRef}`)).toEqual([
      "changed:record:z",
      "candidate:record:a",
    ]);
  });

  test("rejects a selected subset that omits the changed Record", async () => {
    expect(await planner().plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "create_parent",
        statement: "The changed Record is absent.",
        childRecordRefs: ["record:b"],
        sourceDependencies: [],
      },
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_plan_invalid",
    });
  });

  test("classifies unavailable input access authority without exposing details", async () => {
    expect(await planner({ inputAccessAudienceUnavailable: true }).plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "create_parent",
        statement: "A shared conclusion.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_input_access_audience_unavailable",
    });
  });

  test("distinguishes output access materialization from input authority", async () => {
    expect(await planner({ outputAccessAudienceUnavailable: true }).plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "create_parent",
        statement: "A shared conclusion.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_output_access_audience_unavailable",
    });
  });

  test("distinguishes final access revalidation from planning", async () => {
    const subject = planner({ revalidationAccessAudienceUnavailable: true });
    const planned = await subject.plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:a",
        statement: "A narrower conclusion.",
        additionRecordRefs: ["record:b"],
        additionSourceDependencies: [],
      },
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    expect(await subject.revalidate({
      plan: planned.plan,
      predecessorRecordRef: "record:a",
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_revalidation_access_audience_unavailable",
    });
  });

  test("reports different predecessor authority for higher-parent evolution", async () => {
    const planned = await planner().plan({
      applicationPlanToken: token,
      candidatePlan,
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:a",
        statement: "A narrower conclusion.",
        additionRecordRefs: ["record:b"],
        additionSourceDependencies: [],
      },
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    expect(await planner().revalidate({
      plan: planned.plan,
      predecessorRecordRef: "record:a",
    })).toEqual({ status: "current", predecessorAudience: "different" });
  });

  test("fences selected cross-Room Memory authority before planning and publication", async () => {
    const memoryRef = "00000000-0000-4000-8000-000000000001";
    const memory = {
      kind: "source" as const,
      sourceKind: "memory" as const,
      role: "candidate" as const,
      logicalSourceRef: `memory:${memoryRef}`,
      contentGeneration: 2,
      representationGeneration: 3,
      authorityGeneration: 1,
      read: { namespaceRef: "namespace:memory", bindingRef: "binding:memory" },
      crossRoomFence: {
        memoryRef,
        embeddingRevision: 2,
        embeddingProvenance: {
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small" as const,
          dimensions: 1_536 as const,
          contractVersion: 1 as const,
        },
        updatedAtCoordinate: "2026-08-20T00:00:00.000Z",
        authorityNamespaceRefs: ["namespace:memory"],
        audience: {
          humanRefs: ["human:alice", "human:bob"],
          includesPublicBoundary: false,
        },
        protectedObjectId: "memory:v1:protected-object",
        protectedAccessRevision: 4,
      },
    };
    const memoryPlan: CrossRoomCandidatePlan = {
      ...candidatePlan,
      inputs: [first, memory],
      commitments: {
        ...candidatePlan.commitments,
        representation: "protected:v1",
      },
    };
    const fenceCalls: unknown[] = [];
    let fenceStatus: "current" | "stale" | "unavailable" = "current";
    const subject = planner({
      selection: "protected",
      memoryFenceCalls: fenceCalls,
      memoryFenceStatus: () => fenceStatus,
    });
    const proposal = {
      operation: "create_parent" as const,
      statement: "A grounded shared preference.",
      childRecordRefs: ["record:a"],
      sourceDependencies: [{
        sourceKind: "memory",
        logicalSourceRef: `memory:${memoryRef}`,
        observedRevision: "2",
        observedContentFingerprint: "fingerprint:memory",
        terminalAuthorityLeafHandle: "namespace:memory",
        authorityBearing: true,
      }],
    } as const;
    const planned = await subject.plan({
      applicationPlanToken: token,
      candidatePlan: memoryPlan,
      proposal,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    expect(fenceCalls).toHaveLength(1);
    expect(fenceCalls[0]).toEqual(expect.objectContaining({
      selection: { selectedRepresentation: "protected", migrationGeneration: 1 },
      candidates: [expect.objectContaining({
        protectedCryptoObjectId: "memory:v1:protected-object",
        protectedCryptoAccessRevision: 4,
      })],
    }));
    expect(await subject.revalidate({ plan: planned.plan })).toEqual({
      status: "current",
    });
    expect(fenceCalls).toHaveLength(2);
    fenceStatus = "stale";
    expect(await subject.plan({
      applicationPlanToken: token,
      candidatePlan: memoryPlan,
      proposal,
    })).toEqual({
      status: "stale",
      failureDetail: "publication_plan_stale",
    });
    expect(await subject.revalidate({ plan: planned.plan })).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(fenceCalls).toHaveLength(4);
    fenceStatus = "unavailable";
    expect(await subject.plan({
      applicationPlanToken: token,
      candidatePlan: memoryPlan,
      proposal,
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_memory_fence_unavailable",
    });
    expect(await planner({ sourceAuthorityUnavailable: true }).plan({
      applicationPlanToken: token,
      candidatePlan: memoryPlan,
      proposal,
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_source_authority_unavailable",
    });
  });
});
