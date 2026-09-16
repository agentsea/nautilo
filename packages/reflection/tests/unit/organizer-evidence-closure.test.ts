import { describe, expect, test } from "bun:test";

import {
  deriveOrganizerEvidenceClosure,
  isStrictOrganizerEvidenceSuperset,
  organizerEvidenceClosuresArePairwiseDisjoint,
  organizerEvidenceHasDependencyPath,
  type OrganizerEvidenceRecord,
} from "../../src/organizer/evidence-closure";

const budget = { maxVisitedRecords: 16, maxTraversalWork: 16 } as const;

function node(
  recordRef: string,
  childRecordRefs: readonly string[] = [],
  source = false,
  terminalEvidenceIdentity = childRecordRefs.length === 0,
): OrganizerEvidenceRecord {
  return {
    recordRef,
    terminalEvidenceIdentity,
    childRecordRefs,
    sourceDependencies: source
      ? [{
          sourceKind: "memory/v1",
          logicalSourceRef: `memory:${recordRef}`,
          observedRevision: "4",
          observedContentFingerprint: `sha256:${recordRef}`,
          terminalAuthorityLeafHandle: "must-not-enter-identity",
          authorityBearing: true,
        }]
      : [],
  };
}

describe("Organizer evidence closure", () => {
  test("uses terminal Record and exact authored-source coordinates only", () => {
    const records = new Map<string, OrganizerEvidenceRecord>([
      ["A", node("A")],
      ["B", node("B")],
      ["P1", node("P1", ["A", "B"], true)],
    ]);
    const closure = deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records,
      budget,
    });
    expect(closure.status).toBe("complete");
    if (closure.status !== "complete") return;
    expect(closure.identities).toEqual([
      { kind: "record", recordRef: "A" },
      { kind: "record", recordRef: "B" },
      {
        kind: "source",
        sourceKind: "memory/v1",
        logicalSourceRef: "memory:P1",
        observedRevision: "4",
        observedContentFingerprint: "sha256:P1",
      },
    ]);
    expect(JSON.stringify(closure.identities)).not.toContain("must-not-enter-identity");
  });

  test("recognizes strict growth and rejects equivalent direct wrappers", () => {
    const records = new Map<string, OrganizerEvidenceRecord>([
      ["A", node("A")],
      ["B", node("B")],
      ["C", node("C")],
      ["P1", node("P1", ["A", "B"])],
      ["Equivalent", node("Equivalent", ["A", "B"])],
    ]);
    const predecessor = deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records,
      budget,
    });
    const same = deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1", "Equivalent"],
      records,
      budget,
    });
    const grown = deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1", "C"],
      records,
      budget,
    });
    if (
      predecessor.status !== "complete"
      || same.status !== "complete"
      || grown.status !== "complete"
    ) throw new Error("expected complete fixture closures");
    expect(isStrictOrganizerEvidenceSuperset(same.identityKeys, predecessor.identityKeys))
      .toBe(false);
    expect(isStrictOrganizerEvidenceSuperset(grown.identityKeys, predecessor.identityKeys))
      .toBe(true);
  });

  test("does not treat a synthesized source-only parent as terminal evidence", () => {
    const records = new Map<string, OrganizerEvidenceRecord>([
      ["P1", node("P1", [], true, false)],
    ]);
    const closure = deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records,
      budget,
    });
    if (closure.status !== "complete") throw new Error("expected complete closure");
    expect(closure.identities).toEqual([{
      kind: "source",
      sourceKind: "memory/v1",
      logicalSourceRef: "memory:P1",
      observedRevision: "4",
      observedContentFingerprint: "sha256:P1",
    }]);
  });

  test("proves promotion independence and ancestor relationships", () => {
    const records = new Map<string, OrganizerEvidenceRecord>([
      ["A", node("A")],
      ["B", node("B")],
      ["C", node("C")],
      ["P1", node("P1", ["A", "B"])],
      ["P2", node("P2", ["B", "C"])],
    ]);
    const p1 = deriveOrganizerEvidenceClosure({ rootRecordRefs: ["P1"], records, budget });
    const p2 = deriveOrganizerEvidenceClosure({ rootRecordRefs: ["P2"], records, budget });
    const c = deriveOrganizerEvidenceClosure({ rootRecordRefs: ["C"], records, budget });
    if (p1.status !== "complete" || p2.status !== "complete" || c.status !== "complete") {
      throw new Error("expected complete fixture closures");
    }
    expect(organizerEvidenceClosuresArePairwiseDisjoint([
      p1.identityKeys,
      p2.identityKeys,
    ])).toBe(false);
    expect(organizerEvidenceClosuresArePairwiseDisjoint([
      p1.identityKeys,
      c.identityKeys,
    ])).toBe(true);
    expect(organizerEvidenceHasDependencyPath({
      from: "P1",
      target: "A",
      records,
      maxTraversalWork: 4,
    })).toBe("yes");
  });

  test("returns typed unavailable for missing, cyclic, or over-budget graphs", () => {
    const missing = new Map<string, OrganizerEvidenceRecord>([
      ["P1", node("P1", ["missing"])],
    ]);
    expect(deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records: missing,
      budget,
    })).toMatchObject({ status: "unavailable", reason: "record_unavailable" });

    const cyclic = new Map<string, OrganizerEvidenceRecord>([
      ["P1", node("P1", ["P2"])],
      ["P2", node("P2", ["P1"])],
    ]);
    expect(deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records: cyclic,
      budget,
    })).toMatchObject({ status: "unavailable", reason: "dependency_cycle" });

    expect(deriveOrganizerEvidenceClosure({
      rootRecordRefs: ["P1"],
      records: cyclic,
      budget: { maxVisitedRecords: 1, maxTraversalWork: 1 },
    })).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
  });
});
