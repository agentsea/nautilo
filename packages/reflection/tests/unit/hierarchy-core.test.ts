import { describe, expect, test } from "bun:test";

import type {
  HierarchyBudget,
  HierarchyErrorCode,
  RecordLifecycle,
  RecordSnapshot,
  SyntheticAccessAudience,
  SyntheticEligibleRecord,
} from "../../src/contracts/hierarchy";
import { HierarchyError } from "../../src/contracts/hierarchy";
import { InMemoryHierarchyRepository } from "../../src/graph/in-memory-repository";
import {
  deriveStructuralHeight,
  deriveSyntheticAnchors,
  intersectSyntheticAudiences,
  SyntheticHierarchyBridge,
} from "../../src/graph/synthetic-bridge";

const LARGE_BUDGET: HierarchyBudget = {
  maxModelCalls: 0,
  maxVisitedRecords: 100,
  maxCreatedRecords: 100,
  maxTraversalWork: 100,
  maxStatementCharacters: 2_000,
};

const audience = (...humanRefs: string[]): SyntheticAccessAudience => ({
  kind: "access",
  humanRefs,
});

function eligible(
  recordRef: string,
  options: {
    statement?: string;
    audience?: SyntheticAccessAudience;
    scope?: SyntheticAccessAudience;
    anchors?: readonly string[];
    children?: readonly string[];
    height?: number;
    lifecycle?: RecordLifecycle;
    posture?: "authored" | "derived";
    sourceRefs?: readonly string[];
    observedLogicalObjectRef?: string;
    observedRevision?: string;
  } = {},
): SyntheticEligibleRecord {
  const snapshot: RecordSnapshot = {
    recordRef,
    observedContentFingerprint: `fingerprint:${recordRef}`,
    posture: options.posture ?? "authored",
    anchors: options.anchors ?? [`room:${recordRef}`],
    statement: options.statement ?? `Statement for ${recordRef}`,
    sourceRefs: options.sourceRefs ?? [],
    childRecordRefs: options.children ?? [],
    structuralHeight: options.height ?? 0,
    lifecycle: options.lifecycle ?? "current",
    ...(options.observedLogicalObjectRef === undefined
      ? {}
      : { observedLogicalObjectRef: options.observedLogicalObjectRef }),
    ...(options.observedRevision === undefined
      ? {}
      : { observedRevision: options.observedRevision }),
  };
  return {
    snapshot,
    audience: options.audience ?? audience("alice", "bob"),
    initialPublicationScope: options.scope ?? audience("alice", "bob"),
  };
}

function harness(ids: readonly string[] = ["parent-1", "parent-2", "parent-3"]) {
  const repository = new InMemoryHierarchyRepository();
  let cursor = 0;
  let idCalls = 0;
  const bridge = new SyntheticHierarchyBridge({
    repository,
    idGenerator: () => {
      idCalls += 1;
      const id = ids[cursor];
      cursor += 1;
      if (!id) throw new Error("test ID sequence exhausted");
      return id;
    },
  });
  return { bridge, repository, idCalls: () => idCalls };
}

function codeOf(action: () => unknown): HierarchyErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(HierarchyError);
    return (error as HierarchyError).code;
  }
}

describe("hierarchy contracts and synthetic derivation", () => {
  test("intersects exact kind=access audiences deterministically", () => {
    expect(intersectSyntheticAudiences([
      audience("carol", "alice", "bob"),
      audience("dave", "bob", "alice"),
      audience("alice", "erin", "bob"),
    ])).toEqual(audience("alice", "bob"));
    expect(intersectSyntheticAudiences([])).toEqual(audience());
  });

  test("rejects duplicate audience members rather than silently normalizing them", () => {
    expect(codeOf(() => intersectSyntheticAudiences([
      audience("alice", "alice"),
    ]))).toBe("duplicate_reference");
  });

  test("derives anchor union and structural height independently of semantic order", () => {
    const { bridge, repository } = harness();
    const a = bridge.seedEligibleRecord(eligible("a", { anchors: ["room:b", "room:a"] }), LARGE_BUDGET);
    const b = bridge.seedEligibleRecord(eligible("b", { anchors: ["room:c", "room:a"] }), LARGE_BUDGET);
    expect(deriveSyntheticAnchors([a, b])).toEqual(["room:a", "room:b", "room:c"]);
    expect(deriveStructuralHeight([a, b])).toBe(1);
    expect(repository.list()).toHaveLength(2);
  });
});

