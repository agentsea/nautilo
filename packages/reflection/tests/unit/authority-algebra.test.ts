import { describe, expect, test } from "bun:test";

import type {
  AuthorityAlgebraResult,
  AuthorityLeafAlternatives,
  EffectiveAudienceAlternative,
} from "../../src/contracts/authority";
import { AuthorityAlgebraError } from "../../src/contracts/authority";
import {
  advanceAuthorityAlternatives,
  classifyAuthorityRepresentation,
  invocationAudienceIsEligible,
} from "../../src/authority/alternative-algebra";

const audience = (
  humanRefs: readonly string[],
  includesPublicBoundary = false,
): EffectiveAudienceAlternative => ({ humanRefs, includesPublicBoundary });

function finish(
  leaves: readonly AuthorityLeafAlternatives[],
  maxOperations: number,
): Extract<AuthorityAlgebraResult, { status: "complete" }> {
  let continuation: string | undefined;
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const result = advanceAuthorityAlternatives({
      leaves,
      budget: { maxOperations },
      ...(continuation === undefined ? {} : { continuation }),
    });
    if (result.status === "complete") return result;
    continuation = result.continuation;
  }
  throw new Error("authority computation did not finish");
}

describe("authority alternative algebra", () => {
  test("keeps attachment audiences disjunctive and intersects across leaves", () => {
    const result = finish([
      {
        terminalAuthorityLeafHandle: "leaf-1",
        alternatives: [audience(["casey", "sam"]), audience(["alex", "sam"])],
      },
      {
        terminalAuthorityLeafHandle: "leaf-2",
        alternatives: [audience(["casey", "alex"]), audience(["sam"])],
      },
    ], 100);
    expect(result.outcome).toEqual({
      kind: "available",
      alternatives: [audience(["alex"]), audience(["casey"]), audience(["sam"])],
    });
  });

  test("prunes dominated alternatives including the virtual public marker", () => {
    const result = finish([{
      terminalAuthorityLeafHandle: "leaf",
      alternatives: [
        audience(["a"]),
        audience(["a", "b"]),
        audience(["a", "b"], true),
        audience(["a", "b"], true),
      ],
    }], 100);
    expect(result.outcome).toEqual({
      kind: "available",
      alternatives: [audience(["a", "b"], true)],
    });
    expect(result.metrics.dominancePrunedCount).toBe(3);
  });

  test("ANDs the public bit and applies the invocation subset rule", () => {
    const result = finish([
      { terminalAuthorityLeafHandle: "one", alternatives: [audience(["a", "b"], true)] },
      { terminalAuthorityLeafHandle: "two", alternatives: [audience(["a", "b"], false)] },
    ], 100);
    expect(result.outcome).toEqual({
      kind: "available",
      alternatives: [audience(["a", "b"], false)],
    });
    if (result.outcome.kind !== "available") throw new Error("unreachable");
    expect(invocationAudienceIsEligible(audience(["a"]), result.outcome.alternatives)).toBe(true);
    expect(invocationAudienceIsEligible(audience(["a"], true), result.outcome.alternatives)).toBe(false);
    expect(invocationAudienceIsEligible(audience(["a", "b", "c"]), result.outcome.alternatives)).toBe(false);
  });

  test("discards zero-Human results even when the public bit survives", () => {
    const result = finish([
      { terminalAuthorityLeafHandle: "one", alternatives: [audience(["a"], true)] },
      { terminalAuthorityLeafHandle: "two", alternatives: [audience(["b"], true)] },
    ], 100);
    expect(result.outcome).toEqual({ kind: "unavailable", reason: "no_effective_audience" });
  });

  test("pauses and resumes to the byte-for-byte same canonical result", () => {
    const leaves = [
      {
        terminalAuthorityLeafHandle: "one",
        alternatives: [audience(["a", "b"]), audience(["c", "d"])],
      },
      {
        terminalAuthorityLeafHandle: "two",
        alternatives: [audience(["a", "c"]), audience(["b", "d"])],
      },
    ] as const;
    const direct = finish(leaves, 100);
    const resumed = finish(leaves, 1);
    expect(resumed.outcome).toEqual(direct.outcome);
    expect(resumed.metrics.operations).toBe(direct.metrics.operations);
    expect(resumed.metrics.finalAlternativeCount).toBe(4);
  });

  test("rejects checkpoint reuse with different authority input", () => {
    const first = advanceAuthorityAlternatives({
      leaves: [{ terminalAuthorityLeafHandle: "one", alternatives: [audience(["a"])] }],
      budget: { maxOperations: 1 },
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("unreachable");
    expect(() => advanceAuthorityAlternatives({
      leaves: [{ terminalAuthorityLeafHandle: "one", alternatives: [audience(["b"])] }],
      budget: { maxOperations: 1 },
      continuation: first.continuation,
    })).toThrow(AuthorityAlgebraError);
  });

  test("retains complete over-capacity results and classifies them uniformly", () => {
    const humanRefs = Array.from({ length: 24 }, (_, index) => `h${String(index).padStart(2, "0")}`);
    const alternatives: EffectiveAudienceAlternative[] = [];
    for (let left = 0; left < humanRefs.length; left += 1) {
      for (let right = left + 1; right < humanRefs.length; right += 1) {
        alternatives.push(audience([humanRefs[left] ?? "", humanRefs[right] ?? ""]));
      }
    }
    const result = finish([{ terminalAuthorityLeafHandle: "wide", alternatives }], 17);
    expect(result.outcome.kind).toBe("available");
    if (result.outcome.kind !== "available") throw new Error("unreachable");
    expect(result.outcome.alternatives).toHaveLength(276);
    expect(classifyAuthorityRepresentation(result.outcome.alternatives.length)).toEqual({
      kind: "unavailable",
      reason: "representation_capacity_exceeded",
      measuredAlternativeCount: 276,
    });
  });
});
