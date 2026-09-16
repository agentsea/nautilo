import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANDIDATE_POLICY_V1,
  selectSemanticNeighbors,
} from "../../src/organizer/candidate-policy";
import {
  parseReflectionEvalMode,
  runReflectionCandidateEvaluation,
} from "../evals/reflection-candidate-policy.eval";
import { REFLECTION_CANDIDATE_CORPUS } from "../evals/reflection-candidate-policy/corpus";
import { evaluateReflectionCandidatePolicies } from "../evals/reflection-candidate-policy/evaluator";
import {
  renderReflectionDecisionMarkdown,
  renderReflectionMachineReport,
} from "../evals/reflection-candidate-policy/report";
import {
  ReflectionCorpusValidationError,
  validateReflectionCandidateCorpus,
} from "../evals/reflection-candidate-policy/validation";
import type {
  AggregateEvaluationResult,
  CandidateFixture,
  CandidatePolicyId,
  EvaluationMode,
  ReflectionCandidateCorpus,
  SyntheticRecord,
} from "../evals/reflection-candidate-policy/types";

const evaluate = () =>
  evaluateReflectionCandidatePolicies(REFLECTION_CANDIDATE_CORPUS);

function candidateResult(
  policyId: CandidatePolicyId,
  mode: EvaluationMode,
  bound: number,
): AggregateEvaluationResult {
  const result = evaluate().candidatePolicies.find((candidate) =>
    candidate.id === policyId
    && candidate.mode === mode
    && candidate.bound === bound
  );
  if (!result) throw new Error(`missing ${policyId}/${mode}/${bound}`);
  return result;
}

