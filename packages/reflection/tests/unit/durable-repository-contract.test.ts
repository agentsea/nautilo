import { describe, expect, test } from "bun:test";

import type {
  DurableRecordEnvelope,
  DurableRecordMutationPort,
  DurableRecordReadPort,
  HierarchyStructuralRecord,
  HierarchyStructuralView,
  SuccessorEdge,
} from "../../src/durable";
import {
  assertDurableRecordPageRequest,
  assertExistingSuccessorEdgeStructure,
  assertLifecycleTransition,
  assertNewRecordStructure,
  assertSuccessorStructure,
  durableEnvelopeToRecordSnapshot,
  DURABLE_RECORD_PAGE_LIMIT_MAX,
  HierarchyError,
} from "../../src/durable";

function record(
  recordRef: string,
  options: Partial<HierarchyStructuralRecord> = {},
): HierarchyStructuralRecord {
  return {
    recordRef,
    lifecycle: "current",
    structuralHeight: 0,
    statement: `Statement ${recordRef}`,
    anchorRefs: [],
    sourceRefs: [],
    childRecordRefs: [],
    ...options,
  };
}

class StructuralFixture implements HierarchyStructuralView {
  readonly records = new Map<string, HierarchyStructuralRecord>();
  readonly edges = new Map<string, SuccessorEdge[]>();

  getRecord(recordRef: string): HierarchyStructuralRecord | undefined {
    return this.records.get(recordRef);
  }

  successorEdgesFrom(recordRef: string): readonly SuccessorEdge[] {
    return this.edges.get(recordRef) ?? [];
  }
}

function hierarchyCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(HierarchyError);
    return (error as HierarchyError).code;
  }
}

function envelope(): DurableRecordEnvelope {
  return {
    recordRef: "record-parent",
    semantic: {
      observedContentFingerprint: "content-fingerprint",
      posture: "derived",
      statement: "PostgreSQL was selected for transactional consistency.",
      sourceDependencies: [{
        sourceKind: "journal_event",
        logicalSourceRef: "source-decision",
        observedRevision: "revision-3",
        observedContentFingerprint: "source-fingerprint",
        terminalAuthorityLeafHandle: "leaf-authority-1",
        authorityBearing: true,
      }],
      anchors: [{
        anchorRef: "room-database",
        kind: "room",
        role: "source_origin",
      }, {
        anchorRef: "subject-postgres",
        kind: "subject",
        role: "inherited",
      }],
      childRecordRefs: ["record-argument"],
      producer: {
        producerRef: "organizer-v1",
        policyVersion: "candidate-policy-v1",
      },
      terminalAuthorityLeafHandles: ["leaf-authority-1"],
      sourceOwnedKind: "journal_event:decision",
      observedLogicalObjectRef: "journal-event-42",
      observedRevision: "event-version-3",
    },
    lifecycle: "current",
    structuralHeight: 1,
    processingGeneration: 7,
  };
}

