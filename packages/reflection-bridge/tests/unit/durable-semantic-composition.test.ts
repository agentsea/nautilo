import { describe, expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import { SameRoomDurableSemanticComposition } from
  "../../src/server/durable-semantic-composition";
import { crossRoomApplicationPlanToken } from "../../src/server/cross-room-execution";

function record(
  recordRef: string,
  statement: string,
  roomAnchorRef = "room:one",
): DurableRecordEnvelope {
  return {
    recordRef,
    semantic: {
      observedContentFingerprint: `sha256:${recordRef}`,
      posture: "derived",
      statement,
      sourceDependencies: [],
      anchors: [{ anchorRef: roomAnchorRef, kind: "room", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "stenographer", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["namespace:one"],
    },
    lifecycle: "current",
    structuralHeight: 0,
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

const QUERY_EMBEDDING: RecordEmbeddingV1 = {
  provenance: {
    provider: "openai",
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.25))),
};

const authoredDependency = {
  sourceKind: "memory",
  logicalSourceRef: "memory:one",
  observedRevision: "1",
  observedContentFingerprint: "sha256:memory:one",
  terminalAuthorityLeafHandle: "namespace:legacy",
  authorityBearing: true,
} as const;

function coordinate(recordRef: string, score: number, structuralHeight = 0): RankedRecordCoordinate {
  return {
    recordRef,
    score,
    structuralHeight,
    recordProcessingGeneration: 1,
    projectionGeneration: 1,
    payloadRepresentationGeneration: 1,
    authorityProjectionGeneration: 1,
  };
}

describe("same-Room durable semantic composition", () => {
  test("plans partial dependency loss even when the historical parent has one authority leaf", async () => {
    const predecessor = {
      ...record("record:changed", "Old cross-Room parent."),
      structuralHeight: 1,
      semantic: {
        ...record("record:changed", "Old cross-Room parent.").semantic,
        childRecordRefs: ["record:a", "record:b"],
        // Historical Records may have one synthetic authority leaf even when
        // their surviving children require different exact read bindings.
        terminalAuthorityLeafHandles: ["namespace:legacy"],
      },
    };
    const planned = crossRoomApplicationPlanToken("dependency-loss:plan");
    let planCalls = 0;
    let appliedPlan: unknown;
    let publicationOpen = false;
    let publications = 0;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        read: () => Promise.resolve({ status: "available", record: predecessor }),
      } as never,
      readiness: {} as never,
      bindings: {
        resolveWork: () => Promise.resolve({
          readBindingRef: "read:parent",
          invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
        }),
        resolve: () => Promise.resolve({
          status: "available",
          binding: {
            roomAnchorRef: "room:access:ab",
            invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
            readBindingRef: "read:parent",
            searchBindingRef: "search:parent",
            publicationBindingRef: "publish:parent",
          },
        }),
      },
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      dependencyLoss: {
        resolve: (input) => {
          expect(input.claim).toMatchObject({ leaseToken: "lease:one", changeReason: "dependency_lost" });
          expect(input.assertCurrent).toBeDefined();
          return Promise.resolve({
          status: "partial_loss",
          replacementStatement: "Only B remains supported.",
          modelCalls: 1,
          remainingChildRecordRefs: ["record:b"],
          remainingSourceDependencies: [],
        }); },
      },
      crossRoom: {
        augment: () => Promise.reject(new Error("not reached")),
        planPublication: () => Promise.reject(new Error("not reached")),
        planDependencyLoss(input) {
          planCalls += 1;
          expect(input.predecessor).toBe(predecessor);
          expect(input.proposal).toMatchObject({
            operation: "supersede_parent",
            childRecordRefs: ["record:b"],
          });
          return Promise.resolve({
            status: "planned",
            plan: { applicationPlanToken: planned } as never,
          });
        },
      },
      proposals: {
        apply(input) {
          expect(publicationOpen).toBe(true);
          publications++;
          appliedPlan = input.publicationPlan;
          return Promise.resolve({
            status: "applied",
            operation: "supersede_parent",
            replayed: false,
            usage: {
              modelCalls: 0,
              visitedRecords: 2,
              createdRecords: 1,
              traversalWork: 2,
            },
            changedRecord: {
              logicalObjectRef: "record:replacement",
              generation: 1,
              recordRef: "record:replacement",
            },
          });
        },
      },
    });

    const result = await composition.resolveDependencyLoss({
      publication: {
        async assertCurrent() {},
        async publish(publish) { publicationOpen = true; try { return await publish(); } finally { publicationOpen = false; } },
      },
      claim: {
        ...claim,
        changeReason: "dependency_lost",
      },
      idempotencyKey: "sleep-dependency-loss:record:changed:1",
      budget: {
        maxModelCalls: 2,
        maxVisitedRecords: 16,
        maxCreatedRecords: 1,
        maxTraversalWork: 32,
        maxStatementCharacters: 800,
      },
    });
    expect(result).toMatchObject({ status: "applied", outcome: "partial_replacement" });
    expect(planCalls).toBe(1);
    expect(publications).toBe(1);
    expect(publicationOpen).toBe(false);
    expect(appliedPlan).toMatchObject({ applicationPlanToken: planned });
  });

  test("preserves same-Room authored-source dependency repair without a cross-Room plan", async () => {
    const predecessor = {
      ...record("record:changed", "A parent with authored support."),
      structuralHeight: 1,
      semantic: {
        ...record("record:changed", "A parent with authored support.").semantic,
        childRecordRefs: ["record:a"],
        sourceDependencies: [authoredDependency],
      },
    };
    let appliedPlan: unknown = "not-called";
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        read: () => Promise.resolve({ status: "available", record: predecessor }),
      } as never,
      readiness: {} as never,
      bindings: {
        resolveWork: () => Promise.resolve({
          readBindingRef: "read:parent",
          invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
        }),
        resolve: () => Promise.resolve({
          status: "available",
          binding: {
            roomAnchorRef: "room:one",
            invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
            readBindingRef: "read:parent",
            searchBindingRef: "search:parent",
            publicationBindingRef: "publish:parent",
          },
        }),
      },
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      dependencyLoss: {
        resolve: () => Promise.resolve({
          status: "partial_loss",
          replacementStatement: "The remaining support is current.",
          modelCalls: 1,
          remainingChildRecordRefs: ["record:a"],
          remainingSourceDependencies: [authoredDependency],
        }),
      },
      crossRoom: {
        augment: () => Promise.reject(new Error("not reached")),
        planPublication: () => Promise.reject(new Error("not reached")),
        planDependencyLoss: () => Promise.reject(new Error("same-Room source repair replanned")),
      },
      proposals: {
        apply(input) {
          appliedPlan = input.publicationPlan;
          expect(input.proposal).toMatchObject({
            operation: "supersede_parent",
            sourceDependencies: [authoredDependency],
          });
          return Promise.resolve({
            status: "applied",
            operation: "supersede_parent",
            replayed: false,
            usage: {
              modelCalls: 0,
              visitedRecords: 2,
              createdRecords: 1,
              traversalWork: 2,
            },
            changedRecord: {
              logicalObjectRef: "record:replacement",
              generation: 1,
              recordRef: "record:replacement",
            },
          });
        },
      },
    });

    const result = await composition.resolveDependencyLoss({
      claim: { ...claim, changeReason: "dependency_lost" },
      idempotencyKey: "sleep-dependency-loss:record:changed:source",
      budget: {
        maxModelCalls: 2,
        maxVisitedRecords: 16,
        maxCreatedRecords: 1,
        maxTraversalWork: 32,
        maxStatementCharacters: 800,
      },
    });

    expect(result).toMatchObject({ status: "applied", outcome: "partial_replacement" });
    expect(appliedPlan).toBeUndefined();
  });

  test.each([
    "unsupported_authority_shape",
    "no_effective_audience",
  ] as const)("terminalizes dependency repair authority outcome %s", async (reason) => {
    const predecessor = {
      ...record("record:changed", "A parent with no publishable replacement."),
      structuralHeight: 1,
      semantic: {
        ...record("record:changed", "A parent with no publishable replacement.").semantic,
        childRecordRefs: ["record:a", "record:b"],
      },
    };
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        read: () => Promise.resolve({ status: "available", record: predecessor }),
      } as never,
      readiness: {} as never,
      bindings: {
        resolveWork: () => Promise.resolve({
          readBindingRef: "read:parent",
          invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
        }),
        resolve: () => Promise.resolve({
          status: "available",
          binding: {
            roomAnchorRef: "room:one",
            invocationAudience: { humanRefs: ["human:a"], includesPublicBoundary: false },
            readBindingRef: "read:parent",
            searchBindingRef: "search:parent",
            publicationBindingRef: "publish:parent",
          },
        }),
      },
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      dependencyLoss: {
        resolve: () => Promise.resolve({
          status: "partial_loss",
          replacementStatement: "Only B remains supported.",
          modelCalls: 1,
          remainingChildRecordRefs: ["record:b"],
          remainingSourceDependencies: [],
        }),
      },
      crossRoom: {
        augment: () => Promise.reject(new Error("not reached")),
        planPublication: () => Promise.reject(new Error("not reached")),
        planDependencyLoss: () => Promise.resolve({ status: "no_change", reason }),
      },
      proposals: {
        apply: () => Promise.reject(new Error("terminal authority outcome published")),
      },
    });

    const result = await composition.resolveDependencyLoss({
      claim: { ...claim, changeReason: "dependency_lost" },
      idempotencyKey: `sleep-dependency-loss:record:changed:${reason}`,
      budget: {
        maxModelCalls: 2,
        maxVisitedRecords: 16,
        maxCreatedRecords: 1,
        maxTraversalWork: 32,
        maxStatementCharacters: 800,
      },
    });
    expect(result).toEqual({ status: "not_applicable" });
  });

  test("terminalizes obsolete derived work without candidate or model work", async () => {
    const obsolete = {
      ...record("record:changed", "An already superseded parent."),
      lifecycle: "superseded" as const,
    };
    let bindingResolutions = 0;
    let discoveries = 0;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        async read() {
          return { status: "available", record: obsolete } as const;
        },
      } as never,
      readiness: {} as never,
      bindings: {
        async resolveWork() {
          return {
            readBindingRef: "read:one",
            invocationAudience: {
              humanRefs: ["human:one"],
              includesPublicBoundary: false,
            },
          } as const;
        },
        async resolve() {
          bindingResolutions += 1;
          throw new Error("obsolete work must not resolve semantic authority");
        },
      },
      organizerNeighbors: {
        async discover() {
          discoveries += 1;
          throw new Error("obsolete work must not discover candidates");
        },
      } as never,
      memories: {} as never,
      model: {} as never,
      proposals: {} as never,
      dependencyLoss: {} as never,
    });

    expect(await composition.loadOrganizerView(claim)).toEqual({
      status: "no_change",
      reason: "record_lifecycle_obsolete",
    });
    expect(bindingResolutions).toBe(0);
    expect(discoveries).toBe(0);
  });

  test("terminalizes a changed Record already covered by a current parent", async () => {
    let memorySearches = 0;
    let modelCalls = 0;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        async read() {
          return {
            status: "available",
            record: record("record:changed", "Already represented by P1."),
          } as const;
        },
      } as never,
      readiness: {} as never,
      bindings: {
        async resolveWork() {
          return {
            readBindingRef: "read:one",
            invocationAudience: { humanRefs: ["human:one"], includesPublicBoundary: false },
          } as const;
        },
        async resolve() {
          return {
            status: "available",
            binding: {
              roomAnchorRef: "room:one",
              invocationAudience: {
                humanRefs: ["human:one"],
                includesPublicBoundary: false,
              },
              readBindingRef: "read:one",
              searchBindingRef: "search:one",
              publicationBindingRef: "publish:one",
            },
          } as const;
        },
      },
      organizerNeighbors: {
        async discover() {
          return {
            status: "available",
            discovery: {
              queryEmbedding: QUERY_EMBEDDING,
              candidateCoordinates: [],
              parentTargetCoordinates: [],
              changedAlreadyParented: true,
              metrics: { rowsConsidered: 0, rowsSelected: 0, topologyWork: 1 },
            },
          } as const;
        },
      } as never,
      memories: {
        async search() {
          memorySearches += 1;
          return { status: "available", candidates: [] } as const;
        },
      },
      model: {
        async invoke() {
          modelCalls += 1;
          return '{"operation":"no_change"}';
        },
        async invokeBatch() {
          modelCalls += 1;
          return '{"answers":[]}';
        },
      },
      proposals: {} as never,
      dependencyLoss: {} as never,
    });

    expect(await composition.loadOrganizerView(claim)).toEqual({
      status: "no_change",
      reason: "already_covered",
    });
    expect(memorySearches).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("combines eligible Record and authored Memory neighbors without cloning Memory", async () => {
    const records = new Map([
      ["record:changed", record("record:changed", "We selected Postgres.")],
      ["record:argument", record("record:argument", "Postgres supports our queries.")],
      ["record:wrong-room", record("record:wrong-room", "Hidden neighbor.", "room:two")],
    ]);
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        async read(input: { recordRef: string }) {
          const value = records.get(input.recordRef);
          return value === undefined
            ? { status: "unavailable", recordRef: input.recordRef, reason: "not_found" }
            : { status: "available", record: value };
        },
        async readParents() {
          return { status: "available", page: { items: [] } };
        },
      } as never,
      readiness: {} as never,
      bindings: {
        async resolve() {
          return {
            status: "available",
            binding: {
              roomAnchorRef: "room:one",
              invocationAudience: {
                humanRefs: ["human:one"],
                includesPublicBoundary: false,
              },
              readBindingRef: "read:one",
              searchBindingRef: "search:one",
              publicationBindingRef: "publish:one",
            },
          };
        },
        async resolveWork() {
          return {
            readBindingRef: "read:one",
            invocationAudience: {
              humanRefs: ["human:one"],
              includesPublicBoundary: false,
            },
          };
        },
      },
      organizerNeighbors: {
        async discover() {
          return {
            status: "available",
            discovery: {
              queryEmbedding: QUERY_EMBEDDING,
              candidateCoordinates: [coordinate("record:argument", 0.9)],
              authorityParentCandidateCoordinates: [
                coordinate("record:external-parent-seed", 0.89),
              ],
              parentTargetCoordinates: [],
              authorityParentTargetCoordinates: [],
              changedAlreadyParented: false,
              metrics: { rowsConsidered: 2, rowsSelected: 1, topologyWork: 1 },
            },
          } as const;
        },
        async openSelected(input) {
          expect(input.coordinates.map((entry) => entry.recordRef)).not.toContain(
            "record:external-parent-seed",
          );
          return {
            status: "available",
            records: input.coordinates.map((value) => ({
              coordinate: value,
              snapshot: {
                recordRef: value.recordRef,
                observedContentFingerprint: `sha256:${value.recordRef}`,
                posture: "derived" as const,
                anchors: ["room:one"],
                statement: "Postgres supports our queries.",
                sourceRefs: [],
                childRecordRefs: [],
                structuralHeight: value.structuralHeight,
                lifecycle: "current" as const,
              },
            })),
          } as const;
        },
      },
      memories: {
        async search(input) {
          expect(input.embedding).toBe(QUERY_EMBEDDING);
          return {
            status: "available",
            candidates: [{
              score: 0.8,
              snapshot: {
                recordRef: "memory:authored",
                observedContentFingerprint: "sha256:memory",
                posture: "authored",
                anchors: ["room:one"],
                statement: "Casey preferred managed Postgres.",
                sourceRefs: ["memory:authored"],
                childRecordRefs: [],
                structuralHeight: 0,
                lifecycle: "current",
              },
              dependency: {
                sourceKind: "memory",
                logicalSourceRef: "memory:authored",
                observedRevision: "4",
                observedContentFingerprint: "sha256:memory",
                terminalAuthorityLeafHandle: "namespace:one",
                authorityBearing: true,
              },
            }],
          };
        },
      },
      model: {} as never,
      proposals: {} as never,
      dependencyLoss: {} as never,
      crossRoom: {
        async augment(input) {
          expect(input.queryEmbedding).toBe(QUERY_EMBEDDING);
          expect(input.sameRoomCandidates).toHaveLength(2);
          expect(input.authorityParentSeeds).toEqual([{
            recordRef: "record:external-parent-seed",
            score: 0.89,
          }]);
          return {
            status: "available",
            candidates: [
              {
                handle: "duplicate-changed",
                snapshot: {
                  recordRef: "record:changed",
                  observedContentFingerprint: "sha256:changed",
                  posture: "derived",
                  anchors: ["room:one"],
                  statement: "We selected Postgres.",
                  sourceRefs: [],
                  childRecordRefs: [],
                  structuralHeight: 0,
                  lifecycle: "current",
                },
                dependency: { kind: "record", recordRef: "record:changed" },
              },
              {
                handle: "unused-cross-room",
                snapshot: {
                  recordRef: "record:cross-room",
                  observedContentFingerprint: "sha256:cross-room",
                  posture: "derived",
                  anchors: ["room:two"],
                  statement: "A related decision from another Room.",
                  sourceRefs: [],
                  childRecordRefs: [],
                  structuralHeight: 0,
                  lifecycle: "current",
                },
                dependency: { kind: "record", recordRef: "record:cross-room" },
              },
            ],
            existingParents: [],
            applicationPlanToken: crossRoomApplicationPlanToken("plan:mixed-room"),
            unsupportedAuthorityShapes: 0,
            authorityParentsResolved: 1,
            authorityParentsSkipped: 0,
            protectedExecutionUnavailable: 0,
          } as const;
        },
        async planPublication() {
          throw new Error("view construction must not plan publication");
        },
      },
    });

    const result = await composition.loadOrganizerView(claim);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.view.changed.dependency).toEqual({
      kind: "record",
      recordRef: "record:changed",
    });
    expect(result.view.candidates).toHaveLength(3);
    expect(result.view.candidates.map((candidate) => candidate.dependency?.kind))
      .toEqual(["record", "source", "record"]);
    expect(result.view.candidates.map((candidate) => candidate.handle))
      .toEqual(["C1", "C2", "C3"]);
    expect(result.view.maxSelectedChildren).toBe(6);
    expect(result.view.applicationPlanToken).toBe("plan:mixed-room");
    expect(result.view.candidates.some((candidate) =>
      candidate.snapshot.recordRef === "record:wrong-room"
    )).toBe(false);
  });

  test("plans the exact cross-Room output after the model selects dependencies", async () => {
    const token = crossRoomApplicationPlanToken("plan:publication");
    const publicationPlan = {
      applicationPlanToken: token,
      policyVersion: "candidate-policy-v1",
      selectedInputs: [],
      output: {
        accessRoomRef: "room:access",
        accessNamespaceRef: "namespace:access",
        publicationBindingRef: "publish:access",
        authorityGeneration: 1,
        includesPublicBoundary: false,
      },
      commitments: { authority: "authority", representation: "representation" },
      budget: {
        maxInputItems: 1,
        maxInputBytes: 1,
        maxModelCalls: 2,
        maxOutputItems: 1,
        maxOutputBytes: 1,
      },
      idempotencyKey: "publication:one",
    } as never;
    let applied: unknown;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {} as never,
      readiness: {} as never,
      bindings: {} as never,
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      proposals: {
        async apply(input) {
          applied = input;
          return {
            status: "applied",
            operation: "create_parent",
            replayed: false,
            usage: {
              modelCalls: 0,
              visitedRecords: 0,
              createdRecords: 0,
              traversalWork: 0,
            },
          } as const;
        },
      },
      dependencyLoss: {} as never,
      crossRoom: {
        async augment() {
          throw new Error("publication must not rebuild the Organizer view");
        },
        async planPublication(input) {
          expect(input.applicationPlanToken).toBe(token);
          expect(input.proposal.operation).toBe("create_parent");
          return { status: "planned", plan: publicationPlan } as const;
        },
      },
    });

    await composition.applyProposal({
      claim,
      proposal: {
        operation: "create_parent",
        statement: "A cross-Room synthesis.",
        childRecordRefs: ["record:one", "record:two"],
        sourceDependencies: [],
      },
      applicationPlanToken: token,
      idempotencyKey: "sleep:one",
      budget: {
        maxModelCalls: 1,
        maxVisitedRecords: 8,
        maxCreatedRecords: 1,
        maxTraversalWork: 8,
        maxStatementCharacters: 800,
      },
    });

    expect(applied).toMatchObject({ publicationPlan });
  });

  test("preserves typed cross-Room publication failures without product publication", async () => {
    const token = crossRoomApplicationPlanToken("plan:stale-publication");
    let publications = 0;
    let planningFailure: "stale" | "unavailable" = "stale";
    const composition = new SameRoomDurableSemanticComposition({
      repository: {} as never,
      readiness: {} as never,
      bindings: {} as never,
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      proposals: {
        async apply() {
          publications += 1;
          throw new Error("stale plan must not publish");
        },
      },
      dependencyLoss: {} as never,
      crossRoom: {
        async augment() {
          throw new Error("publication must not rebuild the Organizer view");
        },
        async planPublication() {
          return planningFailure === "stale"
            ? {
                status: "stale" as const,
                failureDetail: "publication_plan_stale" as const,
              }
            : {
                status: "unavailable" as const,
                failureDetail: "publication_memory_fence_unavailable" as const,
              };
        },
      },
    });

    expect(await composition.applyProposal({
      claim,
      proposal: {
        operation: "create_parent",
        statement: "A now-stale cross-Room synthesis.",
        childRecordRefs: ["record:one", "record:two"],
        sourceDependencies: [],
      },
      applicationPlanToken: token,
      idempotencyKey: "sleep:stale-publication",
      budget: {
        maxModelCalls: 1,
        maxVisitedRecords: 8,
        maxCreatedRecords: 1,
        maxTraversalWork: 8,
        maxStatementCharacters: 800,
      },
    })).toEqual({
      status: "stale",
      failureDetail: "publication_plan_stale",
    });
    planningFailure = "unavailable";
    expect(await composition.applyProposal({
      claim,
      proposal: {
        operation: "create_parent",
        statement: "A temporarily unavailable cross-Room synthesis.",
        childRecordRefs: ["record:one", "record:two"],
        sourceDependencies: [],
      },
      applicationPlanToken: token,
      idempotencyKey: "sleep:unavailable-publication",
      budget: {
        maxModelCalls: 1,
        maxVisitedRecords: 8,
        maxCreatedRecords: 1,
        maxTraversalWork: 8,
        maxStatementCharacters: 800,
      },
    })).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_memory_fence_unavailable",
    });
    expect(publications).toBe(0);
  });

  test("completes a cross-Room model no-op without entering publication", async () => {
    const token = crossRoomApplicationPlanToken("plan:no-change");
    let publicationPlans = 0;
    let publications = 0;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {} as never,
      readiness: {} as never,
      bindings: {} as never,
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      proposals: {
        async apply() {
          publications += 1;
          throw new Error("a semantic no-op must not enter product publication");
        },
      },
      dependencyLoss: {} as never,
      crossRoom: {
        async augment() {
          throw new Error("publication must not rebuild the Organizer view");
        },
        async planPublication() {
          publicationPlans += 1;
          return {
            status: "unavailable",
            failureDetail: "publication_plan_invalid",
          } as const;
        },
      },
      now: () => 0,
    });

    expect(await composition.applyProposal({
      claim,
      proposal: { operation: "no_change" },
      applicationPlanToken: token,
      idempotencyKey: "sleep:no-change",
      budget: {
        maxModelCalls: 1,
        maxVisitedRecords: 8,
        maxCreatedRecords: 1,
        maxTraversalWork: 8,
        maxStatementCharacters: 800,
      },
    })).toEqual({
      status: "applied",
      operation: "no_change",
      replayed: false,
      usage: {
        modelCalls: 0,
        visitedRecords: 0,
        createdRecords: 0,
        traversalWork: 0,
      },
      timing: {
        publicationPlanningElapsedMs: 0,
        finalAuthorityElapsedMs: 0,
        productPublicationElapsedMs: 0,
        recursiveAdmissionElapsedMs: 0,
      },
    });
    expect(publicationPlans).toBe(1);
    expect(publications).toBe(0);
  });

  test.each(["no_change", "dissolve_parent"] as const)(
    "passes a fixed exposure plan through %s application",
    async operation => {
      const token = crossRoomApplicationPlanToken(`plan:fixed-${operation}`);
      const publicationPlan = {
        applicationPlanToken: token,
        policyVersion: "candidate-policy-v1",
        selectedInputs: [],
        modelExposureDependencies: [],
        output: {
          accessRoomRef: "room:access",
          accessNamespaceRef: "namespace:access",
          publicationBindingRef: "publish:access",
          authorityGeneration: 1,
          includesPublicBoundary: false,
        },
        commitments: { authority: "authority", representation: "representation" },
        budget: {
          maxInputItems: 1,
          maxInputBytes: 1,
          maxModelCalls: 2,
          maxOutputItems: 1,
          maxOutputBytes: 1,
        },
        idempotencyKey: `publication:${operation}`,
      } as never;
      let applied: unknown;
      const composition = new SameRoomDurableSemanticComposition({
        repository: {} as never,
        readiness: {} as never,
        bindings: {} as never,
        organizerNeighbors: {} as never,
        memories: {} as never,
        model: {} as never,
        proposals: {
          async apply(input) {
            applied = input;
            return {
              status: "applied",
              operation,
              replayed: false,
              usage: {
                modelCalls: 0,
                visitedRecords: 0,
                createdRecords: 0,
                traversalWork: 0,
              },
            } as never;
          },
        },
        dependencyLoss: {} as never,
        crossRoom: {
          async augment() {
            throw new Error("application must not rebuild the Organizer view");
          },
          async planPublication() {
            return { status: "planned", plan: publicationPlan } as const;
          },
        },
      });
      const proposal = operation === "no_change"
        ? { operation }
        : { operation, parentRecordRef: "record:parent" };

      expect(await composition.applyProposal({
        claim,
        proposal,
        applicationPlanToken: token,
        idempotencyKey: `sleep:${operation}`,
        budget: {
          maxModelCalls: 1,
          maxVisitedRecords: 8,
          maxCreatedRecords: 1,
          maxTraversalWork: 8,
          maxStatementCharacters: 800,
        },
      })).toMatchObject({ status: "applied", operation });
      expect(applied).toMatchObject({ publicationPlan });
    },
  );

  test("contracts an unsupported post-model authority result without publication", async () => {
    const token = crossRoomApplicationPlanToken("plan:unsupported");
    let publications = 0;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {} as never,
      readiness: {} as never,
      bindings: {} as never,
      organizerNeighbors: {} as never,
      memories: {} as never,
      model: {} as never,
      proposals: {
        async apply() {
          publications += 1;
          throw new Error("unsupported authority must not publish");
        },
      },
      dependencyLoss: {} as never,
      crossRoom: {
        async augment() {
          throw new Error("publication must not rebuild the Organizer view");
        },
        async planPublication() {
          return {
            status: "no_change",
            reason: "unsupported_authority_shape",
          } as const;
        },
      },
    });

    const result = await composition.applyProposal({
      claim,
      proposal: {
        operation: "create_parent",
        statement: "A cross-Room synthesis.",
        childRecordRefs: ["record:one", "record:two"],
        sourceDependencies: [],
      },
      applicationPlanToken: token,
      idempotencyKey: "sleep:unsupported",
      budget: {
        maxModelCalls: 1,
        maxVisitedRecords: 8,
        maxCreatedRecords: 1,
        maxTraversalWork: 8,
        maxStatementCharacters: 800,
      },
    });

    expect(result).toMatchObject({
      status: "applied",
      operation: "no_change",
      terminalOutcome: "unsupported_authority_shape",
    });
    expect(publications).toBe(0);
  });

  test("scheduled promotion reviews use only current parent-head candidates", async () => {
    const records = new Map([
      ["record:changed", record("record:changed", "A stable parent")],
      ["record:parent", record("record:parent", "Another stable parent")],
    ]);
    let memorySearches = 0;
    let observedIntent: string | undefined;
    const composition = new SameRoomDurableSemanticComposition({
      repository: {
        async read(input: { recordRef: string }) {
          const value = records.get(input.recordRef);
          return value === undefined
            ? { status: "unavailable", recordRef: input.recordRef, reason: "not_found" }
            : { status: "available", record: value };
        },
      } as never,
      readiness: {} as never,
      bindings: {
        async resolve() {
          return {
            status: "available",
            binding: {
              roomAnchorRef: "room:one",
              invocationAudience: {
                humanRefs: ["human:one"],
                includesPublicBoundary: false,
              },
              readBindingRef: "read:one",
              searchBindingRef: "search:one",
              publicationBindingRef: "publish:one",
            },
          } as const;
        },
        async resolveWork() {
          return {
            readBindingRef: "read:one",
            invocationAudience: {
              humanRefs: ["human:one"],
              includesPublicBoundary: false,
            },
          } as const;
        },
      },
      organizerNeighbors: {
        async discover(input) {
          observedIntent = input.intent;
          return {
            status: "available",
            discovery: {
              queryEmbedding: QUERY_EMBEDDING,
              candidateCoordinates: [coordinate("record:parent", 0.9, 1)],
              authorityParentCandidateCoordinates: [],
              parentTargetCoordinates: [],
              authorityParentTargetCoordinates: [],
              changedAlreadyParented: false,
              metrics: { rowsConsidered: 1, rowsSelected: 1, topologyWork: 1 },
            },
          } as const;
        },
        async openSelected(input) {
          return {
            status: "available",
            records: input.coordinates.map((value) => ({
              coordinate: value,
              snapshot: {
                recordRef: value.recordRef,
                observedContentFingerprint: `sha256:${value.recordRef}`,
                posture: "derived" as const,
                anchors: ["room:one"],
                statement: "Another stable parent",
                sourceRefs: [],
                childRecordRefs: ["record:leaf-a", "record:leaf-b"],
                structuralHeight: 1,
                lifecycle: "current" as const,
              },
            })),
          } as const;
        },
      },
      memories: {
        async search() {
          memorySearches += 1;
          return { status: "available", candidates: [] } as const;
        },
      },
      model: {} as never,
      proposals: {} as never,
      dependencyLoss: {} as never,
    });

    const result = await composition.loadOrganizerView({
      ...claim,
      changeReason: "scheduled_review",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(observedIntent).toBe("promotion");
    expect(memorySearches).toBe(0);
    expect(result.view.candidates.map((candidate) => candidate.snapshot.recordRef))
      .toEqual(["record:parent"]);
  });
});
