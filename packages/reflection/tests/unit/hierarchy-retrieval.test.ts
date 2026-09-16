import { describe, expect, test } from "bun:test";
import { InMemoryHierarchyRepository } from "../../src/graph/in-memory-repository";
import { SyntheticHierarchyBridge } from "../../src/graph/synthetic-bridge";
import {
  expandHierarchyEvidence,
  searchHierarchy,
} from "../../src/retrieval/hierarchy-retrieval";

const audience = { kind: "access" as const, humanRefs: ["casey", "alex"] };
const budget = {
  maxModelCalls: 10,
  maxVisitedRecords: 100,
  maxCreatedRecords: 10,
  maxTraversalWork: 100,
  maxStatementCharacters: 800,
};

function fixture(recordRef: string, statement: string) {
  return {
    snapshot: {
      recordRef,
      observedLogicalObjectRef: recordRef,
      observedContentFingerprint: `fingerprint:${recordRef}`,
      posture: "derived" as const,
      anchors: [],
      statement,
      sourceRefs: [],
      childRecordRefs: [],
      structuralHeight: 0,
      lifecycle: "current" as const,
    },
    audience,
    initialPublicationScope: audience,
  };
}

function graph() {
  const repository = new InMemoryHierarchyRepository();
  const bridge = new SyntheticHierarchyBridge({
    repository,
    idGenerator: ({ idempotencyKey }) => `parent-${idempotencyKey}`,
  });
  for (const record of [
    fixture("postgres", "Postgres provides transactional consistency."),
    fixture("neon", "Neon provides hosted Postgres operations."),
    fixture("leaf", "A valuable independent deployment note."),
  ]) bridge.seedEligibleRecord(record, budget);
  bridge.applyProposal({
    proposal: {
      operation: "create_parent",
      statement: "The database choice balanced Postgres consistency and Neon operations.",
      childRecordRefs: ["postgres", "neon"],
    },
    eligibleRecordRefs: ["postgres", "neon", "leaf"],
    initialPublicationScope: audience,
    idempotencyKey: "database",
    budget,
  });
  return { repository, bridge };
}

describe("all-height hierarchy retrieval", () => {
  test("filters before scoring and suppresses the less useful ancestor match", async () => {
    const { repository } = graph();
    const seen: string[][] = [];
    const response = await searchHierarchy({
      query: "why postgres",
      eligibleRecordRefs: ["postgres", "parent-database", "leaf"],
      repository,
      score: (_query, records) => {
        seen.push(records.map((record) => record.recordRef));
        return [
          { recordRef: "postgres", score: 0.95 },
          { recordRef: "parent-database", score: 0.9 },
          { recordRef: "leaf", score: 0.7 },
        ];
      },
      limit: 5,
      backlinkBudget: 1,
    });

    expect(seen).toEqual([["leaf", "parent-database", "postgres"]]);
    expect(response.results.map((result) => result.snapshot.recordRef)).toEqual([
      "postgres",
      "leaf",
    ]);
    expect(response.results[0]?.directParentRecordRefs).toEqual(["parent-database"]);
    expect(response.diagnostics).toMatchObject({
      eligibleCount: 3,
      scoredCount: 3,
      redundancySuppressedCount: 1,
    });
  });

  test("prefers the concise parent on equal utility without making height decisive", async () => {
    const { repository } = graph();
    const response = await searchHierarchy({
      query: "database choice",
      eligibleRecordRefs: ["postgres", "parent-database", "leaf"],
      repository,
      score: (_query, records) => records.map((record) => ({
        recordRef: record.recordRef,
        score: record.recordRef === "leaf" ? 0.99 : 0.9,
      })),
      limit: 5,
      backlinkBudget: 1,
    });
    expect(response.results.map((result) => result.snapshot.recordRef)).toEqual([
      "leaf",
      "parent-database",
    ]);
  });

  test("expands in dependency order with a resumable node budget", () => {
    const { repository } = graph();
    const eligible = ["parent-database", "postgres", "neon"];
    const first = expandHierarchyEvidence({
      rootRecordRef: "parent-database",
      eligibleRecordRefs: eligible,
      repository,
      maxDepth: 2,
      maxNodes: 1,
      maxEdges: 2,
    });
    expect(first.nodes.map((node) => node.snapshot.recordRef)).toEqual(["parent-database"]);
    expect(first.edges.map((edge) => edge.childRecordRef)).toEqual(["postgres", "neon"]);
    expect(first.continuation).toBeDefined();

    expect(first.continuation).toBeDefined();
    const second = expandHierarchyEvidence({
      rootRecordRef: "parent-database",
      eligibleRecordRefs: eligible,
      repository,
      maxNodes: 3,
      maxEdges: 2,
      continuation: first.continuation!,
    });
    expect(second.nodes.map((node) => node.snapshot.recordRef)).toEqual(["postgres", "neon"]);
    expect(second.continuation).toBeUndefined();
  });

  test("never reveals an ineligible dependency", () => {
    const { repository } = graph();
    const response = expandHierarchyEvidence({
      rootRecordRef: "parent-database",
      eligibleRecordRefs: ["parent-database", "postgres"],
      repository,
      maxDepth: 1,
      maxNodes: 3,
      maxEdges: 3,
    });
    expect(response.edges.map((edge) => edge.childRecordRef)).toEqual(["postgres"]);
    expect(JSON.stringify(response)).not.toContain("neon");
  });

  test("makes continuation progress when one parent exceeds the edge budget", () => {
    const repository = new InMemoryHierarchyRepository();
    const bridge = new SyntheticHierarchyBridge({
      repository,
      idGenerator: () => "wide-parent",
    });
    for (const ref of ["a", "b", "c"]) bridge.seedEligibleRecord(fixture(ref, ref), budget);
    bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "A wide parent.",
        childRecordRefs: ["a", "b", "c"],
      },
      eligibleRecordRefs: ["a", "b", "c"],
      initialPublicationScope: audience,
      idempotencyKey: "wide",
      budget,
    });
    const eligible = ["wide-parent", "a", "b", "c"];
    const first = expandHierarchyEvidence({
      rootRecordRef: "wide-parent",
      eligibleRecordRefs: eligible,
      repository,
      maxDepth: 1,
      maxNodes: 4,
      maxEdges: 1,
    });
    expect(first.edges.map((edge) => edge.childRecordRef)).toEqual(["a"]);
    expect(first.continuation).toBeDefined();
    const second = expandHierarchyEvidence({
      rootRecordRef: "wide-parent",
      eligibleRecordRefs: eligible,
      repository,
      maxNodes: 4,
      maxEdges: 1,
      continuation: first.continuation!,
    });
    expect(second.edges.map((edge) => edge.childRecordRef)).toEqual(["b"]);
    const third = expandHierarchyEvidence({
      rootRecordRef: "wide-parent",
      eligibleRecordRefs: eligible,
      repository,
      maxNodes: 4,
      maxEdges: 1,
      continuation: second.continuation!,
    });
    expect(third.edges.map((edge) => edge.childRecordRef)).toEqual(["c"]);
  });
});
