import { describe, expect, test } from "bun:test";

import { ExactGroundedDependencyLossResolver } from "../../src/server";

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
    });
    expect(rewriteInput).toMatchObject({
      remainingSupportStatements: [
        "Postgres supports the required durable queries.",
      ],
    });
    expect(invalidations).toEqual([{ dependency, reason: "changed" }]);
  });

  test("sunsets when no support remains without invoking a rewrite", async () => {
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
    })).toEqual({ status: "total_loss" });
    expect(rewrites).toBe(0);
  });

  test("replaces terminal child support with its one current successor", async () => {
    let rewriteInput: unknown;
    const reads: unknown[] = [];
    const successorReads: unknown[] = [];
    const resolver = new ExactGroundedDependencyLossResolver({
      eligibility: {
        async check({ recordRef }: { recordRef: string }) {
          return recordRef === "record:remaining-v2"
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
      repository: {
        async read(value: { recordRef: string; readBindingRef: string }) {
          reads.push(value);
          return {
            status: "available",
            record: {
              ...input.record,
              recordRef: value.recordRef,
              lifecycle: "current",
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
          childRecordRefs: ["record:remaining", "record:remaining-v2"],
        },
      },
    })).toEqual({
      status: "partial_loss",
      replacementStatement: "Postgres remains selected under the replacement design.",
      modelCalls: 1,
      remainingChildRecordRefs: ["record:remaining-v2"],
      remainingSourceDependencies: [],
    });
    expect(rewriteInput).toMatchObject({
      remainingSupportStatements: [
        "Postgres now uses the replacement durable design.",
      ],
    });
    expect(reads).toEqual([
      {
        recordRef: "record:remaining-v2",
        readBindingRef: "binding:record:remaining-v2",
      },
      {
        recordRef: "record:remaining-v2",
        readBindingRef: "binding:record:remaining-v2",
      },
    ]);
    expect(successorReads).toEqual([{
      recordRef: "record:remaining",
      readBindingRef: "binding:record:remaining",
      limit: 2,
    }]);
  });
});
