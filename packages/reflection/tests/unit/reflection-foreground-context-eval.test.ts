import { describe, expect, test } from "bun:test";

import {
  evaluateForegroundContextPolicies,
  renderForegroundContextDecision,
  runForegroundContextEvaluation,
} from "../evals/reflection-foreground-context.eval";

describe("Reflection Wave 9 deterministic foreground-context evaluation", () => {
  test("selects the bounded semantic-first policy over both starving orders", () => {
    const report = evaluateForegroundContextPolicies();
    expect(report.hardGatesPassed).toBe(true);
    expect(report.selectedCandidate).toBe("balanced_semantic_first");
    expect(report.candidates.map((candidate) => ({
      id: candidate.candidate,
      passed: candidate.passed,
    }))).toEqual([
      { id: "balanced_semantic_first", passed: true },
      { id: "journal_first", passed: false },
      { id: "records_first", passed: false },
    ]);
    expect(renderForegroundContextDecision(report)).not.toContain("record:postgres-decision");
  });

  test("matches the reviewed committed artifacts", async () => {
    expect(await runForegroundContextEvaluation("check")).toBe(0);
  });
});
