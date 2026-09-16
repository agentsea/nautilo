import { describe, expect, test } from "bun:test";

import {
  durableEnvelopeToRecordSnapshot,
  type DurableRecordEnvelope,
} from "@nautilo/reflection/durable";
import type { RecordEmbeddingV1 } from "@nautilo/reflection/search";

import {
  createCrossRoomApplicationPlanCodec,
  OrdinaryCrossRoomOrganizerPartition,
  ProtectedUnavailableCrossRoomOrganizerPartition,
} from "../../src/server/cross-room-organizer-partition";
import type {
  CrossRoomChangedRecordCoordinate,
  CrossRoomOrganizerCandidate,
} from "../../src/server/postgres-cross-room-organizer-store";

const selection = {
  selectedRepresentation: "ordinary",
  migrationGeneration: 1,
} as const;
const embedding: RecordEmbeddingV1 = {
  provenance: {
    provider: "openai",
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.1))),
};
const audience = {
  humanRefs: ["11111111-1111-4111-8111-111111111111"],
  includesPublicBoundary: false,
} as const;
const changedCoordinate: CrossRoomChangedRecordCoordinate = {
  kind: "record",
  recordRef: "record:changed",
  structuralHeight: 0,
  recordProcessingGeneration: 1,
  searchProjectionGeneration: 1,
  payloadRepresentationGeneration: 1,
  authorityProjectionGeneration: 1,
  authorityAccessNamespaceRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  audience,
  readNamespaceRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  readBindingRef:
    "journal:namespace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:ordinary:v1",
};
const recordCandidate: CrossRoomOrganizerCandidate = {
  ...changedCoordinate,
  kind: "record",
  recordRef: "record:parent",
  structuralHeight: 1,
  score: 0.9,
  readNamespaceRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  readBindingRef:
    "journal:namespace:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:ordinary:v1",
};
const memoryCandidate: CrossRoomOrganizerCandidate = {
  kind: "memory",
  memoryRef: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  logicalSourceRef: "memory:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  score: 0.8,
  contentRevision: 3,
  embeddingRevision: 3,
  embeddingProvenance: embedding.provenance,
  updatedAtCoordinate: "2026-08-20T12:00:00.000000Z",
  authorityNamespaceRefs: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
  audience: {
    humanRefs: ["11111111-1111-4111-8111-111111111111"],
    includesPublicBoundary: true,
  },
  readNamespaceRef: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  readBindingRef:
    "journal:namespace:dddddddd-dddd-4ddd-8ddd-dddddddddddd:ordinary:v1",
};

