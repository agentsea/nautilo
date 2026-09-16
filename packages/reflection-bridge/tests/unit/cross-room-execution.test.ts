import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertCrossRoomCandidatePlan,
  assertCrossRoomPublicationPlan,
  crossRoomApplicationPlanToken,
  CROSS_ROOM_EXECUTION_PLAN_LIMITS,
  intersectSingleAuthorityAlternatives,
  ProtectedUnavailableCrossRoomExecutionAdapter,
  type CrossRoomCandidatePlan,
  type CrossRoomPublicationPlan,
} from "../../src/server/cross-room-execution";

function candidatePlan(): CrossRoomCandidatePlan {
  return {
    workRef: "record:changed",
    workGeneration: 7,
    policyVersion: "candidate-policy-v1",
    inputs: [
      {
        kind: "record",
        role: "changed",
        recordRef: "record:changed",
        processingGeneration: 7,
        representationGeneration: 3,
        authorityGeneration: 5,
        read: { namespaceRef: "namespace:a", bindingRef: "read:a" },
      },
      {
        kind: "record",
        role: "candidate",
        recordRef: "record:neighbor",
        processingGeneration: 2,
        representationGeneration: 4,
        authorityGeneration: 6,
        read: { namespaceRef: "namespace:b", bindingRef: "read:b" },
      },
      {
        kind: "source",
        sourceKind: "memory",
        role: "candidate",
        logicalSourceRef: "memory:authored",
        contentGeneration: 9,
        representationGeneration: 2,
        authorityGeneration: 8,
        read: { namespaceRef: "namespace:c", bindingRef: "read:c" },
      },
    ],
    commitments: {
      authority: "commitment:authority",
      search: "commitment:search",
      representation: "commitment:representation",
    },
    budget: {
      maxInputItems: 3,
      maxInputBytes: 64_000,
      maxModelCalls: 2,
      maxOutputItems: 1,
      maxOutputBytes: 16_000,
    },
    idempotencyKey: "cross-room:record:changed:7",
  };
}

function publicationPlan(): CrossRoomPublicationPlan {
  const candidate = candidatePlan();
  return {
    applicationPlanToken: crossRoomApplicationPlanToken("application-plan:one"),
    policyVersion: candidate.policyVersion,
    selectedInputs: candidate.inputs,
    output: {
      accessRoomRef: "room:access:alice",
      accessNamespaceRef: "namespace:access:alice",
      publicationBindingRef: "publish:access:alice",
      authorityGeneration: 11,
      includesPublicBoundary: false,
    },
    commitments: {
      authority: candidate.commitments.authority,
      representation: candidate.commitments.representation,
    },
    budget: candidate.budget,
    idempotencyKey: "cross-room-publication:record:changed:7",
  };
}