describe("durable Record repository contracts", () => {
  test("carries every immutable semantic codec field without representation concerns", () => {
    const durable = envelope();
    const snapshot = durableEnvelopeToRecordSnapshot(durable);
    expect(snapshot).toEqual({
      recordRef: "record-parent",
      observedContentFingerprint: "content-fingerprint",
      posture: "derived",
      anchors: ["room-database", "subject-postgres"],
      statement: "PostgreSQL was selected for transactional consistency.",
      sourceRefs: ["source-decision"],
      childRecordRefs: ["record-argument"],
      structuralHeight: 1,
      lifecycle: "current",
      sourceOwnedKind: "journal_event:decision",
      observedLogicalObjectRef: "journal-event-42",
      observedRevision: "event-version-3",
    });
    expect(durable.semantic.sourceDependencies[0]).toMatchObject({
      observedRevision: "revision-3",
      observedContentFingerprint: "source-fingerprint",
      terminalAuthorityLeafHandle: "leaf-authority-1",
    });
    expect(JSON.stringify(durable)).not.toContain("cryptoObject");
    expect(JSON.stringify(durable)).not.toContain("plaintextPayload");
    expect(JSON.stringify(durable)).not.toContain("representation");
  });

  test("requires explicit bounded pages and opaque read bindings", () => {
    expect(() => assertDurableRecordPageRequest({
      recordRef: "record-1",
      readBindingRef: "binding-1",
      limit: 1,
    })).not.toThrow();
    expect(() => assertDurableRecordPageRequest({
      recordRef: "record-1",
      readBindingRef: "binding-1",
      limit: DURABLE_RECORD_PAGE_LIMIT_MAX,
      continuation: "next-page",
    })).not.toThrow();
    for (const limit of [0, DURABLE_RECORD_PAGE_LIMIT_MAX + 1, 1.5, Number.NaN]) {
      expect(() => assertDurableRecordPageRequest({
        recordRef: "record-1",
        readBindingRef: "binding-1",
        limit,
      })).toThrow(RangeError);
    }
    expect(() => assertDurableRecordPageRequest({
      recordRef: "record-1",
      readBindingRef: "",
      limit: 1,
    })).toThrow(TypeError);
    expect(() => assertDurableRecordPageRequest({
      recordRef: "record-1",
      readBindingRef: "binding-1",
      limit: 1,
      continuation: "",
    })).toThrow(TypeError);
  });

  test("ports expose one logical API without choosing ordinary or protected mode", () => {
    const mutations: DurableRecordMutationPort = {
      publish: (input) => Promise.resolve({ status: "published", record: input.record }),
      transitionLifecycle: (input) => Promise.resolve({
        status: "transitioned",
        recordRef: input.recordRef,
        lifecycle: input.to,
        replayed: false,
      }),
      block: (input) => Promise.resolve({
        status: "blocked",
        recordRef: input.recordRef,
        replayed: false,
      }),
      purge: (input) => Promise.resolve({
        status: "purged",
        recordRef: input.recordRef,
        replayed: false,
      }),
    };
    const reads: DurableRecordReadPort = {
      read: (input) => Promise.resolve({
        status: "unavailable",
        recordRef: input.recordRef,
        reason: "selected_representation_missing",
      }),
      readDependencies: () => Promise.resolve({
        status: "available",
        page: { items: [], continuation: "opaque-next" },
      }),
      readParents: () => Promise.resolve({ status: "available", page: { items: [] } }),
      readSuccessors: () => Promise.resolve({ status: "available", page: { items: [] } }),
      readPredecessors: () => Promise.resolve({ status: "available", page: { items: [] } }),
    };
    expect(mutations).toHaveProperty("publish");
    expect(mutations).toHaveProperty("transitionLifecycle");
    expect(mutations).toHaveProperty("block");
    expect(mutations).toHaveProperty("purge");
    expect(reads).toHaveProperty("readDependencies");
  });
});

describe("shared pure hierarchy structural validation", () => {
  test("validates new height and rejects unknown or ancestor-redundant support", () => {
    const view = new StructuralFixture();
    view.records.set("leaf", record("leaf"));
    view.records.set("sibling", record("sibling"));
    view.records.set("parent", record("parent", {
      structuralHeight: 1,
      childRecordRefs: ["leaf", "sibling"],
    }));
    expect(assertNewRecordStructure({
      record: record("next", {
        structuralHeight: 2,
        childRecordRefs: ["parent"],
      }),
      view,
      requireCurrent: true,
    }).map((child) => child.recordRef)).toEqual(["parent"]);
    expect(hierarchyCode(() => assertNewRecordStructure({
      record: record("bad", {
        structuralHeight: 2,
        childRecordRefs: ["parent", "leaf"],
      }),
      view,
      requireCurrent: true,
    }))).toBe("ancestor_descendant_duplication");
    expect(hierarchyCode(() => assertNewRecordStructure({
      record: record("unknown", {
        structuralHeight: 1,
        childRecordRefs: ["missing"],
      }),
      view,
      requireCurrent: true,
    }))).toBe("unknown_reference");
  });

  test("makes terminal lifecycle transitions inseparable from successor validation", () => {
    expect(hierarchyCode(() => assertLifecycleTransition(
      "current",
      "superseded",
      { successorAttached: false },
    ))).toBe("invalid_lifecycle_transition");
    expect(() => assertLifecycleTransition(
      "current",
      "superseded",
      { successorAttached: true },
    )).not.toThrow();

    const view = new StructuralFixture();
    view.records.set("old", record("old", {
      statement: "Old statement",
      childRecordRefs: [],
    }));
    expect(() => assertSuccessorStructure({
      predecessorRecordRef: "old",
      successor: record("new", { statement: "Corrected statement" }),
      relation: "supersedes",
      view,
    })).not.toThrow();
    expect(hierarchyCode(() => assertSuccessorStructure({
      predecessorRecordRef: "old",
      successor: record("noop", { statement: "Old statement" }),
      relation: "supersedes",
      view,
    }))).toBe("unchanged_successor");
  });

  test("rejects successor cycles through the same view contract durable adapters use", () => {
    const view = new StructuralFixture();
    view.records.set("a", record("a", { lifecycle: "current", statement: "A" }));
    view.records.set("b", record("b", { lifecycle: "current", statement: "B" }));
    view.edges.set("a", [{
      predecessorRecordRef: "a",
      successorRecordRef: "b",
      relation: "supersedes",
    }]);
    expect(hierarchyCode(() => assertExistingSuccessorEdgeStructure({
      predecessorRecordRef: "b",
      successorRecordRef: "a",
      relation: "supersedes",
      view,
    }))).toBe("successor_cycle");
  });
});