describe("in-memory open DAG", () => {
  test("creates an immutable multi-child parent with backlinks and exact audience", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a", {
      anchors: ["room:a"],
      audience: audience("alice", "bob", "carol"),
    }), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("b", {
      anchors: ["room:b"],
      audience: audience("alice", "bob", "dave"),
    }), LARGE_BUDGET);

    const result = bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "The team selected PostgreSQL.",
        childRecordRefs: ["a", "b"],
      },
      eligibleRecordRefs: ["a", "b"],
      initialPublicationScope: audience("bob", "alice"),
      idempotencyKey: "create-1",
      budget: LARGE_BUDGET,
    });

    expect(result.operation).toBe("create_parent");
    if (result.operation !== "create_parent") throw new Error("unreachable");
    expect(result.record).toMatchObject({
      snapshot: {
        recordRef: "parent-1",
        posture: "derived",
        childRecordRefs: ["a", "b"],
        structuralHeight: 1,
        anchors: ["room:a", "room:b"],
        lifecycle: "current",
      },
      audience: audience("alice", "bob"),
      initialPublicationScope: audience("alice", "bob"),
    });
    expect(repository.parentsOf("a").map((record) => record.snapshot.recordRef)).toEqual(["parent-1"]);
    expect(repository.parentsOf("b").map((record) => record.snapshot.recordRef)).toEqual(["parent-1"]);
    expect(repository.childrenOf("parent-1").map((record) => record.snapshot.recordRef)).toEqual(["a", "b"]);
  });

  test("rejects a second current parent while retaining the first edge", () => {
    const { bridge, repository } = harness();
    for (const ref of ["shared", "a", "b"]) {
      bridge.seedEligibleRecord(eligible(ref), LARGE_BUDGET);
    }
    bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "first useful synthesis",
        childRecordRefs: ["shared", "a"],
      },
      eligibleRecordRefs: ["shared", "a"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "first",
      budget: LARGE_BUDGET,
    });
    expect(() => bridge.applyProposal({
        proposal: {
          operation: "create_parent",
          statement: "second overlapping synthesis",
          childRecordRefs: ["shared", "b"],
        },
        eligibleRecordRefs: ["shared", "b"],
        initialPublicationScope: audience("alice", "bob"),
        idempotencyKey: "second",
        budget: LARGE_BUDGET,
      })).toThrow(/at most one current semantic parent/);
    expect(repository.parentsOf("shared").map((record) => record.snapshot.recordRef))
      .toEqual(["parent-1"]);
  });

  test("returns defensive copies and never permits content/dependency mutation", () => {
    const { bridge, repository } = harness();
    const anchors = ["room:a"];
    const input = eligible("a", { anchors });
    bridge.seedEligibleRecord(input, LARGE_BUDGET);
    anchors.push("room:mutated");
    const returned = repository.require("a");
    (returned.snapshot.anchors as string[]).push("room:return-mutated");
    expect(repository.require("a").snapshot.anchors).toEqual(["room:a"]);
  });

  test("rejects a parent containing an ancestor and its descendant", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("leaf"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("sibling"), LARGE_BUDGET);
    bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "First parent",
        childRecordRefs: ["leaf", "sibling"],
      },
      eligibleRecordRefs: ["leaf", "sibling"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "first",
      budget: LARGE_BUDGET,
    });
    expect(codeOf(() => bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "Redundant parent",
        childRecordRefs: ["parent-1", "leaf"],
      },
      eligibleRecordRefs: ["parent-1", "leaf"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "redundant",
      budget: LARGE_BUDGET,
    }))).toBe("ancestor_descendant_duplication");
  });

  test("rejects duplicate, unknown, ineligible, and self references", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    expect(codeOf(() => bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Duplicate", childRecordRefs: ["a", "a"] },
      eligibleRecordRefs: ["a"],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "duplicate",
      budget: LARGE_BUDGET,
    }))).toBe("duplicate_reference");
    expect(codeOf(() => bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Unknown", childRecordRefs: ["missing"] },
      eligibleRecordRefs: [],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "unknown",
      budget: LARGE_BUDGET,
    }))).toBe("unknown_reference");
    expect(codeOf(() => bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Ineligible", childRecordRefs: ["a"] },
      eligibleRecordRefs: [],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "ineligible",
      budget: LARGE_BUDGET,
    }))).toBe("ineligible_reference");
    const isolatedRepository = new InMemoryHierarchyRepository();
    expect(codeOf(() => isolatedRepository.seed(eligible("self", {
      posture: "derived",
      children: ["self"],
      height: 1,
    }), LARGE_BUDGET))).toBe("self_dependency");
  });

  test("rejects successor cycles with typed failure", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("b"), LARGE_BUDGET);
    repository.recordSuccessor({
      predecessorRecordRef: "a",
      successorRecordRef: "b",
      relation: "supersedes",
      idempotencyKey: "a-to-b",
      mutationFingerprint: "a-to-b",
      budget: LARGE_BUDGET,
    });
    expect(codeOf(() => repository.recordSuccessor({
      predecessorRecordRef: "b",
      successorRecordRef: "a",
      relation: "supersedes",
      idempotencyKey: "b-to-a",
      mutationFingerprint: "b-to-a",
      budget: LARGE_BUDGET,
    }))).toBe("successor_cycle");
  });
});

