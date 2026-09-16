import type {
  LiveShadowEncryptionTransitionBehavior,
  LiveShadowSelectableEncryptionTransitionMode,
} from "./encryption-transition-policy.ts";

export const STRICT_SHADOW_STATES = Object.freeze([
  "verified",
  "waiting_for_authority",
  "repairing",
  "unsupported",
  "failed",
] as const);
export type StrictShadowState = typeof STRICT_SHADOW_STATES[number];

export const STRICT_SHADOW_ACTOR_CLASSES = Object.freeze([
  "human",
  "agent",
  "conductor",
  "tool",
  "background",
] as const);
export type StrictShadowActorClass =
  typeof STRICT_SHADOW_ACTOR_CLASSES[number];

export const STRICT_SHADOW_REASONS = Object.freeze([
  "none",
  "device_membership_converging",
  "domain_authority_converging",
  "namespace_authority_converging",
  "missing_protected_sibling",
  "unsupported_operation",
  "device_not_enrolled",
  "device_stale",
  "device_removed",
  "recovery_required",
  "authority_unrecoverable",
  "integrity_failure",
  "parity_mismatch",
  "publication_failure",
  "deadline_expired",
  "stale_authority",
  "unknown_boundary",
  "unknown_result",
] as const);
export type StrictShadowReason = typeof STRICT_SHADOW_REASONS[number];

export type StrictShadowBoundaryDecision = Readonly<{
  boundaryId: string;
  family: string;
  operation: string;
  actorClass: StrictShadowActorClass;
  state: StrictShadowState;
  reason: StrictShadowReason;
  retryable: boolean;
  policyRevision: number;
}>;

export type StrictShadowEnforcementPolicy = Readonly<{
  mode: LiveShadowSelectableEncryptionTransitionMode;
  shadowBehavior: LiveShadowEncryptionTransitionBehavior;
  revision: number;
}>;

export type StrictShadowEnforcementResult = Readonly<{
  disposition: "ordinary" | "protected" | "withhold" | "reject";
  decision: StrictShadowBoundaryDecision;
}>;

export class StrictShadowEnforcementError extends Error {
  readonly code = "strict_shadow_protected_content_required";

  constructor(readonly decision: StrictShadowBoundaryDecision) {
    super(
      `Strict Shadow rejected ${decision.boundaryId}: ${decision.state}/${decision.reason}`,
    );
    this.name = "StrictShadowEnforcementError";
  }
}
function validDecision(value: StrictShadowBoundaryDecision): boolean {
  return value.boundaryId.length > 0
    && value.family.length > 0
    && value.operation.length > 0
    && Number.isSafeInteger(value.policyRevision)
    && value.policyRevision >= 0
    && STRICT_SHADOW_ACTOR_CLASSES.includes(value.actorClass)
    && STRICT_SHADOW_STATES.includes(value.state)
    && STRICT_SHADOW_REASONS.includes(value.reason)
    && (value.state === "verified") === (value.reason === "none")
    && (value.state !== "waiting_for_authority" || value.retryable)
    && (value.state !== "repairing" || value.retryable);
}

/**
 * One content-free policy decision for every plaintext consumer boundary.
 * The caller may render or invoke only the returned disposition.
 */
export function enforceStrictShadowDecision(
  policy: StrictShadowEnforcementPolicy,
  decision: StrictShadowBoundaryDecision,
): StrictShadowEnforcementResult {
  const normalized = validDecision(decision)
    && decision.policyRevision === policy.revision
    ? decision
    : Object.freeze({
        boundaryId: decision.boundaryId || "unknown",
        family: decision.family || "unknown",
        operation: decision.operation || "unknown",
        actorClass: STRICT_SHADOW_ACTOR_CLASSES.includes(decision.actorClass)
          ? decision.actorClass
          : "background" as const,
        state: "unsupported" as const,
        reason: decision.policyRevision === policy.revision
          ? "unknown_result" as const
          : "stale_authority" as const,
        retryable: false,
        policyRevision: policy.revision,
      });

  if (policy.mode === "plaintext_only") {
    return Object.freeze({ disposition: "ordinary" as const, decision: normalized });
  }
  if (normalized.state === "verified") {
    return Object.freeze({ disposition: "protected" as const, decision: normalized });
  }
  if (
    normalized.state === "waiting_for_authority"
    || normalized.state === "repairing"
  ) {
    if (policy.mode === "encrypted_only" || policy.shadowBehavior === "strict") {
      return Object.freeze({ disposition: "withhold" as const, decision: normalized });
    }
  }
  if (policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback") {
    return Object.freeze({ disposition: "ordinary" as const, decision: normalized });
  }
  return Object.freeze({ disposition: "reject" as const, decision: normalized });
}

export function requireStrictShadowConsumer(
  result: StrictShadowEnforcementResult,
): "ordinary" | "protected" {
  if (result.disposition === "ordinary" || result.disposition === "protected") {
    return result.disposition;
  }
  throw new StrictShadowEnforcementError(result.decision);
}

export type HumanDeviceMembershipState =
  | "absent"
  | "unbound"
  | "pending"
  | "welcome_pending"
  | "catching_up"
  | "current"
  | "stale"
  | "removed";

export function classifyHumanDeviceMembershipState(
  state: HumanDeviceMembershipState,
): Readonly<Pick<StrictShadowBoundaryDecision, "state" | "reason" | "retryable">> {
  switch (state) {
    case "current":
      return Object.freeze({ state: "verified", reason: "none", retryable: false });
    case "pending":
    case "welcome_pending":
    case "catching_up":
      return Object.freeze({
        state: "waiting_for_authority",
        reason: "device_membership_converging",
        retryable: true,
      });
    case "stale":
      return Object.freeze({ state: "failed", reason: "device_stale", retryable: false });
    case "removed":
      return Object.freeze({ state: "failed", reason: "device_removed", retryable: false });
    case "absent":
    case "unbound":
      return Object.freeze({
        state: "failed",
        reason: "device_not_enrolled",
        retryable: false,
      });
  }
}
