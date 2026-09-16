import type { FastifyInstance } from "fastify";
import {
  getEncryptionTransitionPolicy,
  recordStrictShadowBoundaryHealth,
  type LiveShadowEncryptionTransitionPolicy,
} from "@nautilo/db";
import {
  enforceStrictShadowDecision,
  type StrictShadowBoundaryDecision,
  type StrictShadowEnforcementPolicy,
  type StrictShadowEnforcementResult,
} from "@nautilo/lattice-bridge";
import { STRICT_SHADOW_BOUNDARY_REGISTRY } from
  "@nautilo/encryption-invariants/node";
import { warn } from "@nautilo/logger";

import { getServerDirectDb } from "./server-direct-db";

const registered = new Map(
  STRICT_SHADOW_BOUNDARY_REGISTRY.map((boundary) => [boundary.id, boundary]),
);

export function classifyLiveShadowBoundaryFailure(reason: string): Readonly<{
  state: StrictShadowBoundaryDecision["state"];
  reason: StrictShadowBoundaryDecision["reason"];
  retryable: boolean;
}> {
  if (reason === "namespace_unavailable" || reason === "recipient_sync_required") {
    return Object.freeze({
      state: "waiting_for_authority",
      reason: "namespace_authority_converging",
      retryable: true,
    });
  }
  if (reason === "domain_unavailable" || reason === "agent_authority_unavailable") {
    return Object.freeze({
      state: "waiting_for_authority",
      reason: "domain_authority_converging",
      retryable: true,
    });
  }
  if (reason === "device_unavailable" || reason === "profile_unavailable") {
    return Object.freeze({
      state: "failed",
      reason: "device_not_enrolled",
      retryable: false,
    });
  }
  if (reason === "content_invalid" || reason === "human_parity_failed") {
    return Object.freeze({
      state: "failed",
      reason: "parity_mismatch",
      retryable: false,
    });
  }
  if (reason === "plan_stale" || reason === "authority_stale") {
    return Object.freeze({
      state: "failed",
      reason: "stale_authority",
      retryable: false,
    });
  }
  if (
    reason === "human_persistence_failed"
    || reason === "publication_failure"
    || reason === "journal_full"
    || reason === "journal_unavailable"
    || reason === "reservation_unavailable"
    || reason === "request_failed"
  ) {
    return Object.freeze({
      state: "failed",
      reason: "publication_failure",
      retryable: false,
    });
  }
  if (
    reason === "unsupported_operation"
    || reason === "request_shape_unsupported"
    || reason === "room_topology_unsupported"
    || reason === "client_not_browser"
  ) {
    return Object.freeze({
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
    });
  }
  if (reason === "policy_unavailable") {
    return Object.freeze({
      state: "failed",
      reason: "unknown_result",
      retryable: false,
    });
  }
  return Object.freeze({
    state: "failed",
    reason: "integrity_failure",
    retryable: false,
  });
}

export async function currentStrictShadowPolicy(): Promise<
  LiveShadowEncryptionTransitionPolicy
> {
  return getEncryptionTransitionPolicy(getServerDirectDb());
}

/**
 * Re-read the durable policy at the consumer/commit boundary, validate the
 * immutable registry coordinate, record one bounded latest-state signal, and
 * return the canonical behavior decision.
 */