function replaceFixture(
  fixtureId: string,
  replace: (fixture: CandidateFixture) => CandidateFixture,
): ReflectionCandidateCorpus {
  return {
    ...REFLECTION_CANDIDATE_CORPUS,
    fixtures: REFLECTION_CANDIDATE_CORPUS.fixtures.map((fixture) =>
      fixture.id === fixtureId ? replace(fixture) : fixture
    ),
  };
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("Reflection Wave 1 candidate-policy evaluation", () => {
  test("the selected package policy rejects duplicate eligible references", () => {
    expect(() => selectSemanticNeighbors("same_room", [
      { recordRef: "same", score: 0.9 },
      { recordRef: "same", score: 0.8 },
    ])).toThrow("references must be unique");
  });

  describe("versioned corpus validation", () => {
    test("accepts the committed authority-qualified scenario corpus", () => {
      const corpus = validateReflectionCandidateCorpus(REFLECTION_CANDIDATE_CORPUS);
      expect(corpus.fixtures).toHaveLength(13);
      expect(corpus.boundGrid).toEqual([2, 4, 8]);
      expect(new Set(corpus.fixtures.map((fixture) => fixture.mode))).toEqual(
        new Set(["same_room", "cross_room"]),
      );
    });

    test("rejects unknown fields before evaluation", () => {
      expect(() =>
        validateReflectionCandidateCorpus({
          ...REFLECTION_CANDIDATE_CORPUS,
          unexpectedPolicy: "hidden",
        })
      ).toThrow(ReflectionCorpusValidationError);
    });

    test("validates candidate bounds in numeric order", () => {
      const corpus = {
        ...REFLECTION_CANDIDATE_CORPUS,
        boundGrid: [2, 10, 4],
      };
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(
        /bound grid must be sorted and unique/,
      );
    });

    test("rejects duplicate Records and unknown relationships", () => {
      const first = REFLECTION_CANDIDATE_CORPUS.fixtures[0]!;
      const duplicateRecord = {
        ...first,
        records: [...first.records, first.records[0]!],
        requiredCandidateIds: ["postgres-decision.unknown"],
      };
      expect(() =>
        validateReflectionCandidateCorpus(
          replaceFixture(first.id, () => duplicateRecord),
        )
      ).toThrow(/duplicate Record|unknown required candidate/);
    });

    test("rejects Record identity reuse across independent fixtures", () => {
      const corpus = replaceFixture("valuable-leaf", (fixture) => ({
        ...fixture,
        changedRecordId: "postgres-decision.decision",
        records: fixture.records.map((record, index) =>
          index === 0 ? { ...record, id: "postgres-decision.decision" } : record
        ),
      }));
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(
        /duplicate corpus Record postgres-decision\.decision/,
      );
    });

    test("rejects cyclic existing-parent structure", () => {
      const fixtureId = "multi-parent-reuse";
      const corpus = replaceFixture(fixtureId, (fixture) => {
        const first = fixture.records[0]!;
        const second = fixture.records[1]!;
        const records = fixture.records.map((record) => {
          if (record.id === first.id) return { ...record, parentIds: [second.id] };
          if (record.id === second.id) return { ...record, parentIds: [first.id] };
          return record;
        });
        return { ...fixture, records };
      });
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(/cycle/);
    });

    test("rejects conflicting Domain and Namespace authority facts", () => {
      const fixtureId = "valuable-leaf";
      const corpus = replaceFixture(fixtureId, (fixture) => {
        const records = fixture.records.map((record, index) =>
          index === 1
            ? {
              ...record,
              audiencePaths: [{
                ...record.audiencePaths[0]!,
                humanIds: ["human-alice"],
              }],
            }
            : record
        );
        return { ...fixture, records };
      });
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(
        /conflicting Human audiences/,
      );
    });

    test("rejects required candidates that authority or lifecycle excludes", () => {
      const fixtureId = "partial-dependency-loss";
      const corpus = replaceFixture(fixtureId, (fixture) => ({
        ...fixture,
        requiredCandidateIds: [
          ...fixture.requiredCandidateIds,
          "partial-dependency-loss.removed-cost-report",
        ],
        forbiddenCandidateIds: [],
      }));
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(/ineligible/);
    });

    test("rejects an ineligible changed Record before policy evaluation", () => {
      const corpus = replaceFixture("valuable-leaf", (fixture) => ({
        ...fixture,
        records: fixture.records.map((record) =>
          record.id === fixture.changedRecordId
            ? { ...record, lifecycle: "sunset" }
            : record
        ),
      }));
      expect(() => validateReflectionCandidateCorpus(corpus)).toThrow(
        /changed Record is ineligible/,
      );
    });
  });

  describe("authority-first candidate preparation", () => {
    test("keeps attachment audiences disjunctive instead of Human-unioning them", () => {
      const result = candidateResult("semantic_neighbors", "cross_room", 2);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "multi-attached-leaf"
      )!;
      expect(fixture.selectedIds).toEqual([
        "multi-attached-leaf.all-three-support",
        "multi-attached-leaf.all-three-parent",
      ]);
      expect(JSON.stringify(fixture)).not.toContain(
        "multi-attached-leaf.multi-attached-support",
      );
      expect(fixture.gates.authorityLeakFree).toBe(true);
      expect(fixture.gates.forbiddenExposureFree).toBe(true);
    });

    test("requires the public marker when the invocation crosses a public boundary", () => {
      const result = candidateResult("semantic_neighbors", "cross_room", 2);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "public-private-boundary"
      )!;
      expect(fixture.selectedIds).toEqual([
        "public-private-boundary.public-rationale",
        "public-private-boundary.public-decoy",
      ]);
      expect(JSON.stringify(fixture)).not.toContain(
        "public-private-boundary.private-exact-match",
      );
      expect(fixture.gates.authorityLeakFree).toBe(true);
      expect(fixture.gates.forbiddenExposureFree).toBe(true);
    });

    test("never opens, scores, considers, or returns requester-private Records", () => {
      const result = candidateResult("semantic_neighbors", "cross_room", 2);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "invocation-not-requester"
      )!;
      const exposed = JSON.stringify({
        selectedIds: fixture.selectedIds,
        trace: fixture.trace,
      });
      expect(exposed).not.toContain("invocation-not-requester.casey-private");
      expect(exposed).not.toContain("invocation-not-requester.alex-private");
      expect(fixture.gates.authorityLeakFree).toBe(true);
      expect(fixture.gates.forbiddenExposureFree).toBe(true);
    });

    test("filters a sunset dependency before the fake embedding port", () => {
      const result = candidateResult("semantic_neighbors", "same_room", 4);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "partial-dependency-loss"
      )!;
      expect(JSON.stringify(fixture)).not.toContain("removed-cost-report");
      expect(fixture.selectedIds).toEqual([
        "partial-dependency-loss.portability",
        "partial-dependency-loss.transactions",
      ]);
    });

    test("makes forbidden exposure a hard failure even when recall passes", () => {
      const fixtureId = "invocation-not-requester";
      const corpus = replaceFixture(fixtureId, (fixture) => {
        const forbiddenId = "invocation-not-requester.casey-private";
        const records = fixture.records.map((record): SyntheticRecord =>
          record.id === forbiddenId
            ? {
              ...record,
              audiencePaths: [{
                namespaceId: fixture.invocation.namespaceId,
                domainId: fixture.invocation.domainId,
                humanIds: fixture.invocation.humanIds,
                includesPublicBoundary:
                  fixture.invocation.includesPublicBoundary,
              }],
            }
            : record
        );
        return { ...fixture, records };
      });
      const report = evaluateReflectionCandidatePolicies(corpus);
      const result = report.candidatePolicies.find((candidate) =>
        candidate.id === "semantic_neighbors"
        && candidate.mode === "cross_room"
        && candidate.bound === 2
      )!;
      const fixture = result.fixtures.find((item) => item.fixtureId === fixtureId)!;
      expect(fixture.gates.requiredRelationshipsReachable).toBe(true);
      expect(fixture.gates.forbiddenExposureFree).toBe(false);
      expect(fixture.gates.passed).toBe(false);
      expect(result.aggregate.hardGatesPassed).toBe(false);
    });
  });

  describe("baselines and candidate policies", () => {
    test("applies the accepted policy bounds, threshold, and stable tie order", () => {
      const candidates = [
        { recordRef: "record-c", score: 0.9 },
        { recordRef: "record-b", score: 0.8 },
        { recordRef: "record-a", score: 0.8 },
        { recordRef: "record-d", score: 0.7 },
        { recordRef: "record-e", score: 0.6 },
        { recordRef: "record-low", score: 0.49 },
      ];
      expect(selectSemanticNeighbors("same_room", candidates)).toEqual([
        { recordRef: "record-c", score: 0.9 },
        { recordRef: "record-a", score: 0.8 },
        { recordRef: "record-b", score: 0.8 },
        { recordRef: "record-d", score: 0.7 },
      ]);
      expect(selectSemanticNeighbors("cross_room", candidates)).toEqual([
        { recordRef: "record-c", score: 0.9 },
        { recordRef: "record-a", score: 0.8 },
      ]);
    });

    test("characterizes Memory, Journal/recent, and flat baselines separately", () => {
      const report = evaluate();
      expect(report.baselines).toHaveLength(6);
      const memory = report.baselines.find((result) =>
        result.id === "memory" && result.mode === "same_room"
      )!;
      const postgres = memory.fixtures.find((fixture) =>
        fixture.fixtureId === "postgres-decision"
      )!;
      expect(postgres.selectedIds).toEqual([
        "postgres-decision.requirements-memory",
      ]);
      const journal = report.baselines.find((result) =>
        result.id === "journal_recent" && result.mode === "same_room"
      )!;
      const leaf = journal.fixtures.find((fixture) =>
        fixture.fixtureId === "valuable-leaf"
      )!;
      expect(leaf.selectedIds).toContain("valuable-leaf.welcome");
      expect(report.baselines.some((result) => result.id === "flat_combined"))
        .toBe(true);
    });

    test("existing-parent routing recovers both multi-parent siblings", () => {
      const result = candidateResult("existing_parent", "same_room", 4);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "multi-parent-reuse"
      )!;
      expect(fixture.selectedIds).toContain("multi-parent-reuse.database-sibling");
      expect(fixture.selectedIds).toContain("multi-parent-reuse.deployment-sibling");
      expect(fixture.gates.passed).toBe(true);
    });

    test("temporal routing fails the close-but-unrelated trap at practical bounds", () => {
      const result = candidateResult("temporal_room_anchor", "same_room", 4);
      const fixture = result.fixtures.find((item) =>
        item.fixtureId === "temporal-anchor-trap"
      )!;
      expect(fixture.gates.requiredRelationshipsReachable).toBe(false);
      expect(fixture.selectedIds.every((id) => id.includes("near-"))).toBe(true);
    });

    test("semantic ties are stable and sorted by Record ID", () => {
      const fixtureId = "disagreement";
      const corpus = replaceFixture(fixtureId, (fixture) => ({
        ...fixture,
        semanticScores: {
          ...fixture.semanticScores,
          "disagreement.cost-risk-counterclaim": 0.9,
          "disagreement.usage-estimate": 0.9,
        },
      }));
      const report = evaluateReflectionCandidatePolicies(corpus);
      const result = report.candidatePolicies.find((candidate) =>
        candidate.id === "semantic_neighbors"
        && candidate.mode === "same_room"
        && candidate.bound === 4
      )!;
      const fixture = result.fixtures.find((item) => item.fixtureId === fixtureId)!;
      expect(fixture.selectedIds.slice(0, 2)).toEqual([
        "disagreement.cost-risk-counterclaim",
        "disagreement.usage-estimate",
      ]);
      expect(fixture.metrics.repeatStable).toBe(true);
    });
  });

  describe("recorded decision and deterministic artifacts", () => {
    test("selects semantic neighbors at the smallest passing bounds", () => {
      expect(evaluate().decisions).toEqual([
        expect.objectContaining({
          mode: "same_room",
          outcome: "selected",
          policyId: "semantic_neighbors",
          bound: CANDIDATE_POLICY_V1.sameRoomBound,
        }),
        expect.objectContaining({
          mode: "cross_room",
          outcome: "selected",
          policyId: "semantic_neighbors",
          bound: CANDIDATE_POLICY_V1.crossRoomBound,
        }),
      ]);
    });

    test("serializes byte-identically on repeated runs", () => {
      const first = evaluate();
      const second = evaluate();
      expect(renderReflectionMachineReport(first)).toBe(
        renderReflectionMachineReport(second),
      );
      expect(renderReflectionDecisionMarkdown(first)).toBe(
        renderReflectionDecisionMarkdown(second),
      );
    });

    test("committed reports expose none of the fixture-forbidden Record IDs", () => {
      const report = evaluate();
      const output = `${renderReflectionMachineReport(report)}\n${renderReflectionDecisionMarkdown(report)}`;
      for (const fixture of REFLECTION_CANDIDATE_CORPUS.fixtures) {
        for (const forbiddenId of fixture.forbiddenCandidateIds) {
          expect(output).not.toContain(forbiddenId);
        }
      }
    });

    test("the documented command validates both committed artifacts", async () => {
      expect(await runReflectionCandidateEvaluation("check")).toBe(0);
    });

    test("CLI modes are explicit and reject accidental live-style arguments", () => {
      expect(parseReflectionEvalMode([])).toBe("check");
      expect(parseReflectionEvalMode(["--check"])).toBe("check");
      expect(parseReflectionEvalMode(["--write"])).toBe("write");
      expect(parseReflectionEvalMode(["--print-json"])).toBe("print");
      expect(() => parseReflectionEvalMode(["--model", "anything"])).toThrow(
        /usage/,
      );
    });
  });

  describe("research-only dependency boundary", () => {
    test("production Reflection sources do not import the evaluation harness", () => {
      const sourceRoot = resolve(import.meta.dir, "../../src");
      for (const path of listTypeScriptFiles(sourceRoot)) {
        expect(readFileSync(path, "utf8")).not.toContain(
          "reflection-candidate-policy",
        );
      }
    });

    test("Reflection is the sole package owner of the candidate evaluation", () => {
      const reflectionEvalRoot = resolve(
        import.meta.dir,
        "../evals/reflection-candidate-policy",
      );
      const runtimeRoot = resolve(import.meta.dir, "../../../runtime");
      expect(existsSync(reflectionEvalRoot)).toBe(true);
      expect(
        existsSync(resolve(runtimeRoot, "tests/evals/reflection-candidate-policy")),
      ).toBe(false);
      expect(
        existsSync(
          resolve(runtimeRoot, "tests/evals/reflection-candidate-policy.eval.ts"),
        ),
      ).toBe(false);
      expect(
        existsSync(
          resolve(runtimeRoot, "tests/unit/reflection-candidate-policy-eval.test.ts"),
        ),
      ).toBe(false);
    });

    test("default evaluation code has no DB, provider, network, or server seam", () => {
      const evalRoot = resolve(import.meta.dir, "../evals/reflection-candidate-policy");
      const entryPath = resolve(
        import.meta.dir,
        "../evals/reflection-candidate-policy.eval.ts",
      );
      const sources = [entryPath, ...listTypeScriptFiles(evalRoot)]
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      expect(sources).not.toContain("@nautilo/db");
      expect(sources).not.toContain(["createDirect", "Db"].join(""));
      expect(sources).not.toContain("fetch(");
      expect(sources).not.toContain("invokeChatModel");
      expect(sources).not.toContain("startServer");
    });
  });
});
