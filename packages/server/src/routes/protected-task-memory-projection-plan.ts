import { createHash } from "node:crypto";

import type { ProtectedTaskProjectionAuthorityPlan } from "@nautilo/agent";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  sameProtectedTaskSemanticAuthorityRequirements,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";

const REQUEST_DOMAIN = "nautilo/protected-task-memory-projection-request/v1";
const AUTHORIZATION_DOMAIN = "nautilo/protected-task-memory-projection-authorization/v1";
const DESTINATION_DOMAIN = "nautilo/protected-task-memory-projection-destination/v1";

export type ProtectedTaskProjectionPlanSource = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
  payloadDigest: string;
}>;
export type ProtectedTaskProjectionPlanDestination = Readonly<{
  roomId: string;
  namespaceId: string;
  label: string;
  kind: string;
  memberCount: number;
  audienceFingerprint: string;
}>;
export type SerializedProtectedTaskProjectionAuthorityPlan = Readonly<{
  planVersion: 1;
  kind: "current_v1" | "additional_authority_v1";
  operationId: string;
  requestDigest: string;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  authorizationRequestId?: string;
  effectDisposition?: "not_started_v1";
}>;

const digest = (value: unknown): Uint8Array => new Uint8Array(
  createHash("sha256").update(JSON.stringify(value)).digest(),
);
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));

export function protectedTaskProjectionDestinationAuthorityDigest(
  destination: ProtectedTaskProjectionPlanDestination,
): Uint8Array {
  return digest([DESTINATION_DOMAIN, destination.roomId, destination.namespaceId,
    destination.label, destination.kind, destination.memberCount,
    destination.audienceFingerprint]);
}

function projectionSemanticAuthorityRequirements(
  sources: readonly ProtectedTaskProjectionPlanSource[],
  destinationNamespaceId: string,
): ProtectedTaskSemanticAuthorityRequirements {
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const source of sources) for (const namespaceId of source.requiredNamespaceIds) {
    const entry = operations.get(namespaceId) ?? new Set<"decrypt" | "encrypt">();
    entry.add("decrypt"); operations.set(namespaceId, entry);
  }
  const destination = operations.get(destinationNamespaceId) ?? new Set<"decrypt" | "encrypt">();
  destination.add("encrypt"); operations.set(destinationNamespaceId, destination);
  return canonicalProtectedTaskSemanticAuthorityRequirements([...operations]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespaceId, values]) => ({ namespaceId, operations: [...values].sort() })));
}

export function semanticAuthorityCovers(
  available: ProtectedTaskSemanticAuthorityRequirements,
  required: ProtectedTaskSemanticAuthorityRequirements,
): boolean {
  return required.every(requirement => {
    const matching = available.filter(candidate => candidate.namespaceId === requirement.namespaceId);
    return matching.length === 1 && requirement.operations.every(
      operation => matching[0]!.operations.includes(operation),
    );
  });
}

export function createProtectedTaskProjectionAuthorityPlan(input: Readonly<{
  taskId: string; taskRunId: string; graphThreadId: string;
  reference: Readonly<{ referenceId: string; toolCallId: string; requesterUserId: string;
    requesterActorId: string; agentId: string; createdAt: number; expiresAt: number }>;
  operationId: string;
  sources: readonly ProtectedTaskProjectionPlanSource[];
  destination: ProtectedTaskProjectionPlanDestination;
  proposalDigest: string; effectDigest: string;
  availableAuthority: ProtectedTaskSemanticAuthorityRequirements;
}>): ProtectedTaskProjectionAuthorityPlan {
  const requirements = projectionSemanticAuthorityRequirements(input.sources, input.destination.namespaceId);
  const requestDigest = digest([REQUEST_DOMAIN, input.taskId, input.taskRunId,
    input.graphThreadId, input.reference.referenceId, input.reference.toolCallId,
    input.reference.requesterUserId, input.reference.requesterActorId,
    input.reference.agentId, input.reference.createdAt, input.reference.expiresAt,
    input.operationId, input.sources.map(source => [source.memoryId,
      source.contentRevision, source.cryptoAccessRevision, source.cryptoObjectId,
      source.requiredNamespaceIds, source.payloadDigest]),
    [input.destination.roomId, input.destination.namespaceId, input.destination.label,
      input.destination.kind, input.destination.memberCount,
      input.destination.audienceFingerprint], input.proposalDigest, input.effectDigest,
    requirements.map(requirement => [requirement.namespaceId, requirement.operations])]);
  const common = Object.freeze({ planVersion: 1 as const, operationId: input.operationId,
    requestDigest, semanticAuthorityRequirements: requirements });
  if (semanticAuthorityCovers(input.availableAuthority, requirements)) {
    return Object.freeze({ ...common, kind: "current_v1" as const });
  }
  return Object.freeze({ ...common, kind: "additional_authority_v1" as const,
    authorizationRequestId: `task.memory.projection:${hex(digest([
      AUTHORIZATION_DOMAIN, input.taskRunId, hex(requestDigest),
    ]))}`, effectDisposition: "not_started_v1" as const });
}

export function serializeProtectedTaskProjectionAuthorityPlan(
  plan: ProtectedTaskProjectionAuthorityPlan,
): SerializedProtectedTaskProjectionAuthorityPlan {
  const common = { planVersion: 1 as const, operationId: plan.operationId,
    requestDigest: hex(plan.requestDigest),
    semanticAuthorityRequirements: plan.semanticAuthorityRequirements };
  return plan.kind === "current_v1"
    ? Object.freeze({ ...common, kind: "current_v1" as const })
    : Object.freeze({ ...common, kind: "additional_authority_v1" as const,
      authorizationRequestId: plan.authorizationRequestId,
      effectDisposition: "not_started_v1" as const });
}

export function deserializeProtectedTaskProjectionAuthorityPlan(
  value: SerializedProtectedTaskProjectionAuthorityPlan,
): ProtectedTaskProjectionAuthorityPlan {
  const common = Object.freeze({ planVersion: 1 as const, operationId: value.operationId,
    requestDigest: bytes(value.requestDigest), semanticAuthorityRequirements:
      canonicalProtectedTaskSemanticAuthorityRequirements(value.semanticAuthorityRequirements) });
  if (value.kind === "current_v1") return Object.freeze({ ...common, kind: "current_v1" as const });
  if (!value.authorizationRequestId || value.effectDisposition !== "not_started_v1") {
    throw new TypeError("Protected Task projection plan is invalid");
  }
  return Object.freeze({ ...common, kind: "additional_authority_v1" as const,
    authorizationRequestId: value.authorizationRequestId,
    effectDisposition: "not_started_v1" as const });
}

export function sameProtectedTaskProjectionAuthorityPlan(
  left: ProtectedTaskProjectionAuthorityPlan,
  right: ProtectedTaskProjectionAuthorityPlan,
): boolean {
  return left.kind === right.kind && left.planVersion === right.planVersion
    && left.operationId === right.operationId && left.requestDigest.length === right.requestDigest.length
    && left.requestDigest.every((entry, index) => entry === right.requestDigest[index])
    && sameProtectedTaskSemanticAuthorityRequirements(left.semanticAuthorityRequirements,
      right.semanticAuthorityRequirements)
    && (left.kind === "current_v1" && right.kind === "current_v1"
      || left.kind === "additional_authority_v1" && right.kind === "additional_authority_v1"
      && left.authorizationRequestId === right.authorizationRequestId
      && left.effectDisposition === right.effectDisposition);
}
