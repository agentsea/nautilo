import { describe, expect, test } from "bun:test";
import {
  classifyAuthPlan,
  type AuthPlanInput,
} from "../../../../deploy/contracts/auth-plan.ts";
import { buildAppliedAuthContract } from "../../../../deploy/contracts/applied-auth-contract.ts";
import { buildAuthContract, type AuthContract } from "../../../../deploy/contracts/auth.ts";

function withIncoming(
  overrides: Partial<AuthContract>,
  input: Omit<AuthPlanInput, "incoming">,
) {
  return classifyAuthPlan({
    ...input,
    incoming: { ...buildAuthContract(), ...overrides },
  });
}

describe("auth plan classification", () => {
  const incoming = buildAuthContract();
  const applied = buildAppliedAuthContract("2026-07-12T12:00:00.000Z", incoming);

  test("classifies an exact stamp and matching running image as compatible", () => {
    const plan = classifyAuthPlan({
      incoming,
      applied,
      liveLogtoEngineImage: incoming.logtoEngine.image,
    });

    expect(plan.classification).toBe("compatible");
    expect(plan.live.inspected).toBe(true);
    expect(plan.live.logtoEngineVersion).toBe(incoming.logtoEngine.minimumVersion);
  });

  test("fails closed when no durable stamp or running image exists", () => {
    expect(classifyAuthPlan({ incoming, applied: null }).classification).toBe("unknown");
    expect(classifyAuthPlan({ incoming, applied }).classification).toBe("unknown");
  });

  test("classifies non-session-affecting differences as additive reconciliation", () => {
    const plan = withIncoming(
      {
        hash: "b".repeat(64),
        impact: {
          requiresExplicitAuthReconcile: true,
          mayAffectExistingSessions: false,
        },
      },
      { applied, liveLogtoEngineImage: incoming.logtoEngine.image },
    );

    expect(plan.classification).toBe("reconcile-required-additive");
  });

  test("classifies session-affecting differences as disruptive", () => {
    const plan = withIncoming(
      {
        hash: "c".repeat(64),
        impact: {
          requiresExplicitAuthReconcile: true,
          mayAffectExistingSessions: true,
        },
      },
      { applied, liveLogtoEngineImage: incoming.logtoEngine.image },
    );

    expect(plan.classification).toBe("session-disruptive");
  });

  test("rejects a contract version older than the applied stamp", () => {
    const plan = withIncoming(
      { version: 1, hash: "d".repeat(64) },
      {
        applied: { ...applied, contractVersion: 2 },
        liveLogtoEngineImage: incoming.logtoEngine.image,
      },
    );

    expect(plan.classification).toBe("incompatible");
  });

  test("rejects an inspected engine below the incoming minimum", () => {
    const plan = classifyAuthPlan({
      incoming,
      applied,
      liveLogtoEngineImage: "ghcr.io/logto-io/logto:1.37.0",
    });

    expect(plan.classification).toBe("incompatible");
    expect(plan.live.inspected).toBe(true);
  });

  test("rejects a running image that differs from the contract", () => {
    const plan = classifyAuthPlan({
      incoming,
      applied,
      liveLogtoEngineImage: "ghcr.io/logto-io/logto:1.39.0",
    });

    expect(plan.classification).toBe("incompatible");
  });
});
