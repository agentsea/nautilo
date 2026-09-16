import { describe, expect, test } from "bun:test";
import { strictShadowProtectedContentRequiredErrorSchema } from "@nautilo/api-client/browser";

import {
  classifyHumanDeviceMembershipState,
  enforceStrictShadowDecision,
  requireStrictShadowConsumer,
  StrictShadowEnforcementError,
  type StrictShadowBoundaryDecision,
} from "../../src/transition/strict-shadow-enforcement.ts";

const decision = (
  state: StrictShadowBoundaryDecision["state"],
  reason: StrictShadowBoundaryDecision["reason"],
  retryable = false,
): StrictShadowBoundaryDecision => Object.freeze({
  boundaryId: "conversation.read.http_history",
  family: "message",
  operation: "read",
  actorClass: "human",
  state,
  reason,
  retryable,
  policyRevision: 4,
});

describe("Strict Shadow enforcement", () => {
  test("preserves a typed deadline as a fail-closed terminal rejection", () => {
    const result = enforceStrictShadowDecision({ mode: "shadow_encryption", shadowBehavior: "strict", revision: 4 },
      decision("failed", "deadline_expired"));
    expect(result).toMatchObject({ disposition: "reject", decision: { reason: "deadline_expired" } });
    expect(() => requireStrictShadowConsumer(result)).toThrow(StrictShadowEnforcementError);
    expect(strictShadowProtectedContentRequiredErrorSchema.parse({ error: "strict_shadow_protected_content_required",
      state: "failed", reason: "deadline_expired", retryable: false })).toMatchObject({ reason: "deadline_expired" });
  });

  test("keeps plaintext-only ordinary and prefers verified bytes in Shadow", () => {
    expect(enforceStrictShadowDecision({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 4,
    }, decision("verified", "none"))).toMatchObject({ disposition: "ordinary" });
    expect(enforceStrictShadowDecision({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 4,
    }, decision("verified", "none"))).toMatchObject({ disposition: "protected" });
  });

  test("allows one ordinary substitute only in Fallback Shadow", () => {
    const unavailable = decision("failed", "integrity_failure");
    expect(enforceStrictShadowDecision({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 4,
    }, unavailable)).toMatchObject({ disposition: "ordinary" });
    expect(enforceStrictShadowDecision({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 4,
    }, unavailable)).toMatchObject({ disposition: "reject" });
  });

  test("never allows an ordinary substitute in Full regardless of Shadow behavior", () => {
    for (const shadowBehavior of ["fallback", "strict"] as const) {
      const policy = { mode: "encrypted_only" as const, shadowBehavior, revision: 4 };
      expect(enforceStrictShadowDecision(
        policy,
        decision("verified", "none"),
      )).toMatchObject({ disposition: "protected" });
      expect(enforceStrictShadowDecision(
        policy,
        decision("waiting_for_authority", "domain_authority_converging", true),
      )).toMatchObject({ disposition: "withhold" });
      expect(enforceStrictShadowDecision(
        policy,
        decision("repairing", "missing_protected_sibling", true),
      )).toMatchObject({ disposition: "withhold" });
      for (const unavailable of [
        decision("unsupported", "unsupported_operation"),
        decision("failed", "integrity_failure"),
        { ...decision("verified", "none"), policyRevision: 3 },
      ]) {
        expect(enforceStrictShadowDecision(policy, unavailable)).toMatchObject({
          disposition: "reject",
        });
      }
    }
  });

  test("withholds legitimate waits and active repair in Strict", () => {
    for (const pending of [
      decision("waiting_for_authority", "domain_authority_converging", true),
      decision("repairing", "missing_protected_sibling", true),
    ]) {
      const result = enforceStrictShadowDecision({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 4,
      }, pending);
      expect(result.disposition).toBe("withhold");
      expect(() => requireStrictShadowConsumer(result)).toThrow(
        StrictShadowEnforcementError,
      );
    }
  });

  test("fails stale and malformed decisions closed only in Strict", () => {
    const stale = { ...decision("verified", "none"), policyRevision: 3 };
    const fallback = enforceStrictShadowDecision({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 4,
    }, stale);
    expect(fallback).toMatchObject({
      disposition: "ordinary",
      decision: { state: "unsupported", reason: "stale_authority" },
    });
    expect(enforceStrictShadowDecision({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 4,
    }, stale)).toMatchObject({ disposition: "reject" });
  });

  test("maps only converging MLS membership to yellow", () => {
    for (const state of ["pending", "welcome_pending", "catching_up"] as const) {
      expect(classifyHumanDeviceMembershipState(state)).toEqual({
        state: "waiting_for_authority",
        reason: "device_membership_converging",
        retryable: true,
      });
    }
    expect(classifyHumanDeviceMembershipState("current")).toEqual({
      state: "verified",
      reason: "none",
      retryable: false,
    });
    expect(classifyHumanDeviceMembershipState("removed")).toEqual({
      state: "failed",
      reason: "device_removed",
      retryable: false,
    });
    expect(classifyHumanDeviceMembershipState("absent")).toEqual({
      state: "failed",
      reason: "device_not_enrolled",
      retryable: false,
    });
  });
});
