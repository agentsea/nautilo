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
