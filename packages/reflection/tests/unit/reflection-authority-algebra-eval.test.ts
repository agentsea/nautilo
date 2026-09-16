import { describe, expect, test } from "bun:test";

import { parseAuthorityAlgebraEvalMode } from "../evals/reflection-authority-algebra.eval";
import {
  evaluateAuthorityAlgebra,
  stableAuthorityAlgebraEvidence,
} from "../evals/reflection-authority-algebra/evaluator";

describe("authority algebra feasibility evaluation", () => {
  test("passes every committed hard gate", () => {
    const report = evaluateAuthorityAlgebra();
    expect(report.hardGatesPassed).toBe(true);
    expect(report.scenarios.map((scenario) => scenario.finalAlternativeCount)).toEqual([
      2,
      1,
      256,
      276,
    ]);
    expect(report.scenarios.every((scenario) => scenario.resumptions > 0)).toBe(true);
  });

  test("keeps environment-specific latency outside stable artifact comparison", () => {
    const report = evaluateAuthorityAlgebra();
    expect(JSON.stringify(stableAuthorityAlgebraEvidence(report))).not.toContain(
      "observedLatencyMs",
    );
  });

  test("accepts only explicit evaluation modes", () => {
    expect(parseAuthorityAlgebraEvalMode([])).toBe("check");
    expect(parseAuthorityAlgebraEvalMode(["--write"])).toBe("write");
    expect(parseAuthorityAlgebraEvalMode(["--print-json"])).toBe("print");
    expect(() => parseAuthorityAlgebraEvalMode(["--unknown"])).toThrow();
  });
});
