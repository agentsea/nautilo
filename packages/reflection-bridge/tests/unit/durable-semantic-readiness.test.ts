import { describe, expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";

import { DurableRecordSemanticReadiness } from "../../src/server";

const record: DurableRecordEnvelope = {
  recordRef: "record:one",
  semantic: {
    observedContentFingerprint: "sha256:one",
    posture: "derived",
    statement: "Use Postgres for durable relational state.",
    sourceDependencies: [],
    anchors: [{ anchorRef: "room:one", kind: "room", role: "origin" }],
    childRecordRefs: [],
    producer: { producerRef: "stenographer", policyVersion: "v1" },
    terminalAuthorityLeafHandles: ["namespace:one"],
  },
  lifecycle: "current",
  structuralHeight: 0,
  processingGeneration: 2,
};

const claim = {
  logicalObjectRef: record.recordRef,
  generation: 1,
  recordRef: record.recordRef,
  changeReason: "created",
  stage: "search_projection",
  leaseToken: "lease:one",
} as const;

const vector = Object.freeze(
  Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0),
);

describe("durable semantic readiness", () => {
  test("generic protected Records without public closure remain unavailable without opening a body", async () => {
    const readiness = new DurableRecordSemanticReadiness({
      repository: {read() {throw new Error("no ungranted body read");}} as never,
      bindings: {resolveWork() {throw new Error("no dependency traversal");}} as never,
      eligibility: {} as never, embedding: {} as never, searchProjections: {} as never,
      authorityProjections: {readCurrent() {return Promise.resolve(null);}} as never,
      authorityReconciliation: {selection: {selectedRepresentation: "protected"}} as never,
    });
    expect(await readiness.ensureAuthority(claim)).toEqual({status: "unavailable", failureCode: "authority_unavailable"});
  });
  test("checks exact authority before opening and embedding selected bytes", async () => {
    const calls: string[] = [];
    let published: unknown;
    const readiness = new DurableRecordSemanticReadiness({
      repository: {
        async read() {
          calls.push("open");
          return { status: "available", record };
        },
      } as never,
      bindings: {
        async resolveWork() {
          calls.push("binding");
          return {
            readBindingRef: "read:one",
            invocationAudience: {
              humanRefs: ["human:one"],
              includesPublicBoundary: false,
            },
          };
        },
      } as never,
      eligibility: {
        async check() {
          calls.push("authority");
          return { status: "eligible" };
        },
      } as never,
      authorityProjections: {} as never,
      authorityReconciliation: {} as never,
      embedding: {
        async embed() {
          calls.push("embed");
          return {
            status: "available",
            embedding: {
              provenance: {
                provider: "openai",
                canonicalModel: "text-embedding-3-small",
                dimensions: 1_536,
                contractVersion: 1,
              },
              vector,
            },
          };
        },
      },
      searchProjections: {
        async readCurrent() {
          calls.push("projection-read");
          return null;
        },
        async publish(value: unknown) {
          calls.push("projection-publish");
          published = value;
          return "published";
        },
      } as never,
    });

    expect(await readiness.ensureSearchProjection(claim)).toEqual({ status: "ready" });
    expect(calls).toEqual([
      "binding",
      "authority",
      "open",
      "embed",
      "projection-read",
      "projection-publish",
    ]);
    expect(published).toMatchObject({
      recordRef: "record:one",
      recordProcessingGeneration: 2,
      projectionGeneration: 1,
    });
  });

  test("builds authority closure from cited and exposed sources plus exposed Records", async () => {
    const reads: string[] = [];
    let installed: unknown;
    const child: DurableRecordEnvelope = {
      ...record,
      recordRef: "record:exposed-child",
      processingGeneration: 3,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: "sha256:child",
        statement: "Uncited model context from a Record.",
        sourceDependencies: [{
          sourceKind: "memory",
          logicalSourceRef: "memory:child-source",
          observedRevision: "1",
          observedContentFingerprint: "sha256:child-source",
          terminalAuthorityLeafHandle: "namespace:child",
          authorityBearing: true,
        }],
        terminalAuthorityLeafHandles: ["namespace:child"],
      },
    };
    const root: DurableRecordEnvelope = {
      ...record,
      semantic: {
        ...record.semantic,
        sourceDependencies: [{
          sourceKind: "memory",
          logicalSourceRef: "memory:cited",
          observedRevision: "2",
          observedContentFingerprint: "sha256:cited",
          terminalAuthorityLeafHandle: "namespace:cited",
          authorityBearing: true,
        }],
        modelExposureDependencies: [
          {
            kind: "source",
            sourceKind: "memory",
            logicalSourceRef: "memory:uncited",
            observedRevision: "4",
            observedContentFingerprint: "sha256:uncited",
            terminalAuthorityLeafHandle: "namespace:uncited",
          },
          {
            kind: "record",
            recordRef: child.recordRef,
            observedProcessingGeneration: child.processingGeneration,
            terminalAuthorityLeafHandles: ["namespace:child"],
          },
        ],
        terminalAuthorityLeafHandles: [
          "namespace:child",
          "namespace:cited",
          "namespace:uncited",
        ],
      },
    };
    let closureInstalled = false;
    const readiness = new DurableRecordSemanticReadiness({
      repository: {
        async read(input: { recordRef: string }) {
          reads.push(input.recordRef);
          return {
            status: "available",
            record: input.recordRef === root.recordRef ? root : child,
          };
        },
      } as never,
      bindings: {
        async resolveWork(recordRef: string) {
          return { readBindingRef: `read:${recordRef}` };
        },
      } as never,
      eligibility: {} as never,
      embedding: {} as never,
      searchProjections: {} as never,
      authorityProjections: {
        async readCurrent() {
          return closureInstalled ? {
            processingState: "current",
            recordDisposition: "available",
          } : null;
        },
        async installInitialClosure(input: unknown) {
          installed = input;
          closureInstalled = true;
          return "installed";
        },
      } as never,
      authorityReconciliation: {
        selection: { selectedRepresentation: "ordinary" },
      } as never,
    });

    expect(await readiness.ensureAuthority(claim)).toEqual({ status: "ready" });
    expect(reads).toEqual(["record:one", "record:exposed-child"]);
    expect(installed).toEqual({
      recordRef: "record:one",
      closureGeneration: 1,
      terminalAuthorityLeafHandles: [
        "namespace:child",
        "namespace:cited",
        "namespace:uncited",
      ],
    });
  });

  test("rejects an exposed Record that is no longer at its authenticated generation", async () => {
    const staleChild: DurableRecordEnvelope = {
      ...record,
      recordRef: "record:stale-exposure",
      lifecycle: "superseded",
      processingGeneration: 4,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: "sha256:stale-exposure",
      },
    };
    const root: DurableRecordEnvelope = {
      ...record,
      semantic: {
        ...record.semantic,
        modelExposureDependencies: [{
          kind: "record",
          recordRef: staleChild.recordRef,
          observedProcessingGeneration: 3,
          terminalAuthorityLeafHandles: ["namespace:one"],
        }],
      },
    };
    let installations = 0;
    const readiness = new DurableRecordSemanticReadiness({
      repository: {
        read(input: { recordRef: string }) {
          return Promise.resolve({
            status: "available" as const,
            record: input.recordRef === root.recordRef ? root : staleChild,
          });
        },
      } as never,
      bindings: {
        resolveWork(recordRef: string) {
          return Promise.resolve({ readBindingRef: `read:${recordRef}` });
        },
      } as never,
      eligibility: {} as never,
      embedding: {} as never,
      searchProjections: {} as never,
      authorityProjections: {
        readCurrent() { return Promise.resolve(null); },
        installInitialClosure() {
          installations += 1;
          return Promise.resolve("installed");
        },
      } as never,
      authorityReconciliation: {
        selection: { selectedRepresentation: "ordinary" },
      } as never,
    });

    expect(await readiness.ensureAuthority(claim)).toEqual({
      status: "unavailable",
      failureCode: "authority_unavailable",
    });
    expect(installations).toBe(0);
  });

  test("rejects conflicting generations for a shared exposure already traversed", async () => {
    const shared: DurableRecordEnvelope = {
      ...record,
      recordRef: "record:shared-exposure",
      processingGeneration: 3,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: "sha256:shared-exposure",
      },
    };
    const branch = (
      recordRef: string,
      observedProcessingGeneration: number,
    ): DurableRecordEnvelope => ({
      ...record,
      recordRef,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: `sha256:${recordRef}`,
        modelExposureDependencies: [{
          kind: "record",
          recordRef: shared.recordRef,
          observedProcessingGeneration,
          terminalAuthorityLeafHandles: ["namespace:one"],
        }],
      },
    });
    const first = branch("record:branch-a", 3);
    const second = branch("record:branch-b", 4);
    const root: DurableRecordEnvelope = {
      ...record,
      semantic: {
        ...record.semantic,
        modelExposureDependencies: [first, second].map((dependency) => ({
          kind: "record" as const,
          recordRef: dependency.recordRef,
          observedProcessingGeneration: dependency.processingGeneration,
          terminalAuthorityLeafHandles: ["namespace:one"],
        })),
      },
    };
    const records = new Map([root, first, second, shared].map((entry) => [
      entry.recordRef,
      entry,
    ]));
    const reads: string[] = [];
    let installations = 0;
    const readiness = new DurableRecordSemanticReadiness({
      repository: {
        read(input: { recordRef: string }) {
          reads.push(input.recordRef);
          const value = records.get(input.recordRef)!;
          return Promise.resolve({ status: "available" as const, record: value });
        },
      } as never,
      bindings: {
        resolveWork(recordRef: string) {
          return Promise.resolve({ readBindingRef: `read:${recordRef}` });
        },
      } as never,
      eligibility: {} as never,
      embedding: {} as never,
      searchProjections: {} as never,
      authorityProjections: {
        readCurrent() { return Promise.resolve(null); },
        installInitialClosure() {
          installations += 1;
          return Promise.resolve("installed");
        },
      } as never,
      authorityReconciliation: {
        selection: { selectedRepresentation: "ordinary" },
      } as never,
    });

    expect(await readiness.ensureAuthority(claim)).toEqual({
      status: "unavailable",
      failureCode: "authority_unavailable",
    });
    expect(reads).toEqual([
      "record:one",
      "record:branch-a",
      "record:shared-exposure",
      "record:branch-b",
    ]);
    expect(installations).toBe(0);
  });
});