export async function enforceRegisteredStrictShadowBoundary(input: Readonly<{
  boundaryId: string;
  state: StrictShadowBoundaryDecision["state"];
  reason: StrictShadowBoundaryDecision["reason"];
  retryable: boolean;
  observedAt?: Date;
}>): Promise<Readonly<{
  policy: LiveShadowEncryptionTransitionPolicy;
  result: StrictShadowEnforcementResult;
}>> {
  const boundary = registered.get(input.boundaryId);
  const policy = await currentStrictShadowPolicy();
  const policyForEnforcement = Object.freeze({
    mode: policy.mode,
    shadowBehavior: policy.shadowBehavior,
    revision: policy.revision,
  });
  const decision: StrictShadowBoundaryDecision = boundary === undefined
    ? Object.freeze({
      boundaryId: input.boundaryId || "unknown",
      family: "unknown",
      operation: "unknown",
      actorClass: "background" as const,
      state: "unsupported" as const,
      reason: "unknown_boundary" as const,
      retryable: false,
      policyRevision: policy.revision,
    })
    : Object.freeze({
      boundaryId: boundary.id,
      family: boundary.family,
      operation: boundary.operation,
      actorClass: boundary.actorClass,
      state: input.state,
      reason: input.reason,
      retryable: input.retryable,
      policyRevision: policy.revision,
    });
  const result = enforceStrictShadowDecision(policyForEnforcement, decision);
  if (policy.mode !== "plaintext_only") {
    const healthDecision = boundary === undefined
      ? {
          ...decision,
          boundaryId: "system.unknown_boundary",
          family: "unknown",
          operation: "unknown",
          actorClass: "background" as const,
        }
      : decision;
    try {
      await recordStrictShadowBoundaryHealth(getServerDirectDb(), {
        ...healthDecision,
        observedAt: input.observedAt ?? new Date(),
      });
    } catch (error) {
      // Health evidence must never turn Fallback Shadow into a product outage,
      // nor obscure the typed Strict rejection that was already decided.
      warn(
        `[strict-shadow] failed to record boundary health for ${healthDecision.boundaryId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return Object.freeze({ policy, result });
}

export function strictShadowHttpStatus(
  result: StrictShadowEnforcementResult,
): 409 | 425 {
  return result.disposition === "withhold" ? 425 : 409;
}

export class StrictShadowDispatchError extends Error {
  readonly code = "strict_shadow_protected_content_required";

  constructor(readonly result: StrictShadowEnforcementResult) {
    super("Strict Shadow requires verified protected handling");
    this.name = "StrictShadowDispatchError";
  }
}

/**
 * A foreground invocation is admitted against one immutable transition-policy
 * revision. Boundary observation re-reads durable policy; if the revision has
 * changed, the retained invocation may no longer decide fallback or Strict
 * behavior. Invalidate it with a content-free stale-authority result. Normal
 * same-revision Strict waits remain owned by Runtime's bounded retry path.
 */
export function rejectChangedStrictShadowPolicy(
  expected: StrictShadowEnforcementPolicy,
  observed: Awaited<ReturnType<typeof enforceRegisteredStrictShadowBoundary>>,
): void {
  if (observed.policy.revision === expected.revision) return;
  throw new StrictShadowDispatchError(Object.freeze({
    disposition: "reject" as const,
    decision: Object.freeze({
      ...observed.result.decision,
      state: "unsupported" as const,
      reason: "stale_authority" as const,
      retryable: false,
      policyRevision: observed.policy.revision,
    }),
  }));
}

export function strictShadowHttpBody(
  result: StrictShadowEnforcementResult,
): Readonly<{
  error: "strict_shadow_protected_content_required";
  state: StrictShadowBoundaryDecision["state"];
  reason: StrictShadowBoundaryDecision["reason"];
  retryable: boolean;
}> {
  return Object.freeze({
    error: "strict_shadow_protected_content_required" as const,
    state: result.decision.state,
    reason: result.decision.reason,
    retryable: result.decision.retryable,
  });
}

/** Block the legacy Workspace Artifact API before any plaintext handler runs. */
export function installStrictShadowPlaintextRouteGate(
  app: FastifyInstance,
  enforceBoundary: typeof enforceRegisteredStrictShadowBoundary =
    enforceRegisteredStrictShadowBoundary,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url;
    if (
      route === undefined
      || !route.startsWith("/api/workspace/artifacts")
    ) return;
    const enforcement = await enforceBoundary({
      boundaryId: "artifact.api.workspace",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
    });
    if (
      enforcement.result.disposition === "withhold"
      || enforcement.result.disposition === "reject"
    ) {
      return reply.code(strictShadowHttpStatus(enforcement.result)).send(
        strictShadowHttpBody(enforcement.result),
      );
    }
  });
}
