import { interrupt } from "@langchain/langgraph";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import {
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";

import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
  type ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
} from "../../graph/protected-task-additional-authority-resume";

type ProjectionPublishInput = Parameters<
  ProtectedAgentMemoryProjectionPort["publish"]
>[0];
type ProjectionPublishResult = ReturnType<
  ProtectedAgentMemoryProjectionPort["publish"]
>;

type ProtectedTaskProjectionAuthorityPlanBase = Readonly<{
  planVersion: 1;
  operationId: string;
  requestDigest: Uint8Array;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
}>;

/**
 * The decision is sealed with the original projection preparation. A resumed
 * node must return the same `additional_authority_v1` plan even though its fresh
 * grant now contains the requested Namespace operations, so LangGraph consumes
 * the exact pending interrupt reply before publication.
 */
export type ProtectedTaskProjectionAuthorityPlan =
  | (ProtectedTaskProjectionAuthorityPlanBase & Readonly<{
      kind: "current_v1";
    }>)
  | (ProtectedTaskProjectionAuthorityPlanBase & Readonly<{
      kind: "additional_authority_v1";
      authorizationRequestId: string;
      effectDisposition: "not_started_v1";
    }>);

export type ProtectedTaskProjectionPublicationAuthorization =
  | Readonly<{
      kind: "current_v1";
      plan: Extract<ProtectedTaskProjectionAuthorityPlan, { kind: "current_v1" }>;
    }>
  | Readonly<{
      kind: "additional_authority_v1";
      plan: Extract<ProtectedTaskProjectionAuthorityPlan, {
        kind: "additional_authority_v1";
      }>;
      acknowledgement: ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1;
    }>;

/**
 * Server-owned protected Task projection custody. It deliberately has no
 * generic `publish`: every graph publication must pass through the interrupt
 * and acknowledgement wrapper below.
 */
export type ProtectedTaskMemoryProjectionHandoff = Readonly<{
  prepare: ProtectedAgentMemoryProjectionPort["prepare"];
  restore: NonNullable<ProtectedAgentMemoryProjectionPort["restore"]>;
  planPublication(
    input: ProjectionPublishInput,
  ): Promise<ProtectedMemoryResult<ProtectedTaskProjectionAuthorityPlan>>;
  publishAuthorized(
    input: ProjectionPublishInput & Readonly<{
      authorization: ProtectedTaskProjectionPublicationAuthorization;
    }>,
  ): ProjectionPublishResult;
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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === expected.join(",");
}

function copyPlan(
  value: ProtectedTaskProjectionAuthorityPlan,
): ProtectedTaskProjectionAuthorityPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Protected Task projection authority plan is invalid");
  }
  const record = value as Record<string, unknown>;
  const additional = value.kind === "additional_authority_v1";
  if ((!additional && value.kind !== "current_v1")
    || !exactKeys(record, additional ? ADDITIONAL_PLAN_KEYS : BASE_PLAN_KEYS)
    || value.planVersion !== 1
    || !nonEmpty(value.operationId)
    || !(value.requestDigest instanceof Uint8Array)
    || value.requestDigest.length !== 32
    || (additional && (!nonEmpty(value.authorizationRequestId)
      || value.effectDisposition !== "not_started_v1"))) {
    throw new TypeError("Protected Task projection authority plan is invalid");
  }
  let semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(
        value.semanticAuthorityRequirements,
      );
  } catch {
    throw new TypeError("Protected Task projection authority plan is invalid");
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
    type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
    authorizationRequestId: value.authorizationRequestId,
    effectDisposition: "not_started_v1" as const,
    operationId: value.operationId,
    requestDigest: value.requestDigest.slice(),
    requiredAuthorityDigest: value.requiredAuthorityDigest.slice(),
  });
}

/**
 * Adapt a Task-only projection handoff to the generic graph port. The server
 * recomputes and validates the forwarded plan/acknowledgement before effects;
 * this wrapper owns LangGraph interruption and rejects a substituted reply.
 */
export function createProtectedTaskMemoryProjectionPort(
  handoff: ProtectedTaskMemoryProjectionHandoff,
): ProtectedAgentMemoryProjectionPort {
  return Object.freeze({
    prepare: (request: Parameters<ProtectedAgentMemoryProjectionPort["prepare"]>[0]) =>
      handoff.prepare(request),
    restore: (request: Parameters<
      NonNullable<ProtectedAgentMemoryProjectionPort["restore"]>
    >[0]) => handoff.restore(request),
    async publish(request: ProjectionPublishInput) {
      const planned = await handoff.planPublication(request);
      if (planned.status === "unavailable") return planned;
      const plan = copyPlan(planned.value);
      if (plan.kind === "current_v1") {
        return handoff.publishAuthorized({
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
        return handoff.publishAuthorized({
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