function record(recordRef: string, height: number): DurableRecordEnvelope {
  return {
    recordRef,
    semantic: {
      observedContentFingerprint: `fingerprint:${recordRef}`,
      posture: "derived",
      statement: `Statement ${recordRef}`,
      sourceDependencies: [],
      anchors: [{ anchorRef: "room:origin", kind: "room", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "reflection", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["namespace:origin"],
    },
    lifecycle: "current",
    structuralHeight: height,
    processingGeneration: 1,
  };
}

const claim = {
  logicalObjectRef: "record:changed",
  generation: 1,
  recordRef: "record:changed",
  changeReason: "created",
  stage: "organization",
  leaseToken: "lease:one",
} as const;
const binding = {
  roomAnchorRef: "room:changed",
  invocationAudience: audience,
  readBindingRef: changedCoordinate.readBindingRef,
  searchBindingRef: changedCoordinate.readBindingRef,
  publicationBindingRef: changedCoordinate.readBindingRef,
};

describe("cross-Room Organizer partition", () => {
  test("fences before opens and separates equal-audience parent evolution", async () => {
    const events: string[] = [];
    const codec = createCrossRoomApplicationPlanCodec(new Uint8Array(32).fill(7));
    const partition = new OrdinaryCrossRoomOrganizerPartition({
      selection,
      store: {
        async discover() {
          events.push("discover");
          return {
            status: "available",
            changed: changedCoordinate,
            candidates: [recordCandidate, memoryCandidate],
            metrics: {
              recordRowsConsidered: 1,
              memoryRowsConsidered: 1,
              rowsSelected: 2,
              unsupportedAuthorityShapes: 0,
              authorityParentsResolved: 0,
              authorityParentsSkipped: 0,
              topologyWork: 2,
            },
          } as const;
        },
        async fence() {
          events.push("fence");
          return { status: "current" } as const;
        },
      } as never,
      repository: {
        async read() {
          events.push("open:record");
          return { status: "available", record: record("record:parent", 1) } as const;
        },
      } as never,
      memories: {
        async open({ candidate }) {
          events.push("open:memory");
          return {
            status: "available",
            snapshot: {
              recordRef: candidate.logicalSourceRef,
              observedContentFingerprint: "fingerprint:memory",
              posture: "authored",
              anchors: ["room:memory"],
              statement: "An authored preference.",
              sourceRefs: [],
              childRecordRefs: [],
              structuralHeight: 0,
              lifecycle: "current",
            },
            dependency: {
              sourceKind: "memory/v1",
              logicalSourceRef: candidate.logicalSourceRef,
              observedRevision: String(candidate.contentRevision),
              observedContentFingerprint: "fingerprint:memory",
              terminalAuthorityLeafHandle: candidate.readNamespaceRef,
              authorityBearing: true,
            },
          } as const;
        },
      },
      codec,
      publicationPlans: {
        async plan() {
          return {
            status: "unavailable",
            failureDetail: "publication_plan_invalid",
          } as const;
        },
      },
    });

    const result = await partition.augment({
      claim,
      changed: record("record:changed", 0),
      binding,
      queryEmbedding: embedding,
      sameRoomCandidates: [],
      sameRoomParents: [],
      sameRoomPlanInputs: [],
      authorityParentSeeds: [],
    });

    expect(events).toEqual(["discover", "fence", "open:record", "open:memory"]);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.existingParents.map((entry) => entry.snapshot.recordRef))
      .toEqual(["record:parent"]);
    expect(result.candidates.map((entry) => entry.snapshot.recordRef))
      .toEqual(["memory:cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    const plan = codec.open(result.applicationPlanToken);
    expect(plan.inputs).toHaveLength(3);
    expect(plan.inputs[0]).toMatchObject({ role: "changed", recordRef: "record:changed" });
  });

  test("seals an exact plan for a multi-leaf parent with no cross-Room ranks", async () => {
    const events: string[] = [];
    const codec = createCrossRoomApplicationPlanCodec(new Uint8Array(32).fill(8));
    const sameRoomCandidate = {
      kind: "record" as const,
      role: "candidate" as const,
      recordRef: "record:same-room",
      processingGeneration: 4,
      representationGeneration: 2,
      authorityGeneration: 3,
      read: {
        namespaceRef: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        bindingRef:
          "journal:namespace:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:ordinary:v1",
      },
    };
    const partition = new OrdinaryCrossRoomOrganizerPartition({
      selection,
      store: {
        async discover() {
          events.push("discover");
          return {
            status: "available",
            changed: changedCoordinate,
            candidates: [],
            metrics: {
              recordRowsConsidered: 0,
              memoryRowsConsidered: 0,
              rowsSelected: 0,
              unsupportedAuthorityShapes: 0,
              authorityParentsResolved: 0,
              authorityParentsSkipped: 0,
              topologyWork: 0,
            },
          } as const;
        },
        async fence(input: Readonly<{
          changed: CrossRoomChangedRecordCoordinate;
          candidates: readonly CrossRoomOrganizerCandidate[];
        }>) {
          events.push("fence");
          expect(input.changed).toEqual(changedCoordinate);
          expect(input.candidates).toEqual([]);
          return { status: "current" } as const;
        },
      } as never,
      repository: {
        async read() {
          throw new Error("zero cross-Room ranks must not open a Record");
        },
      } as never,
      memories: {
        async open() {
          throw new Error("zero cross-Room ranks must not open a Memory");
        },
      },
      codec,
      publicationPlans: {
        async plan() {
          return {
            status: "unavailable",
            failureDetail: "publication_plan_invalid",
          } as const;
        },
      },
    });

    const result = await partition.augment({
      claim: { ...claim, changeReason: "scheduled_review" },
      changed: {
        ...record("record:changed", 4),
        semantic: {
          ...record("record:changed", 4).semantic,
          terminalAuthorityLeafHandles: ["namespace:one", "namespace:two"],
        },
      },
      binding,
      queryEmbedding: embedding,
      sameRoomCandidates: [],
      sameRoomParents: [],
      sameRoomPlanInputs: [sameRoomCandidate],
      authorityParentSeeds: [],
    });

    expect(events).toEqual(["discover", "fence"]);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toEqual([]);
    expect(result.existingParents).toEqual([]);
    const plan = codec.open(result.applicationPlanToken);
    expect(plan.inputs).toEqual([
      expect.objectContaining({
        kind: "record",
        role: "changed",
        recordRef: "record:changed",
      }),
      sameRoomCandidate,
    ]);
  });

  test("seals one fixed full-exposure plan and reuses it for publication", async () => {
    const baseCodec = createCrossRoomApplicationPlanCodec(new Uint8Array(32).fill(10));
    let seals = 0;
    const codec = {
      seal(plan: Parameters<typeof baseCodec.seal>[0]) {
        seals += 1;
        return baseCodec.seal(plan);
      },
      open: baseCodec.open,
    };
    const sameRoomRecord = {
      kind: "record" as const,
      role: "candidate" as const,
      recordRef: "record:same-room",
      processingGeneration: 2,
      representationGeneration: 1,
      authorityGeneration: 2,
      read: { namespaceRef: "namespace:same", bindingRef: "binding:same" },
    };
    const sameRoomSource = {
      kind: "source" as const,
      sourceKind: "memory" as const,
      role: "candidate" as const,
      logicalSourceRef: "memory:same-room",
      contentGeneration: 5,
      representationGeneration: 6,
      authorityGeneration: 1,
      read: { namespaceRef: "namespace:source", bindingRef: "binding:source" },
    };
    const sourceDependency = {
      sourceKind: "memory",
      logicalSourceRef: "memory:same-room",
      observedRevision: "5",
      observedContentFingerprint: "sha256:source",
      terminalAuthorityLeafHandle: "namespace:source",
      authorityBearing: true,
    } as const;
    const exposureCalls: unknown[] = [];
    let ordinaryPlans = 0;
    let emptyAudience = false;
    const partition = new OrdinaryCrossRoomOrganizerPartition({
      selection,
      store: {
        async discover() {
          return {
            status: "available",
            changed: changedCoordinate,
            candidates: [],
            metrics: {
              recordRowsConsidered: 0,
              memoryRowsConsidered: 0,
              rowsSelected: 0,
              unsupportedAuthorityShapes: 0,
              authorityParentsResolved: 0,
              authorityParentsSkipped: 0,
              topologyWork: 0,
            },
          } as const;
        },
        async fence() {
          return { status: "current" } as const;
        },
      } as never,
      repository: {
        async read(input: { recordRef: string }) {
          return {
            status: "available",
            record: {
              ...record(input.recordRef, 0),
              processingGeneration: input.recordRef === "record:same-room" ? 2 : 1,
              semantic: {
                ...record(input.recordRef, 0).semantic,
                terminalAuthorityLeafHandles: [`namespace:${input.recordRef}`],
              },
            },
          } as const;
        },
      } as never,
      memories: {} as never,
      codec,
      publicationPlans: {
        async plan() {
          ordinaryPlans += 1;
          return { status: "unavailable", failureDetail: "publication_plan_invalid" } as const;
        },
        async planExposure(input) {
          exposureCalls.push(input);
          if (emptyAudience) {
            return { status: "no_change", reason: "no_effective_audience" } as const;
          }
          return {
            status: "planned",
            plan: {
              applicationPlanToken: input.applicationPlanToken,
              policyVersion: input.candidatePlan.policyVersion,
              selectedInputs: input.candidatePlan.inputs,
              modelExposureDependencies: input.modelExposureDependencies,
              output: {
                accessRoomRef: "room:fixed",
                accessNamespaceRef: "namespace:fixed",
                publicationBindingRef: "binding:fixed",
                authorityGeneration: 2,
                includesPublicBoundary: false,
              },
              commitments: {
                authority: "authority:fixed",
                representation: input.candidatePlan.commitments.representation,
              },
              budget: input.candidatePlan.budget,
              idempotencyKey: "sleep:record:changed:1",
            },
          } as const;
        },
      },
    });
    const augmentation = {
      claim,
      changed: record("record:changed", 0),
      binding,
      queryEmbedding: embedding,
      sameRoomCandidates: [
        {
          handle: "C1",
          snapshot: durableEnvelopeToRecordSnapshot(record("record:same-room", 0)),
          dependency: { kind: "record" as const, recordRef: "record:same-room" },
        },
        {
          handle: "C2",
          snapshot: durableEnvelopeToRecordSnapshot(record("memory:same-room", 0)),
          dependency: { kind: "source" as const, dependency: sourceDependency },
        },
      ],
      sameRoomParents: [],
      sameRoomPlanInputs: [sameRoomRecord, sameRoomSource],
      authorityParentSeeds: [],
    };

    const result = await partition.augment(augmentation);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(seals).toBe(1);
    expect(exposureCalls).toHaveLength(1);
    const candidate = codec.open(result.applicationPlanToken);
    expect(candidate.publicationPlan).toBeDefined();
    expect(candidate.publicationPlan).not.toHaveProperty("applicationPlanToken");
    expect(candidate.publicationPlan?.modelExposureDependencies).toEqual([
      expect.objectContaining({ kind: "record", recordRef: "record:changed" }),
      expect.objectContaining({ kind: "record", recordRef: "record:same-room" }),
      expect.objectContaining({ kind: "source", logicalSourceRef: "memory:same-room" }),
    ]);
    expect(await partition.planPublication({
      applicationPlanToken: result.applicationPlanToken,
      proposal: { operation: "no_change" },
    })).toMatchObject({
      status: "planned",
      plan: { applicationPlanToken: result.applicationPlanToken },
    });
    expect(ordinaryPlans).toBe(0);

    emptyAudience = true;
    expect(await partition.augment(augmentation)).toEqual({
      status: "no_change",
      reason: "no_effective_audience",
    });
    expect(seals).toBe(1);
  });

  test("protected cross-Room unavailability preserves the existing same-Room view", async () => {
    const partition = new ProtectedUnavailableCrossRoomOrganizerPartition({
      selection: { ...selection, selectedRepresentation: "protected" },
      store: {
        async discover() {
          return {
            status: "available",
            changed: changedCoordinate,
            candidates: [recordCandidate],
            metrics: {
              recordRowsConsidered: 1,
              memoryRowsConsidered: 0,
              rowsSelected: 1,
              unsupportedAuthorityShapes: 0,
              authorityParentsResolved: 0,
              authorityParentsSkipped: 0,
              topologyWork: 1,
            },
          } as const;
        },
      } as never,
    });

    expect(await partition.augment({
      claim,
      changed: record("record:changed", 0),
      binding,
      queryEmbedding: embedding,
      sameRoomCandidates: [],
      sameRoomParents: [],
      sameRoomPlanInputs: [],
      authorityParentSeeds: [],
    })).toEqual({
      status: "empty",
      unsupportedAuthorityShapes: 0,
      authorityParentsResolved: 0,
      authorityParentsSkipped: 0,
      protectedExecutionUnavailable: 1,
    });
  });

  test("excluded protected discovery cannot reject a reprojected same-Room head", async () => {
    const partition = new ProtectedUnavailableCrossRoomOrganizerPartition({
      selection: { ...selection, selectedRepresentation: "protected" },
      store: {
        async discover() {
          return { status: "unavailable", reason: "changed_input_stale" } as const;
        },
      } as never,
    });
    expect(await partition.augment({
      claim,
      changed: record("record:changed", 0),
      binding,
      queryEmbedding: embedding,
      sameRoomCandidates: [],
      sameRoomParents: [],
      sameRoomPlanInputs: [],
      authorityParentSeeds: [],
    })).toEqual({
      status: "empty",
      unsupportedAuthorityShapes: 0,
      authorityParentsResolved: 0,
      authorityParentsSkipped: 0,
      protectedExecutionUnavailable: 1,
    });
  });

  test("rejects tampered portable application plans without a process cache", () => {
    const codec = createCrossRoomApplicationPlanCodec(new Uint8Array(32).fill(9));
    const token = codec.seal({
      workRef: "record:changed",
      workGeneration: 1,
      policyVersion: "candidate-policy-v1",
      inputs: [{
        kind: "record",
        role: "changed",
        recordRef: "record:changed",
        processingGeneration: 1,
        representationGeneration: 1,
        authorityGeneration: 1,
        read: { namespaceRef: "namespace:one", bindingRef: "binding:one" },
      }],
      commitments: {
        authority: "authority:one",
        search: "search:one",
        representation: "representation:one",
      },
      budget: {
        maxInputItems: 1,
        maxInputBytes: 1024,
        maxModelCalls: 2,
        maxOutputItems: 1,
        maxOutputBytes: 1024,
      },
      idempotencyKey: "idempotency:one",
    });
    const tail = token.at(-1)!;
    const tampered = `${token.slice(0, -1)}${tail === "A" ? "B" : "A"}` as typeof token;
    expect(() => codec.open(tampered)).toThrow("application plan is invalid");
  });
});