describe("cross-Room exact-set execution contract", () => {
  test("accepts bounded canonical candidate and publication plans", () => {
    expect(() => assertCrossRoomCandidatePlan(candidatePlan())).not.toThrow();
    expect(() => assertCrossRoomPublicationPlan(publicationPlan())).not.toThrow();
  });

  test("requires a saved publication plan to match every candidate input", () => {
    const candidate = candidatePlan();
    const publication = publicationPlan();
    const { applicationPlanToken: _token, ...fixed } = publication;
    const exposures = candidate.inputs.map((input) => input.kind === "record"
      ? {
          kind: "record" as const,
          recordRef: input.recordRef,
          observedProcessingGeneration: input.processingGeneration,
          terminalAuthorityLeafHandles: [`namespace:${input.recordRef}`],
        }
      : {
          kind: "source" as const,
          sourceKind: input.sourceKind,
          logicalSourceRef: input.logicalSourceRef,
          observedRevision: String(input.contentGeneration),
          terminalAuthorityLeafHandle: input.read.namespaceRef,
        });
    expect(() => assertCrossRoomCandidatePlan({
      ...candidate,
      publicationPlan: { ...fixed, modelExposureDependencies: exposures },
    })).not.toThrow();
    expect(() => assertCrossRoomCandidatePlan({
      ...candidate,
      publicationPlan: {
        ...fixed,
        selectedInputs: fixed.selectedInputs.map((input) => input.kind === "record"
          && input.role === "candidate"
          ? { ...input, processingGeneration: input.processingGeneration + 1 }
          : input),
        modelExposureDependencies: exposures,
      },
    })).toThrow();
    expect(() => assertCrossRoomCandidatePlan({
      ...candidate,
      publicationPlan: fixed,
    })).toThrow("requires model exposure");
  });

  test("rejects every publication subset that omits the changed Record", () => {
    const withoutChanged = publicationPlan();
    expect(() => assertCrossRoomPublicationPlan({
      ...withoutChanged,
      selectedInputs: withoutChanged.selectedInputs.slice(1),
    })).toThrow("requires exactly one changed Record");

    const sourceOnly = publicationPlan();
    expect(() => assertCrossRoomPublicationPlan({
      ...sourceOnly,
      selectedInputs: [sourceOnly.selectedInputs[2]!],
    })).toThrow("requires exactly one changed Record");
  });

  test("bounds and validates the opaque application-plan token", () => {
    expect(String(crossRoomApplicationPlanToken("application-plan:one")))
      .toBe("application-plan:one");
    expect(() => crossRoomApplicationPlanToken("application plan"))
      .toThrow("bounded and portable");
    expect(() => crossRoomApplicationPlanToken(
      "a".repeat(CROSS_ROOM_EXECUTION_PLAN_LIMITS.applicationPlanTokenBytes + 1),
    )).toThrow("bounded and portable");
  });

  test("rejects non-portable, non-canonical, duplicate, and over-budget plans", () => {
    const invalidPortable = publicationPlan();
    expect(() => assertCrossRoomPublicationPlan({
      ...invalidPortable,
      output: {
        ...invalidPortable.output,
        accessNamespaceRef: "namespace with spaces",
      },
    })).toThrow("bounded portable identifier");

    const nonCanonical = candidatePlan();
    expect(() => assertCrossRoomCandidatePlan({
      ...nonCanonical,
      inputs: [nonCanonical.inputs[0]!, nonCanonical.inputs[2]!, nonCanonical.inputs[1]!],
    })).toThrow("canonically ordered");

    const duplicate = candidatePlan();
    expect(() => assertCrossRoomCandidatePlan({
      ...duplicate,
      inputs: [...duplicate.inputs, duplicate.inputs[1]!],
      budget: { ...duplicate.budget, maxInputItems: 4 },
    })).toThrow("logical coordinates must be unique");

    const overBudget = candidatePlan();
    expect(() => assertCrossRoomCandidatePlan({
      ...overBudget,
      budget: {
        ...overBudget.budget,
        maxInputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes + 1,
      },
    })).toThrow("input-byte budget is out of bounds");
  });

  test("requires one changed Record and only current single-source kind", () => {
    const value = candidatePlan();
    expect(() => assertCrossRoomCandidatePlan({
      ...value,
      inputs: value.inputs.map((input) => ({ ...input, role: "candidate" as const })),
    })).toThrow("exactly one changed Record");

    const source = value.inputs[2]!;
    expect(source.kind).toBe("source");
    if (source.kind !== "source") throw new Error("fixture invariant");
    expect(() => assertCrossRoomCandidatePlan({
      ...value,
      inputs: [
        value.inputs[0]!,
        value.inputs[1]!,
        { ...source, sourceKind: "artifact" as never },
      ],
    })).toThrow("source kind must be memory");
  });

  test("requires protected Memory fence object and access revision together", () => {
    const plan = candidatePlan();
    const memory = {
      kind: "source" as const,
      sourceKind: "memory" as const,
      role: "candidate" as const,
      logicalSourceRef: "memory:protected",
      contentGeneration: 2,
      representationGeneration: 2,
      authorityGeneration: 1,
      read: { namespaceRef: "namespace:protected", bindingRef: "binding:protected" },
      crossRoomFence: {
        memoryRef: "protected",
        embeddingRevision: 2,
        embeddingProvenance: {
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small",
          dimensions: 1_536 as const,
          contractVersion: 1 as const,
        },
        updatedAtCoordinate: "2026-08-20T00:00:00.000Z",
        authorityNamespaceRefs: ["namespace:protected"],
        audience: {
          humanRefs: ["human:alice"],
          includesPublicBoundary: false,
        },
        protectedObjectId: "memory:v1:object",
      },
    };
    expect(() => assertCrossRoomCandidatePlan({
      ...plan,
      inputs: [plan.inputs[0]!, memory],
      budget: { ...plan.budget, maxInputItems: 2 },
    })).toThrow("protected fence is incomplete");
    expect(() => assertCrossRoomCandidatePlan({
      ...plan,
      inputs: [
        plan.inputs[0]!,
        {
          ...memory,
          crossRoomFence: {
            ...memory.crossRoomFence,
            protectedAccessRevision: 0,
          },
        },
      ],
      budget: { ...plan.budget, maxInputItems: 2 },
    })).not.toThrow();
  });

  test("intersects one exact alternative per input and preserves the public boundary only universally", () => {
    expect(intersectSingleAuthorityAlternatives([
      [{ humanRefs: ["human:alice", "human:bob"], includesPublicBoundary: true }],
      [{ humanRefs: ["human:alice", "human:carol"], includesPublicBoundary: true }],
    ])).toEqual({
      status: "available",
      alternative: {
        humanRefs: ["human:alice"],
        includesPublicBoundary: true,
      },
    });

    expect(intersectSingleAuthorityAlternatives([
      [{ humanRefs: ["human:alice", "human:bob"], includesPublicBoundary: true }],
      [{ humanRefs: ["human:alice"], includesPublicBoundary: false }],
    ])).toEqual({
      status: "available",
      alternative: {
        humanRefs: ["human:alice"],
        includesPublicBoundary: false,
      },
    });
  });

  test("types zero, multiple, and empty intersections without favoring an alternative", () => {
    expect(intersectSingleAuthorityAlternatives([
      [{ humanRefs: ["human:alice"], includesPublicBoundary: false }],
      [],
    ])).toEqual({ status: "unavailable", reason: "no_effective_audience" });

    expect(intersectSingleAuthorityAlternatives([
      [{ humanRefs: ["human:alice"], includesPublicBoundary: false }],
      [
        { humanRefs: ["human:alice"], includesPublicBoundary: false },
        { humanRefs: ["human:bob"], includesPublicBoundary: false },
      ],
    ])).toEqual({
      status: "unavailable",
      reason: "unsupported_authority_shape",
    });

    expect(intersectSingleAuthorityAlternatives([
      [{ humanRefs: ["human:alice"], includesPublicBoundary: true }],
      [{ humanRefs: ["human:bob"], includesPublicBoundary: true }],
    ])).toEqual({ status: "unavailable", reason: "no_effective_audience" });
  });

  test("rejects noncanonical authority inputs rather than silently normalizing them", () => {
    expect(() => intersectSingleAuthorityAlternatives([[
      {
        humanRefs: ["human:bob", "human:alice"],
        includesPublicBoundary: false,
      },
    ]])).toThrow("canonically ordered");
    expect(() => intersectSingleAuthorityAlternatives([[
      {
        humanRefs: ["human:alice", "human:alice"],
        includesPublicBoundary: false,
      },
    ]])).toThrow("unique and canonically ordered");
  });

  test("protected selection returns one stable unavailable result with no execution dependency", async () => {
    const adapter = new ProtectedUnavailableCrossRoomExecutionAdapter<never>();
    expect(await adapter.execute(candidatePlan())).toEqual({
      status: "unavailable",
      reason: "protected_execution_unavailable",
    });
    expect(await adapter.execute(candidatePlan())).toEqual({
      status: "unavailable",
      reason: "protected_execution_unavailable",
    });
  });

  test("keeps the seam free of lattice, crypto, credential, Grant, and payload fields", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../src/server/cross-room-execution.ts"),
      "utf8",
    );
    const durablePlanContracts = source.slice(
      source.indexOf("export interface CrossRoomCandidatePlan"),
      source.indexOf("export type CrossRoomAuthorityOutcome"),
    );
    expect(source).not.toContain("@nautilo/lattice");
    expect(source).not.toMatch(/\b(?:crypto|credential|grant|device|recipient)\b/iu);
    expect(durablePlanContracts)
      .not.toMatch(/\b(?:payloadBytes|statement|prompt|humanRefs)\s*[?:]/u);
  });
});
