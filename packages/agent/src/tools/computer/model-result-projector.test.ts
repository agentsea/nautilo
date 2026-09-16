import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import { projectSemanticComputerResult } from "./model-result-projector";

describe("generic Host result projector", () => {
  test("rejects malformed Host bytes without exposing structural details", () => {
    const value: unknown = JSON.parse(projectSemanticComputerResult("computer_observe", "not json"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected projected object");
    const presentation = (value as Record<string, unknown>)["presentation"];
    if (presentation === null || typeof presentation !== "object" || Array.isArray(presentation)) throw new Error("expected presentation");
    expect((presentation as Record<string, unknown>)["summary"]).toContain("Observe the current state");
    expect(JSON.stringify(value)).not.toContain("descriptor");
  });

  test("projects a recoverable native observation failure through the signed contract", () => {
    const projected = JSON.parse(projectSemanticComputerResult("computer_observe", JSON.stringify({
      kind: "result",
      protocol: { major: 3, minor: 0 },
      requestId: "request-stale-observe",
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 5 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      settlement: "not_completed",
      result: {
        version: 1,
        operation: "application_windows",
        outcome: {
          version: 1,
          phase: "observe",
          retrySafety: "observe_before_retry",
          stateChangeCertainty: "not_applicable",
          providerCondition: "ready",
          targetCondition: "stale",
          recovery: ["observe_again"],
        },
      },
    }))) as Record<string, unknown>;

    expect(projected).toMatchObject({
      ok: false,
      settlement: "not_completed",
      result: {
        version: 1,
        operation: "application_windows",
        outcome: { targetCondition: "stale", recovery: ["observe_again"] },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("was not recognized");
  });

  test("presents validated partial success as the actual outcome", () => {
    const projected = JSON.parse(projectSemanticComputerResult("computer_observe", JSON.stringify({
      kind: "result",
      protocol: { major: 3, minor: 0 },
      requestId: "request-partial-observe",
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 5 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      settlement: "completed",
      result: {
        version: 1,
        operation: "desktop_state",
        context: `dctx_${"a".repeat(43)}`,
        completeness: "partial",
        discovered: 1,
        returned: 0,
        omitted: 1,
        boundary: { kind: "response_limit", retryable: true },
        uninspected: null,
        continuation: null,
        alternatives: [{ kind: "observe_again", available: true }],
        targets: [],
        applicationTargets: { discovered: 0, returned: 0, omitted: 0, targets: [] },
        outcome: {
          version: 1, phase: "observe", retrySafety: "safe",
          stateChangeCertainty: "not_applicable", providerCondition: "ready",
          targetCondition: "current", recovery: ["retry_same_request"],
        },
      },
    }))) as Record<string, unknown>;
    expect(projected).toMatchObject({
      ok: true,
      settlement: "completed",
      presentation: { summary: "Computer Use completed with a partial result. Continue from the returned result where available." },
    });
  });

  test("projects the strict broker-level Host failure without adding it to every tool contract", () => {
    const base = {
      kind: "result",
      protocol: { major: 3, minor: 0 },
      requestId: "request-host-failure",
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 5 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      settlement: "failed",
      result: { status: "host_rejected", reason: "host_failure" },
    } as const;
    const projected = JSON.parse(projectSemanticComputerResult("computer_observe", JSON.stringify(base))) as Record<string, unknown>;
    expect(projected).toMatchObject({
      ok: false,
      settlement: "failed",
      presentation: { summary: "Computer Use Host could not complete the request. Observe current state before continuing." },
      result: { status: "host_rejected", reason: "host_failure" },
    });
    expect(JSON.stringify(projected)).not.toContain("was not recognized");

    const mismatched = JSON.parse(projectSemanticComputerResult("computer_observe", JSON.stringify({ ...base, settlement: "completed" }))) as Record<string, unknown>;
    expect((mismatched["presentation"] as Record<string, unknown>)["summary"]).toContain("was not recognized");
    const decorated = JSON.parse(projectSemanticComputerResult("computer_observe", JSON.stringify({
      ...base,
      result: { ...base.result, providerText: "must not cross" },
    }))) as Record<string, unknown>;
    expect((decorated["presentation"] as Record<string, unknown>)["summary"]).toContain("was not recognized");
    expect(JSON.stringify(decorated)).not.toContain("must not cross");

    const mutating = JSON.parse(projectSemanticComputerResult("computer_do", JSON.stringify({
      ...base,
      contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
      settlement: "unknown_completion",
    }))) as Record<string, unknown>;
    expect(mutating).toMatchObject({
      ok: false,
      settlement: "unknown_completion",
      presentation: { summary: "Computer Use Host lost completion certainty. Observe current state and do not replay the mutation." },
    });
    const legacyMutating = JSON.parse(projectSemanticComputerResult("computer_do", JSON.stringify({
      ...base,
      contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
      settlement: "failed",
    }))) as Record<string, unknown>;
    expect(legacyMutating).toMatchObject({
      ok: false,
      settlement: "unknown_completion",
      presentation: { summary: "Computer Use Host lost completion certainty. Observe current state and do not replay the mutation." },
    });
  });
});