describe("synthetic authority and application", () => {
  test("requires the whole invocation scope to fit each eligible Record", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("private", {
      audience: audience("alice"),
      scope: audience("alice"),
    }), LARGE_BUDGET);
    expect(codeOf(() => bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Must not leak", childRecordRefs: ["private"] },
      eligibleRecordRefs: ["private"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "leak",
      budget: LARGE_BUDGET,
    }))).toBe("ineligible_reference");
  });

  test("does not widen publication beyond dependency intersection and invocation scope", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a", { audience: audience("alice", "bob", "carol") }), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("b", { audience: audience("alice", "bob", "dave") }), LARGE_BUDGET);
    const result = bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Exact scope", childRecordRefs: ["a", "b"] },
      eligibleRecordRefs: ["a", "b"],
      initialPublicationScope: audience("bob"),
      idempotencyKey: "exact",
      budget: LARGE_BUDGET,
    });
    if (result.operation !== "create_parent") throw new Error("unreachable");
    expect(result.record.audience).toEqual(audience("bob"));
  });

  test("repository rejects a caller-supplied audience wider than exact intersection", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a", { audience: audience("alice", "bob") }), LARGE_BUDGET);
    expect(codeOf(() => repository.applyRecord({
      record: {
        snapshot: {
          ...eligible("malicious").snapshot,
          posture: "derived",
          childRecordRefs: ["a"],
          structuralHeight: 1,
        },
        audience: audience("alice", "bob"),
        initialPublicationScope: audience("alice"),
      },
      idempotencyKey: "malicious",
      mutationFingerprint: "malicious",
      budget: LARGE_BUDGET,
    }))).toBe("audience_mismatch");
    expect(repository.get("malicious")).toBeUndefined();
  });

  test("replays exactly once without allocating another fixture ID", () => {
    const { bridge, repository, idCalls } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    const input = {
      proposal: { operation: "create_parent", statement: "One parent", childRecordRefs: ["a"] } as const,
      eligibleRecordRefs: ["a"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "stable-key",
      budget: LARGE_BUDGET,
    };
    expect(bridge.applyProposal(input).replayed).toBe(false);
    expect(bridge.applyProposal(input).replayed).toBe(true);
    expect(repository.list()).toHaveLength(2);
    expect(idCalls()).toBe(1);
  });

  test("rejects reuse of an idempotency key for different semantics", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "First", childRecordRefs: ["a"] },
      eligibleRecordRefs: ["a"],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "same-key",
      budget: LARGE_BUDGET,
    });
    expect(codeOf(() => bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "Different", childRecordRefs: ["a"] },
      eligibleRecordRefs: ["a"],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "same-key",
      budget: LARGE_BUDGET,
    }))).toBe("idempotency_conflict");
  });

  test("enforces created-record, visited-record, traversal, and statement budgets", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    for (const [name, budget] of [
      ["created", { ...LARGE_BUDGET, maxCreatedRecords: 0 }],
      ["visited", { ...LARGE_BUDGET, maxVisitedRecords: 0 }],
      ["traversal", { ...LARGE_BUDGET, maxTraversalWork: 0 }],
      ["statement", { ...LARGE_BUDGET, maxStatementCharacters: 1 }],
    ] as const) {
      expect(codeOf(() => bridge.applyProposal({
        proposal: { operation: "create_parent", statement: "Too much", childRecordRefs: ["a"] },
        eligibleRecordRefs: ["a"],
        initialPublicationScope: audience("alice"),
        idempotencyKey: `budget-${name}`,
        budget,
      }))).toBe("budget_exceeded");
    }
  });

  test("counts Unicode code points rather than UTF-16 units for statement budgets", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    const result = bridge.applyProposal({
      proposal: { operation: "create_parent", statement: "🧠", childRecordRefs: ["a"] },
      eligibleRecordRefs: ["a"],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "unicode-budget",
      budget: { ...LARGE_BUDGET, maxStatementCharacters: 1 },
    });
    expect(result.operation).toBe("create_parent");
  });
});

