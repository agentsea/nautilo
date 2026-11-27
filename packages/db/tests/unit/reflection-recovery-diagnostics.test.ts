import { describe, expect, test } from "bun:test";
import { classifyReflectionHeldProviderEvidence } from "../../src/queries/reflection-recovery-diagnostics";

const settled = {
  fundingKind: "service" as const,
  payerHumanId: null,
  providerRoute: "surplus" as const,
  model: "anthropic:test",
  actualCostUsd: "0.01",
  providerRequestId: "provider-request",
  attemptOutcome: "succeeded" as const,
  costState: "actual" as const,
  recoveryState: null,
};

describe("Reflection recovery diagnostics", () => {
  test("calls a terminal hold result-missing only for exact settled success-only wires", () => {
    expect(classifyReflectionHeldProviderEvidence([settled], "anthropic:test"))
      .toBe("provider_succeeded_result_missing");
    expect(classifyReflectionHeldProviderEvidence([], "anthropic:test"))
      .toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      { ...settled, attemptOutcome: null },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      { ...settled, model: "another:model" },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      settled,
      { ...settled, attemptOutcome: "failed", providerRequestId: null },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
  });

  test("accepts identifiable historical direct successes independent of spend certainty", () => {
    const directEstimated = {
      ...settled,
      fundingKind: "personal",
      providerRoute: "direct",
      actualCostUsd: null,
      costState: "estimated",
      recoveryState: "estimated",
    };
    expect(classifyReflectionHeldProviderEvidence([directEstimated], "anthropic:test"))
      .toBe("provider_succeeded_result_missing");
  });
});
