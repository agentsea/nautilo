import { interrupt } from "@langchain/langgraph";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";

import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  type ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
} from "../../graph/protected-task-additional-authority-resume";

type AccessChangeInput = Parameters<ProtectedAgentMemoryAccessPort["change"]>[0];
type AccessChangeResult = ReturnType<ProtectedAgentMemoryAccessPort["change"]>;

type ProtectedTaskMemoryAccessAuthorityPlanBase = Readonly<{
  planVersion: 1;
  operationId: string;
  requestDigest: Uint8Array;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
}>;

/**
 * The server derives this decision from the sealed preapproval source set. A
 * resumed grant must not turn an additional-authority decision into a current
 * one before LangGraph consumes the exact pending acknowledgement.
 */
export type ProtectedTaskMemoryAccessAuthorityPlan =
  | (ProtectedTaskMemoryAccessAuthorityPlanBase & Readonly<{
      kind: "current_v1";
    }>)
  | (ProtectedTaskMemoryAccessAuthorityPlanBase & Readonly<{
      kind: "additional_authority_v1";
      authorizationRequestId: string;
      effectDisposition: "not_started_v1";
    }>);

export type ProtectedTaskMemoryAccessAuthorization =
  | Readonly<{
      kind: "current_v1";
      plan: Extract<ProtectedTaskMemoryAccessAuthorityPlan, {
        kind: "current_v1";
      }>;
    }>
  | Readonly<{
      kind: "additional_authority_v1";
      plan: Extract<ProtectedTaskMemoryAccessAuthorityPlan, {
        kind: "additional_authority_v1";
      }>;
      acknowledgement: ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1;
    }>;

/** Server-owned protected Task access custody with no generic effect method. */
export type ProtectedTaskMemoryAccessHandoff = Readonly<{
  prepareApproval: NonNullable<ProtectedAgentMemoryAccessPort["prepareApproval"]>;
  restoreApproval: NonNullable<ProtectedAgentMemoryAccessPort["restoreApproval"]>;
  planChange(
    input: AccessChangeInput,
  ): Promise<ProtectedMemoryResult<ProtectedTaskMemoryAccessAuthorityPlan>>;
  changeAuthorized(
    input: AccessChangeInput & Readonly<{
      authorization: ProtectedTaskMemoryAccessAuthorization;
    }>,
  ): AccessChangeResult;
}>;

const BASE_PLAN_KEYS = Object.freeze([
  "kind",
  "operationId",
  "planVersion",
  "requestDigest",
  "semanticAuthorityRequirements",
].sort());
const ADDITIONAL_PLAN_KEYS = Object.freeze([
  ...BASE_PLAN_KEYS,
  "authorizationRequestId",
  "effectDisposition",
].sort());

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === expected.join(",");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function copyPlan(
  value: ProtectedTaskMemoryAccessAuthorityPlan,
): ProtectedTaskMemoryAccessAuthorityPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Protected Task Memory access authority plan is invalid");
  }
  const record = value as Record<string, unknown>;
  const additional = value.kind === "additional_authority_v1";
  if (
    (!additional && value.kind !== "current_v1")
    || !exactKeys(record, additional ? ADDITIONAL_PLAN_KEYS : BASE_PLAN_KEYS)
    || value.planVersion !== 1
    || !nonEmpty(value.operationId)
    || !(value.requestDigest instanceof Uint8Array)
    || value.requestDigest.length !== 32
    || (additional && (
      !nonEmpty(value.authorizationRequestId)
      || value.effectDisposition !== "not_started_v1"
    ))
  ) {
    throw new TypeError("Protected Task Memory access authority plan is invalid");
  }
  let semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(
        value.semanticAuthorityRequirements,
      );
  } catch {
    throw new TypeError("Protected Task Memory access authority plan is invalid");
  }
  const common = Object.freeze({
    planVersion: 1 as const,
    operationId: value.operationId,
    requestDigest: value.requestDigest.slice(),
    semanticAuthorityRequirements,
  });
  return additional
    ? Object.freeze({
        ...common,
        kind: "additional_authority_v1" as const,
        authorizationRequestId: value.authorizationRequestId,
        effectDisposition: "not_started_v1" as const,
      })
    : Object.freeze({ ...common, kind: "current_v1" as const });
}

function copyAcknowledgement(
  value: ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
): ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1 {
  return Object.freeze({
    type: value.type,
    authorizationRequestId: value.authorizationRequestId,
    effectDisposition: "not_started_v1" as const,
    operationId: value.operationId,
    requestDigest: value.requestDigest.slice(),
    requiredAuthorityDigest: value.requiredAuthorityDigest.slice(),
  });
}

/**
 * Adapt Task-only access custody to the generic graph port. The server
 * recomputes the plan and validates the forwarded authorization before effects.
 */
export function createProtectedTaskMemoryAccessPort(
  handoff: ProtectedTaskMemoryAccessHandoff,
): ProtectedAgentMemoryAccessPort {
  return Object.freeze({
    prepareApproval: (
      request: Parameters<NonNullable<
        ProtectedAgentMemoryAccessPort["prepareApproval"]
      >>[0],
    ) => handoff.prepareApproval(request),
    restoreApproval: (
      request: Parameters<NonNullable<
        ProtectedAgentMemoryAccessPort["restoreApproval"]
      >>[0],
    ) => handoff.restoreApproval(request),
    async change(request: AccessChangeInput) {
      const planned = await handoff.planChange(request);
      if (planned.status === "unavailable") return planned;
      const plan = copyPlan(planned.value);
      if (plan.kind === "current_v1") {
        return handoff.changeAuthorized({
          ...request,
          authorization: Object.freeze({ kind: "current_v1" as const, plan }),
        });
      }

      const requiredAuthorityDigest =
        protectedTaskSemanticAuthorityRequirementsDigest(
          plan.semanticAuthorityRequirements,
        );
      try {
        const acknowledgement: unknown = interrupt({
          type: "protected_task_additional_authority",
          authorizationRequestId: plan.authorizationRequestId,
          effectDisposition: plan.effectDisposition,
          operationId: plan.operationId,
          requestDigest: plan.requestDigest.slice(),
          requiredAuthorityDigest: requiredAuthorityDigest.slice(),
          semanticAuthorityRequirements: plan.semanticAuthorityRequirements,
        });
        assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
          acknowledgement,
          {
            authorizationRequestId: plan.authorizationRequestId,
            effectDisposition: plan.effectDisposition,
            operationId: plan.operationId,
            requestDigest: plan.requestDigest,
            requiredAuthorityDigest,
          },
        );
        return handoff.changeAuthorized({
          ...request,
          authorization: Object.freeze({
            kind: "additional_authority_v1" as const,
            plan,
            acknowledgement: copyAcknowledgement(acknowledgement),
          }),
        });
      } finally {
        requiredAuthorityDigest.fill(0);
      }
    },
  });
}
