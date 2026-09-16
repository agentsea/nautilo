import { describe, expect, test } from "bun:test";
import type {
  DurableRecordEnvelope,
  DurableRecordReadRequest,
} from "@nautilo/reflection/durable";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import {
  PostgresSameRoomOrganizerNeighbors,
  type PostgresSameRoomOrganizerStore,
} from "../../src/server";

const HUMAN = "11111111-1111-4111-8111-111111111111";

function record(
  recordRef: string,
  structuralHeight = 0,
  roomAnchorRef = "room:one",
): DurableRecordEnvelope {
  return {
    recordRef,
    semantic: {
      observedContentFingerprint: `sha256:${recordRef}`,
      posture: structuralHeight === 0 ? "authored" : "derived",
      statement: `Statement for ${recordRef}`,
      sourceDependencies: [],
      anchors: [{ anchorRef: roomAnchorRef, kind: "room", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "test", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["namespace:one"],
    },
    lifecycle: "current",
    structuralHeight,
    processingGeneration: 1,
  };
}

function coordinate(
  recordRef: string,
  score: number,
  structuralHeight = 0,
): RankedRecordCoordinate {
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

const binding = {
  roomAnchorRef: "room:one",
  invocationAudience: {
    humanRefs: [HUMAN],
    includesPublicBoundary: false,
  },
  readBindingRef: "read:one",
  searchBindingRef: "search:one",
  publicationBindingRef: "publish:one",
} as const;

const EMBEDDING: RecordEmbeddingV1 = {
  provenance: {
    provider: "openai",
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536,
    contractVersion: 1,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.25))),
};

describe("same-Room Organizer neighbor adapter", () => {
  test("separates immediate leaf neighbors from derived extension targets", async () => {
    const leaf = coordinate("record:leaf", 0.9);
    const parent = coordinate("record:parent", 0.8, 1);
    const directParent = coordinate("record:direct-parent", 0, 1);
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {
        async readCurrentEmbedding(recordRef) {
          return {
            recordRef,
            recordProcessingGeneration: 1,
            projectionVersion: 1,
            projectionGeneration: 1,
            embedding: EMBEDDING,
          } as const;
        },
      },
      store: {
        async rank(input: Parameters<PostgresSameRoomOrganizerStore["rank"]>[0]) {
          expect(input.intent).toBe("attachment");
          expect(input.limit).toBe(16);
          expect(input.embedding).toBe(EMBEDDING);
          return {
            status: "available",
            coordinates: [leaf, parent],
            rowsConsidered: 2,
          } as const;
        },
        async topology() {
          return {
            status: "available",
            topology: {
              directParents: [directParent],
              redundantRecordRefs: [],
              traversalWork: 2,
              normalizedCoordinates: [],
              normalizedRecordRefs: new Map([
                ["record:changed", "record:changed"],
                [leaf.recordRef, leaf.recordRef],
                [parent.recordRef, parent.recordRef],
              ]),
              authorityParentRecordRefs: [],
              changedAlreadyParented: false,
            },
          } as const;
        },
      } as never,
      repository: {} as never,
    });

    const result = await adapter.discover({
      changed: record("record:changed"),
      binding,
      intent: "attachment",
    });
    expect(result).toEqual({
      status: "available",
      discovery: {
        queryEmbedding: EMBEDDING,
        candidateCoordinates: [leaf],
        authorityParentCandidateCoordinates: [],
        parentTargetCoordinates: [directParent, parent],
        authorityParentTargetCoordinates: [],
        changedAlreadyParented: false,
        metrics: { rowsConsidered: 2, rowsSelected: 3, topologyWork: 2 },
      },
    });
  });

  test("promotion discovery retains only nonredundant current parent heads", async () => {
    const parentA = coordinate("record:parent-a", 0.9, 1);
    const parentB = coordinate("record:parent-b", 0.8, 2);
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "protected", migrationGeneration: 3 },
      projections: {
        async readCurrentEmbedding(recordRef) {
          return {
            recordRef,
            recordProcessingGeneration: 1,
            projectionVersion: 1,
            projectionGeneration: 1,
            embedding: EMBEDDING,
          } as const;
        },
      },
      store: {
        async rank(input: Parameters<PostgresSameRoomOrganizerStore["rank"]>[0]) {
          expect(input.intent).toBe("promotion");
          return {
            status: "available",
            coordinates: [parentA, parentB],
            rowsConsidered: 2,
          } as const;
        },
        async topology() {
          return {
            status: "available",
            topology: {
              directParents: [],
              redundantRecordRefs: [parentB.recordRef],
              traversalWork: 4,
              normalizedCoordinates: [],
              normalizedRecordRefs: new Map([
                ["record:changed", "record:changed"],
                [parentA.recordRef, parentA.recordRef],
                [parentB.recordRef, parentB.recordRef],
              ]),
              authorityParentRecordRefs: [],
              changedAlreadyParented: false,
            },
          } as const;
        },
      } as never,
      repository: {} as never,
    });

    const result = await adapter.discover({
      changed: record("record:changed", 1),
      binding,
      intent: "promotion",
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.discovery.candidateCoordinates).toEqual([parentA]);
    expect(result.discovery.parentTargetCoordinates).toEqual([]);
  });

  test("normalizes a ranked leaf through its unique current parent chain", async () => {
    const leaf = coordinate("record:leaf", 0.91);
    const highestParent = coordinate("record:q", 0, 2);
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {
        async readCurrentEmbedding(recordRef) {
          return {
            recordRef,
            recordProcessingGeneration: 1,
            projectionVersion: 1,
            projectionGeneration: 1,
            embedding: EMBEDDING,
          } as const;
        },
      },
      store: {
        async rank() {
          return { status: "available", coordinates: [leaf], rowsConsidered: 1 } as const;
        },
        async topology() {
          return {
            status: "available",
            topology: {
              directParents: [],
              redundantRecordRefs: [],
              traversalWork: 2,
              normalizedCoordinates: [highestParent],
              normalizedRecordRefs: new Map([
                ["record:changed", "record:changed"],
                [leaf.recordRef, highestParent.recordRef],
              ]),
              authorityParentRecordRefs: [],
              changedAlreadyParented: false,
            },
          } as const;
        },
      } as never,
      repository: {} as never,
    });

    expect(await adapter.discover({
      changed: record("record:changed"),
      binding,
      intent: "attachment",
    })).toEqual({
      status: "available",
      discovery: {
        queryEmbedding: EMBEDDING,
        candidateCoordinates: [],
        authorityParentCandidateCoordinates: [],
        parentTargetCoordinates: [{ ...highestParent, score: leaf.score }],
        authorityParentTargetCoordinates: [],
        changedAlreadyParented: false,
        metrics: { rowsConsidered: 1, rowsSelected: 1, topologyWork: 2 },
      },
    });
  });

  test("suppresses a ranked descendant that normalizes back to the changed parent", async () => {
    const changed = coordinate("record:changed", 0, 1);
    const descendant = coordinate("record:descendant", 0.91);
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {
        async readCurrentEmbedding(recordRef) {
          return {
            recordRef,
            recordProcessingGeneration: 1,
            projectionVersion: 1,
            projectionGeneration: 1,
            embedding: EMBEDDING,
          } as const;
        },
      },
      store: {
        async rank() {
          return {
            status: "available",
            coordinates: [descendant],
            rowsConsidered: 1,
          } as const;
        },
        async topology() {
          return {
            status: "available",
            topology: {
              directParents: [],
              redundantRecordRefs: [],
              traversalWork: 1,
              normalizedCoordinates: [changed],
              normalizedRecordRefs: new Map([
                [changed.recordRef, changed.recordRef],
                [descendant.recordRef, changed.recordRef],
              ]),
              authorityParentRecordRefs: [],
              changedAlreadyParented: false,
            },
          } as const;
        },
      } as never,
      repository: {} as never,
    });

    expect(await adapter.discover({
      changed: record(changed.recordRef, 1),
      binding,
      intent: "attachment",
    })).toEqual({
      status: "available",
      discovery: {
        queryEmbedding: EMBEDDING,
        candidateCoordinates: [],
        authorityParentCandidateCoordinates: [],
        parentTargetCoordinates: [],
        authorityParentTargetCoordinates: [],
        changedAlreadyParented: false,
        metrics: { rowsConsidered: 1, rowsSelected: 0, topologyWork: 1 },
      },
    });
  });

  test("hands a cross-binding parent seed to the authority-aware partition", async () => {
    const leaf = coordinate("record:leaf", 0.91);
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {
        async readCurrentEmbedding(recordRef) {
          return {
            recordRef,
            recordProcessingGeneration: 1,
            projectionVersion: 1,
            projectionGeneration: 1,
            embedding: EMBEDDING,
          } as const;
        },
      },
      store: {
        async rank() {
          return { status: "available", coordinates: [leaf], rowsConsidered: 1 } as const;
        },
        async topology() {
          return {
            status: "available",
            topology: {
              directParents: [],
              redundantRecordRefs: [],
              traversalWork: 1,
              normalizedCoordinates: [],
              normalizedRecordRefs: new Map([
                ["record:changed", "record:changed"],
                [leaf.recordRef, leaf.recordRef],
              ]),
              authorityParentRecordRefs: [leaf.recordRef],
              changedAlreadyParented: false,
            },
          } as const;
        },
      } as never,
      repository: {} as never,
    });

    const result = await adapter.discover({
      changed: record("record:changed"),
      binding,
      intent: "attachment",
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.discovery.candidateCoordinates).toEqual([]);
    expect(result.discovery.authorityParentCandidateCoordinates).toEqual([leaf]);
    expect(result.discovery.parentTargetCoordinates).toEqual([]);
    expect(result.discovery.authorityParentTargetCoordinates).toEqual([]);
  });

  test("runs one final fence and opens only selected coordinates", async () => {
    const selected = coordinate("record:selected", 0.9);
    const unselected = coordinate("record:unselected", 0.8);
    const opened: string[] = [];
    let fenced: readonly RankedRecordCoordinate[] = [];
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {} as never,
      store: {
        async fence(input: Parameters<PostgresSameRoomOrganizerStore["fence"]>[0]) {
          fenced = input.coordinates;
          return { status: "current" } as const;
        },
      } as never,
      repository: {
        async read(input: DurableRecordReadRequest) {
          opened.push(input.recordRef);
          return { status: "available", record: record(input.recordRef) } as const;
        },
      } as never,
    });

    const result = await adapter.openSelected({ binding, coordinates: [selected] });
    expect(result.status).toBe("available");
    expect(fenced).toEqual([selected]);
    expect(opened).toEqual([selected.recordRef]);
    expect(opened).not.toContain(unselected.recordRef);
  });

  test("fails closed without opening when the final fence is stale", async () => {
    let opens = 0;
    const adapter = new PostgresSameRoomOrganizerNeighbors({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      projections: {} as never,
      store: {
        async fence() {
          return { status: "stale" } as const;
        },
      } as never,
      repository: {
        async read() {
          opens += 1;
          return { status: "available", record: record("record:selected") } as const;
        },
      } as never,
    });

    expect(await adapter.openSelected({
      binding,
      coordinates: [coordinate("record:selected", 0.9)],
    })).toEqual({ status: "unavailable", reason: "candidate_fence_stale" });
    expect(opens).toBe(0);
  });
});
