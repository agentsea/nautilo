import { describe, expect, test } from "bun:test";

import {
  ExactGroundedDependencyLossResolver,
  resolveCurrentDependencyInputRef,
} from "../../src/server";

const dependency = {
  sourceKind: "memory",
  logicalSourceRef: "memory:one",
  observedRevision: "1",
  observedContentFingerprint: "sha256:old",
  terminalAuthorityLeafHandle: "namespace:one",
  authorityBearing: true,
} as const;

const input = {
  claim: { logicalObjectRef: "record:parent", generation: 1, recordRef: "record:parent",
    changeReason: "dependency_lost", stage: "organization", leaseToken: "lease:parent" },
  record: {
    recordRef: "record:parent",
    semantic: {
      observedContentFingerprint: "sha256:parent",
      posture: "derived",
      statement: "Postgres won because of durable queries and managed hosting.",
      sourceDependencies: [dependency],
      anchors: [{ anchorRef: "room:one", kind: "room", role: "origin" }],
      childRecordRefs: ["record:remaining"],
      producer: { producerRef: "organizer", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["namespace:one"],
    },
    lifecycle: "current",
    structuralHeight: 1,
    processingGeneration: 1,
  },
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
  maxVisitedRecords: 100,
} as const;

describe("exact grounded dependency loss", () => {
  test("withholds a changed source and rewrites only from remaining support", async () => {
    let rewriteInput: unknown;
    const invalidations: unknown[] = [];
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "eligible" }; } } as never,
      repository: {
        async read() {
          return {
            status: "available",
            record: {
              ...input.record,
              recordRef: "record:remaining",
              semantic: {
                ...input.record.semantic,
                statement: "Postgres supports the required durable queries.",
                sourceDependencies: [],
                childRecordRefs: [],
              },
              structuralHeight: 0,
            },
          };
        },
      } as never,
      source: { async readExact() { return { status: "changed" }; } },
      invalidation: { async admit(value) { invalidations.push(value); } },
      statements: {
        async rewrite(value) {
          rewriteInput = value;
          return {
            status: "available",
            statement: "Postgres remains supported by the required durable queries.",
            modelCalls: 1,
          };
        },
      },
    });

    expect(await resolver.resolve(input)).toEqual({
      status: "partial_loss",
      replacementStatement:
        "Postgres remains supported by the required durable queries.",
      modelCalls: 1,
      remainingChildRecordRefs: ["record:remaining"],
      remainingSourceDependencies: [],
      remainingModelExposureDependencies: [{
        kind: "record",
        recordRef: "record:remaining",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:one"],
      }],
    });
    expect(rewriteInput).toMatchObject({
      remainingSupportStatements: [
        "Postgres supports the required durable queries.",
      ],
    });
    expect(invalidations).toEqual([{ dependency, reason: "changed" }]);
  });

  test("waits when a source cannot be read exactly", async () => {
    let rewrites = 0;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "unavailable" }; } } as never,
      repository: {} as never,
      source: { async readExact() { return { status: "unavailable" }; } },
      invalidation: { async admit() {} },
      statements: {
        async rewrite() {
          rewrites += 1;
          return { status: "unavailable" };
        },
      },
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          childRecordRefs: [],
        },
      },
    })).toEqual({ status: "unavailable" });
    expect(rewrites).toBe(0);
  });

  test("sunsets when the only source is proven changed", async () => {
    let rewrites = 0;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {} as never,
      repository: {} as never,
      source: { async readExact() { return { status: "changed" }; } },
      invalidation: { async admit() {} },
      statements: {
        async rewrite() {
          rewrites += 1;
          return { status: "unavailable" };
        },
      },
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: { ...input.record.semantic, childRecordRefs: [] },
      },
    })).toEqual({ status: "total_loss" });
    expect(rewrites).toBe(0);
  });

  test("replaces terminal child support through a unique obsolete successor chain", async () => {
    let rewriteInput: unknown;
    const reads: unknown[] = [];
    const successorReads: unknown[] = [];
    const stateSuccessorReads: unknown[] = [];
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {
        async check({ recordRef }: { recordRef: string }) {
          return recordRef === "record:remaining-v3"
            ? { status: "eligible" }
            : { status: "unavailable" };
        },
      } as never,
      recordBindings: {
        async read(recordRef) {
          const bindingRef = `binding:${recordRef}`;
          return {
            originPublicationBindingRef: bindingRef,
            currentAccessBindingRefs: [bindingRef],
            representationGeneration: 1,
            authorityProjectionGeneration: 1,
          };
        },
      },
      recordState: {
        async readState(recordRef) {
          return {
            status: "available",
            lifecycle: recordRef === "record:remaining"
              ? "stale"
              : recordRef === "record:remaining-v2"
                ? "superseded"
                : "current",
            processingGeneration: 1,
            disposition: "available",
          };
        },
        async readSuccessors(value) {
          stateSuccessorReads.push(value);
          return {
            status: "available",
            successorRecordRefs: [value.recordRef === "record:remaining"
              ? "record:remaining-v2"
              : "record:remaining-v3"],
            complete: true,
          };
        },
      },
      repository: {
        async read(value: { recordRef: string; readBindingRef: string }) {
          reads.push(value);
          return {
            status: "available",
            record: {
              ...input.record,
              recordRef: value.recordRef,
              lifecycle: value.recordRef === "record:remaining" ? "stale" : "current",
              structuralHeight: 0,
              semantic: {
                ...input.record.semantic,
                statement: "Postgres now uses the replacement durable design.",
                sourceDependencies: [],
                childRecordRefs: [],
              },
            },
          };
        },
        async readSuccessors(value: unknown) {
          successorReads.push(value);
          return {
            status: "available",
            page: {
              items: [{
                predecessorRecordRef: "record:remaining",
                successorRecordRef: "record:remaining-v2",
                relation: "supersedes",
              }],
            },
          };
        },
      } as never,
      source: {
        async readExact() {
          return { status: "available", kind: "memory", content: "memory" };
        },
      },
      invalidation: { async admit() {} },
      statements: {
        async rewrite(value) {
          rewriteInput = value;
          return {
            status: "available",
            statement: "Postgres remains selected under the replacement design.",
            modelCalls: 1,
          };
        },
      },
    });

    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          sourceDependencies: [],
          childRecordRefs: ["record:remaining"],
        },
      },
    })).toEqual({
      status: "partial_loss",
      replacementStatement: "Postgres remains selected under the replacement design.",
      modelCalls: 1,
      remainingChildRecordRefs: ["record:remaining-v3"],
      remainingSourceDependencies: [],
      remainingModelExposureDependencies: [{
        kind: "record",
        recordRef: "record:remaining-v3",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:one"],
      }],
    });
    expect(rewriteInput).toMatchObject({
      remainingSupportStatements: [
        "Postgres now uses the replacement durable design.",
      ],
    });
    expect(reads).toEqual([
      {
        recordRef: "record:remaining-v3",
        readBindingRef: "binding:record:remaining-v3",
      },
    ]);
    expect(successorReads).toEqual([]);
    expect(stateSuccessorReads).toEqual([{
      recordRef: "record:remaining",
      limit: 2,
    }, {
      recordRef: "record:remaining-v2",
      limit: 2,
    }]);
  });

  test("reports a bounded six-Record successor-normalized metadata cycle without opening its payloads", async () => {
    let rewrites = 0;
    let metadataCalls = 0;
    const cycle = Array.from({ length: 6 }, (_, index) => `record:cycle:${index + 1}`);
    const successor = new Map([
      ["record:old-child", cycle[0]!],
    ]);
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "unavailable", reason: "not_eligible" }; } } as never,
      recordBindings: {
        async read(recordRef) {
          return {
            originPublicationBindingRef: `binding:${recordRef}`,
            currentAccessBindingRefs: [`binding:${recordRef}`],
            representationGeneration: 1,
            authorityProjectionGeneration: null,
          };
        },
      },
      recordState: {
        async readState(recordRef) {
          metadataCalls += 1;
          return {
            status: "available",
            lifecycle: successor.has(recordRef) ? "superseded" : "current",
            processingGeneration: 1,
            disposition: "available",
          };
        },
        async readSuccessors({ recordRef }) {
          metadataCalls += 1;
          const next = successor.get(recordRef);
          return {
            status: "available",
            successorRecordRefs: next === undefined ? [] : [next],
            complete: true,
          };
        },
        async readStructuralDependencyRecordRefs({ recordRef, limit }) {
          metadataCalls += 1;
          const index = cycle.indexOf(recordRef);
          const refs = index < 0 ? [] : [cycle[(index + 1) % cycle.length]!];
          return {
            status: "available",
            dependencyRecordRefs: refs.slice(0, limit),
            complete: refs.length <= limit,
          };
        },
      },
      repository: {
        async read({ recordRef }: { recordRef: string }) {
          if (recordRef !== cycle[0]) {
            throw new Error("cycle diagnostic opened a metadata-only payload");
          }
          return {
            status: "available",
            record: { ...input.record, recordRef },
          };
        },
      } as never,
      source: {} as never,
      invalidation: { async admit() {} },
      statements: {
        async rewrite() {
          rewrites += 1;
          return { status: "unavailable" };
        },
      },
    });

    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          sourceDependencies: [],
          childRecordRefs: ["record:old-child"],
        },
      },
    })).toEqual({
      status: "unavailable",
      evidence: { kind: "dependency_cycle" },
    });
    expect(rewrites).toBe(0);
    expect(metadataCalls).toBeLessThanOrEqual(input.maxVisitedRecords);

    metadataCalls = 0;
    expect(await resolver.resolve({
      ...input,
      maxVisitedRecords: 4,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          sourceDependencies: [],
          childRecordRefs: ["record:old-child"],
        },
      },
    })).toEqual({ status: "unavailable" });
    expect(metadataCalls).toBeLessThanOrEqual(8);
    expect(rewrites).toBe(0);
  });

  test("keeps exact historical exposure distinct from structural support and never self-supports", async () => {
    const historicalExposure = {
      kind: "record" as const,
      recordRef: "record:old-exposure",
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["namespace:one"],
    };
    const run = async (
      historicalEligible: boolean,
      includeStructuralSupport = true,
      historicalBindingAvailable = true,
      sourceChanged = true,
    ) => {
      const reads: string[] = [];
      const eligibilityChecks: string[] = [];
      let rewriteInput: unknown;
      const resolver = new ExactGroundedDependencyLossResolver({
        eligibility: {
          async check({ recordRef }: { recordRef: string }) {
            eligibilityChecks.push(recordRef);
            return recordRef !== historicalExposure.recordRef || historicalEligible
              ? { status: "eligible" as const }
              : { status: "unavailable" as const, reason: "not_eligible" as const };
          },
        } as never,
        recordBindings: {
          async read(recordRef) {
            if (
              recordRef === historicalExposure.recordRef
              && !historicalBindingAvailable
            ) return null;
            return {
              originPublicationBindingRef: `binding:${recordRef}`,
              currentAccessBindingRefs: [`binding:${recordRef}`],
              representationGeneration: 1,
              authorityProjectionGeneration: 1,
            };
          },
        },
        recordState: {
          async readState(recordRef) {
            return {
              status: "available" as const,
              lifecycle: recordRef === historicalExposure.recordRef
                ? "superseded" as const
                : "current" as const,
              processingGeneration: recordRef === historicalExposure.recordRef ? 2 : 1,
              disposition: "available" as const,
            };
          },
          async readSuccessors() {
            return { status: "available" as const, successorRecordRefs: [], complete: true };
          },
        },
        repository: {
          async read({ recordRef }: { recordRef: string }) {
            reads.push(recordRef);
            const historical = recordRef === historicalExposure.recordRef;
            return {
              status: "available" as const,
              record: {
                ...input.record,
                recordRef,
                lifecycle: historical ? "superseded" as const : "current" as const,
                processingGeneration: historical ? 2 : 1,
                structuralHeight: 0,
                semantic: {
                  ...input.record.semantic,
                  statement: historical
                    ? "Retired context observed by the original model call."
                    : "Current source-grounded structural leaf.",
                  sourceDependencies: [],
                  childRecordRefs: [],
                  modelExposureDependencies: [],
                },
              },
            };
          },
          async readSuccessors() {
            return {
              status: "available" as const,
              page: {
                items: [{
                  predecessorRecordRef: historicalExposure.recordRef,
                  successorRecordRef: "record:sibling-successor",
                  relation: "supersedes" as const,
                }],
              },
            };
          },
        } as never,
        source: {
          async readExact() {
            return sourceChanged
              ? { status: "changed" as const }
              : {
                  status: "available" as const,
                  kind: "memory" as const,
                  content: "Current exact source.",
                };
          },
        },
        invalidation: { async admit() {} },
        statements: {
          async rewrite(value) {
            rewriteInput = value;
            return {
              status: "available" as const,
              statement: "Reorganized only from authenticated remaining support.",
              modelCalls: 1 as const,
            };
          },
        },
      });
      const decision = await resolver.resolve({
        ...input,
        record: {
          ...input.record,
          recordRef: "record:replacement",
          semantic: {
            ...input.record.semantic,
            childRecordRefs: includeStructuralSupport
              ? ["record:structural-leaf"]
              : [],
            modelExposureDependencies: [historicalExposure],
          },
        },
      });
      return { decision, eligibilityChecks, reads, rewriteInput };
    };

    const verified = await run(true);
    expect(verified.decision).toMatchObject({
      status: "partial_loss",
      remainingChildRecordRefs: ["record:structural-leaf"],
      remainingSourceDependencies: [],
      remainingModelExposureDependencies: [
        expect.objectContaining({ recordRef: "record:structural-leaf" }),
      ],
    });
    if (verified.decision.status !== "partial_loss") {
      throw new Error("expected verified historical rewrite");
    }
    expect(verified.decision.remainingModelExposureDependencies)
      .not.toContainEqual(historicalExposure);
    expect(verified.rewriteInput).toEqual({
      remainingSupportStatements: [
        "Current source-grounded structural leaf.",
      ],
    });
    expect(verified.reads).toEqual([
      "record:structural-leaf",
      historicalExposure.recordRef,
    ]);
    expect(verified.eligibilityChecks).toEqual([
      "record:structural-leaf",
      historicalExposure.recordRef,
    ]);

    const stable = await run(true, true, true, false);
    expect(stable.decision).toEqual({ status: "stable" });
    expect(stable.rewriteInput).toBeUndefined();

    const revoked = await run(false);
    expect(revoked.decision).toMatchObject({
      status: "partial_loss",
      remainingChildRecordRefs: ["record:structural-leaf"],
      remainingModelExposureDependencies: [
        expect.objectContaining({ recordRef: "record:structural-leaf" }),
      ],
    });
    expect(revoked.rewriteInput).toEqual({
      remainingSupportStatements: ["Current source-grounded structural leaf."],
    });
    expect(revoked.reads).not.toContain("record:replacement");
    expect(revoked.eligibilityChecks).not.toContain("record:replacement");

    const missingBinding = await run(true, true, false);
    expect(missingBinding.decision).toMatchObject({
      status: "partial_loss",
      remainingChildRecordRefs: ["record:structural-leaf"],
    });
    expect(missingBinding.rewriteInput).toEqual({
      remainingSupportStatements: ["Current source-grounded structural leaf."],
    });
    expect(missingBinding.reads).toEqual(["record:structural-leaf"]);
    expect(missingBinding.eligibilityChecks).toEqual(["record:structural-leaf"]);

    const ungrounded = await run(true, false, false);
    expect(ungrounded.decision).toEqual({ status: "unavailable" });
    expect(ungrounded.rewriteInput).toBeUndefined();
  });

  test("propagates unexpected authority failures instead of classifying them as evidence", async () => {
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {
        async check() { throw new Error("authority storage failed"); },
      } as never,
      repository: {
        async read() {
          return {
            status: "available",
            record: { ...input.record, recordRef: "record:remaining" },
          };
        },
      } as never,
      source: {} as never,
      invalidation: { async admit() {} },
      statements: {} as never,
    });

    expect(resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: { ...input.record.semantic, sourceDependencies: [] },
      },
    })).rejects.toThrow("authority storage failed");
  });

  test("fails closed on cyclic successor metadata", async () => {
    const result = await resolveCurrentDependencyInputRef({
      recordRef: "record:a",
      maxVisitedRecords: 4,
      recordState: {
        async readState() {
          return {status: "available", lifecycle: "superseded",
            processingGeneration: 1, disposition: "available"};
        },
        async readSuccessors({recordRef}) {
          return {status: "available", complete: true,
            successorRecordRefs: [recordRef === "record:a" ? "record:b" : "record:a"]};
        },
      },
    });
    expect(result).toEqual({status: "unavailable"});
  });

  test("fails closed on ambiguous successor metadata", async () => {
    const result = await resolveCurrentDependencyInputRef({
      recordRef: "record:a",
      maxVisitedRecords: 4,
      recordState: {
        async readState() {
          return {status: "available", lifecycle: "superseded",
            processingGeneration: 1, disposition: "available"};
        },
        async readSuccessors() {
          return {status: "available", complete: true,
            successorRecordRefs: ["record:b", "record:c"]};
        },
      },
    });
    expect(result).toEqual({status: "unavailable"});
  });

  test("bounds successor traversal with the existing hierarchy visit budget", async () => {
    const result = await resolveCurrentDependencyInputRef({
      recordRef: "record:a",
      maxVisitedRecords: 2,
      recordState: {
        async readState(recordRef) {
          return {status: "available", lifecycle: recordRef === "record:c" ? "current" : "superseded",
            processingGeneration: 1, disposition: "available"};
        },
        async readSuccessors({recordRef}) {
          return {status: "available", complete: true,
            successorRecordRefs: [recordRef === "record:a" ? "record:b" : "record:c"]};
        },
      },
    });
    expect(result).toEqual({status: "unavailable"});
  });

  test("treats a terminal obsolete Record without a successor as lost", async () => {
    const result = await resolveCurrentDependencyInputRef({
      recordRef: "record:a",
      maxVisitedRecords: 1,
      recordState: {
        async readState() {
          return {status: "available", lifecycle: "sunset",
            processingGeneration: 1, disposition: "available"};
        },
        async readSuccessors() {
          return {status: "available", complete: true, successorRecordRefs: []};
        },
      },
    });
    expect(result).toEqual({status: "lost"});
  });

  test("removes a changed uncited exposure from the regenerated exact evidence set", async () => {
    let rewriteInput: unknown;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "eligible" }; } } as never,
      repository: {
        async read() {
          return {
            status: "available",
            record: {
              ...input.record,
              recordRef: "record:remaining",
              structuralHeight: 0,
              semantic: {
                ...input.record.semantic,
                statement: "The surviving record statement.",
                sourceDependencies: [],
                childRecordRefs: [],
              },
            },
          };
        },
      } as never,
      source: { async readExact() { return { status: "changed" }; } },
      invalidation: { async admit() {} },
      statements: {
        async rewrite(value) {
          rewriteInput = value;
          return { status: "available", statement: "Surviving support only.", modelCalls: 1 };
        },
      },
    });
    const result = await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          sourceDependencies: [],
          modelExposureDependencies: [{
            kind: "source",
            sourceKind: dependency.sourceKind,
            logicalSourceRef: dependency.logicalSourceRef,
            observedRevision: dependency.observedRevision,
            observedContentFingerprint: dependency.observedContentFingerprint,
            terminalAuthorityLeafHandle: dependency.terminalAuthorityLeafHandle,
          }],
        },
      },
    });
    expect(result).toMatchObject({
      status: "partial_loss",
      remainingModelExposureDependencies: [{
        kind: "record",
        recordRef: "record:remaining",
      }],
    });
    expect(rewriteInput).toEqual({
      remainingSupportStatements: ["The surviving record statement."],
    });
  });

  test("waits when current support eligibility is temporarily unavailable", async () => {
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "unavailable" }; } } as never,
      repository: {
        async read() {
          return {
            status: "available",
            record: { ...input.record, recordRef: "record:remaining" },
          };
        },
      } as never,
      source: {} as never,
      invalidation: { async admit() {} },
      statements: {} as never,
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: { ...input.record.semantic, sourceDependencies: [] },
      },
    })).toEqual({ status: "unavailable" });
  });

  test("regenerates from a current authorized child when its exposed generation advanced", async () => {
    let rewriteInput: unknown;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: { async check() { return { status: "eligible" }; } } as never,
      repository: {
        async read() {
          return {
            status: "available",
            record: { ...input.record, recordRef: "record:remaining" },
          };
        },
        async readSuccessors() {
          return { status: "available", page: { items: [] } };
        },
      } as never,
      source: {
        async readExact() {
          return { status: "available", kind: "memory", content: "Exact source support." };
        },
      },
      invalidation: { async admit() {} },
      statements: {
        async rewrite(value) {
          rewriteInput = value;
          return { status: "available", statement: "Source support remains.", modelCalls: 1 };
        },
      },
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: {
          ...input.record.semantic,
          modelExposureDependencies: [{
            kind: "record",
            recordRef: "record:remaining",
            observedProcessingGeneration: 2,
            terminalAuthorityLeafHandles: ["namespace:one"],
          }, {
            kind: "source",
            sourceKind: dependency.sourceKind,
            logicalSourceRef: dependency.logicalSourceRef,
            observedRevision: dependency.observedRevision,
            observedContentFingerprint: dependency.observedContentFingerprint,
            terminalAuthorityLeafHandle: dependency.terminalAuthorityLeafHandle,
          }],
        },
      },
    })).toMatchObject({
      status: "partial_loss",
      remainingChildRecordRefs: ["record:remaining"],
      remainingSourceDependencies: [dependency],
      remainingModelExposureDependencies: [
        { kind: "record", recordRef: "record:remaining" },
        { kind: "source", logicalSourceRef: dependency.logicalSourceRef },
      ],
    });
    expect(rewriteInput).toEqual({
      remainingSupportStatements: [
        "Postgres won because of durable queries and managed hosting.",
        "Exact source support.",
      ],
    });
  });

  test("does not open an unavailable record disposition as evidence", async () => {
    let reads = 0;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {} as never,
      recordState: {
        async readState() {
          return {
            status: "available",
            lifecycle: "stale",
            processingGeneration: 1,
            disposition: "blocked",
          };
        },
        async readSuccessors() {
          throw new Error("blocked record resolved successors");
        },
      },
      repository: {
        async read() { reads += 1; return { status: "unavailable" }; },
      } as never,
      source: {} as never,
      invalidation: { async admit() {} },
      statements: {} as never,
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: { ...input.record.semantic, sourceDependencies: [] },
      },
    })).toEqual({ status: "unavailable" });
    expect(reads).toBe(0);
  });

  test("waits for a stale record with no proven successor", async () => {
    let reads = 0;
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {} as never,
      recordState: {
        async readState() {
          return {
            status: "available",
            lifecycle: "stale",
            processingGeneration: 1,
            disposition: "available",
          };
        },
        async readSuccessors() {
          return { status: "available", successorRecordRefs: [], complete: true };
        },
      },
      repository: {
        async read() { reads += 1; return { status: "unavailable" }; },
      } as never,
      source: {} as never,
      invalidation: { async admit() {} },
      statements: {} as never,
    });
    expect(await resolver.resolve({
      ...input,
      record: {
        ...input.record,
        semantic: { ...input.record.semantic, sourceDependencies: [] },
      },
    })).toEqual({ status: "unavailable" });
    expect(reads).toBe(0);
  });
});