describe("successors and dependency loss", () => {
  test("extends a parent monotonically and no-ops without new terminal evidence", () => {
    const { bridge, repository } = harness();
    for (const recordRef of ["a", "b", "c"]) {
      bridge.seedEligibleRecord(eligible(recordRef), LARGE_BUDGET);
    }
    bridge.seedEligibleRecord(eligible("p1", {
      posture: "derived",
      children: ["a", "b"],
      height: 1,
    }), LARGE_BUDGET);
    const extended = bridge.applyProposal({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "p1",
        statement: "A, B, and C now support the decision.",
        additionRefs: ["c"],
      },
      eligibleRecordRefs: ["p1", "a", "b", "c"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "extend-p1",
      budget: LARGE_BUDGET,
    });
    expect(extended).toMatchObject({
      operation: "extend_parent",
      predecessorRecordRef: "p1",
      record: { snapshot: { childRecordRefs: ["a", "b", "c"] } },
    });
    expect(repository.require("p1").snapshot.lifecycle).toBe("superseded");

    bridge.seedEligibleRecord(eligible("p-same", {
      posture: "derived",
      children: ["a", "b"],
      height: 1,
    }), LARGE_BUDGET);
    expect(bridge.applyProposal({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "p-same",
        statement: "Different words, same evidence.",
        additionRefs: ["a"],
      },
      eligibleRecordRefs: ["p-same", "a", "b"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "same-support",
      budget: LARGE_BUDGET,
    })).toEqual({ operation: "no_change", replayed: false, usage: {
      modelCalls: 0,
      visitedRecords: 0,
      createdRecords: 0,
      traversalWork: 0,
    } });
  });

  test("wraps a current parent as evidence without replacing it", () => {
    const { bridge, repository } = harness();
    for (const recordRef of ["a", "b", "c"]) {
      bridge.seedEligibleRecord(eligible(recordRef), LARGE_BUDGET);
    }
    bridge.seedEligibleRecord(eligible("p1", {
      posture: "derived",
      children: ["a", "b"],
      height: 1,
    }), LARGE_BUDGET);

    const wrapped = bridge.applyProposal({
      proposal: {
        operation: "wrap_parent",
        parentRecordRef: "p1",
        statement: "The decision and operating constraint form a broader topic.",
        additionRefs: ["c"],
      },
      eligibleRecordRefs: ["p1", "c"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "wrap-p1",
      budget: LARGE_BUDGET,
    });
    expect(wrapped).toMatchObject({
      operation: "wrap_parent",
      record: { snapshot: { childRecordRefs: ["c", "p1"], structuralHeight: 2 } },
    });
    expect(repository.require("p1").snapshot.lifecycle).toBe("current");
    expect(repository.successorsOf("p1")).toEqual([]);
    expect(repository.parentsOf("p1")).toHaveLength(1);
    expect(repository.parentsOf("a").map((entry) => entry.snapshot.recordRef))
      .toEqual(["p1"]);
  });

  test("supersedes immutably, records the distinct successor edge, and terminalizes once", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("b"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      statement: "Old conclusion",
      children: ["a", "b"],
      height: 1,
    }), LARGE_BUDGET);
    const result = bridge.applyProposal({
      proposal: {
        operation: "supersede_parent",
        parentRecordRef: "old",
        statement: "Corrected conclusion",
        childRecordRefs: ["a"],
      },
      eligibleRecordRefs: ["old", "a"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "correct",
      budget: LARGE_BUDGET,
    });
    expect(result.operation).toBe("supersede_parent");
    expect(repository.require("old").snapshot).toMatchObject({
      statement: "Old conclusion",
      childRecordRefs: ["a", "b"],
      lifecycle: "superseded",
    });
    expect(repository.successorsOf("old")).toEqual([{
      predecessorRecordRef: "old",
      successorRecordRef: "parent-1",
      relation: "supersedes",
    }]);
    expect(codeOf(() => bridge.applyProposal({
      proposal: {
        operation: "resolve_parent",
        parentRecordRef: "old",
        statement: "A second winner",
        childRecordRefs: ["b"],
      },
      eligibleRecordRefs: ["old", "b"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "second-winner",
      budget: LARGE_BUDGET,
    }))).toBe("invalid_lifecycle_transition");
  });

  test("resolves a parent and rejects a no-op successor", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      statement: "Same conclusion",
      children: ["a"],
      height: 1,
    }), LARGE_BUDGET);
    expect(codeOf(() => bridge.applyProposal({
      proposal: {
        operation: "resolve_parent",
        parentRecordRef: "old",
        statement: "Same conclusion",
        childRecordRefs: ["a"],
      },
      eligibleRecordRefs: ["old", "a"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "noop",
      budget: LARGE_BUDGET,
    }))).toBe("unchanged_successor");
    expect(repository.require("old").snapshot.lifecycle).toBe("current");
    expect(repository.list()).toHaveLength(2);
  });

  test("records a successful resolution as immutable history", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      statement: "The choice is under discussion.",
      children: ["a"],
      height: 1,
    }), LARGE_BUDGET);
    const result = bridge.applyProposal({
      proposal: {
        operation: "resolve_parent",
        parentRecordRef: "old",
        statement: "The choice is settled.",
        childRecordRefs: ["a"],
      },
      eligibleRecordRefs: ["old", "a"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "resolved",
      budget: LARGE_BUDGET,
    });
    expect(result.operation).toBe("resolve_parent");
    expect(repository.require("old").snapshot.lifecycle).toBe("resolved");
    expect(repository.predecessorsOf("parent-1")).toEqual([{
      predecessorRecordRef: "old",
      successorRecordRef: "parent-1",
      relation: "resolves",
    }]);
  });

  test("partial dependency loss creates a truthful one-child successor", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("remaining"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("lost"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      statement: "Old two-source conclusion",
      children: ["remaining", "lost"],
      height: 1,
    }), LARGE_BUDGET);
    const result = bridge.applyDependencyLoss({
      parentRecordRef: "old",
      unavailableChildRecordRefs: ["lost"],
      replacementStatement: "Conclusion supported by the remaining source only.",
      eligibleRecordRefs: ["old", "remaining"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "partial-loss",
      budget: LARGE_BUDGET,
    });
    expect(result.kind).toBe("partial_replacement");
    if (result.kind !== "partial_replacement") throw new Error("unreachable");
    expect(result.remainingChildRecordRefs).toEqual(["remaining"]);
    expect(result.successor.snapshot.childRecordRefs).toEqual(["remaining"]);
    expect(repository.require("old").snapshot.lifecycle).toBe("superseded");
  });

  test("total dependency loss sunsets without inventing a replacement", () => {
    const { bridge, repository, idCalls } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      children: ["a"],
      height: 1,
    }), LARGE_BUDGET);
    const input = {
      parentRecordRef: "old",
      unavailableChildRecordRefs: ["a"],
      eligibleRecordRefs: ["old"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "total-loss",
      budget: LARGE_BUDGET,
    } as const;
    expect(bridge.applyDependencyLoss(input)).toMatchObject({
      kind: "total_sunset",
      replayed: false,
      record: { snapshot: { recordRef: "old", lifecycle: "sunset" } },
    });
    expect(bridge.applyDependencyLoss(input)).toMatchObject({ kind: "total_sunset", replayed: true });
    expect(repository.list()).toHaveLength(2);
    expect(repository.successorsOf("old")).toEqual([]);
    expect(idCalls()).toBe(0);
  });

  test("dissolution sunsets and is idempotent", () => {
    const { bridge, repository } = harness();
    bridge.seedEligibleRecord(eligible("child"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("parent", {
      posture: "derived",
      children: ["child"],
      height: 1,
    }), LARGE_BUDGET);
    const input = {
      proposal: { operation: "dissolve_parent", parentRecordRef: "parent" } as const,
      eligibleRecordRefs: ["parent"],
      initialPublicationScope: audience("alice", "bob"),
      idempotencyKey: "dissolve",
      budget: LARGE_BUDGET,
    };
    expect(bridge.applyProposal(input).replayed).toBe(false);
    expect(repository.require("parent").snapshot.lifecycle).toBe("sunset");
    expect(bridge.applyProposal(input).replayed).toBe(true);
  });

  test("rejects a dependency-loss reference not owned by the parent", () => {
    const { bridge } = harness();
    bridge.seedEligibleRecord(eligible("a"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("not-child"), LARGE_BUDGET);
    bridge.seedEligibleRecord(eligible("old", {
      posture: "derived",
      children: ["a"],
      height: 1,
    }), LARGE_BUDGET);
    expect(codeOf(() => bridge.applyDependencyLoss({
      parentRecordRef: "old",
      unavailableChildRecordRefs: ["not-child"],
      eligibleRecordRefs: ["old", "a"],
      initialPublicationScope: audience("alice"),
      idempotencyKey: "bad-loss",
      budget: LARGE_BUDGET,
    }))).toBe("unknown_reference");
  });
});
