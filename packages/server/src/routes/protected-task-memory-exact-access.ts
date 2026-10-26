import { createHash, randomUUID } from "node:crypto";

import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  type ProtectedTaskMemoryAccessAuthorityPlan,
  type ProtectedTaskMemoryAccessHandoff,
} from "@nautilo/agent";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
  sameProtectedTaskSemanticAuthorityRequirements,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import type {
  ForegroundAgentMemoryNativeExactAccessPlan,
  ProtectedAgentMemoryAccessApprovalReference,
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
  ProtectedTaskMemoryAccessContinuationCapsule,
} from "@nautilo/lattice-bridge";
import { z } from "zod";

import type {
  ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";

const REQUEST_DOMAIN = "nautilo/protected-task-memory-access-request/v1";
const AUTHORIZATION_DOMAIN =
  "nautilo/protected-task-memory-access-authorization/v1";

type AccessChangeInput = Parameters<
  ProtectedTaskMemoryAccessHandoff["planChange"]
>[0];

export type ProtectedTaskMemoryAccessSource = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
  payloadDigest: string;
  type: string;
  content: string;
}>;

export type ProtectedTaskMemoryAccessTarget = Readonly<{
  userId: string;
  actorId: string;
  normalizedHandle: string;
}>;

export type ProtectedTaskMemoryAccessDestination = Readonly<{
  roomId: string;
  namespaceId: string;
  humanActorIds: readonly string[];
}>;

type SealedSource = Omit<ProtectedTaskMemoryAccessSource, "type" | "content">;

const requirementSchema = z.object({
  namespaceId: z.string(),
  operations: z.array(z.enum(["decrypt", "encrypt"])),
}).strict();
const capsuleSchema = z.object({
  prepared: z.object({
    operationId: z.string(),
    toolCallId: z.string(),
    memoryId: z.string(),
    userHandle: z.string(),
  }).strict(),
  source: z.object({
    memoryId: z.string(),
    contentRevision: z.number().int().nonnegative(),
    cryptoAccessRevision: z.number().int().nonnegative(),
    cryptoObjectId: z.string(),
    requiredNamespaceIds: z.array(z.string()),
    payloadDigest: z.string(),
  }).strict(),
  target: z.object({
    userId: z.string(),
    actorId: z.string(),
    normalizedHandle: z.string(),
  }).strict(),
  originalAuthorityRequirements: z.array(requirementSchema),
}).strict();

type CapsuleState = Readonly<{
  prepared: Readonly<z.infer<typeof capsuleSchema>["prepared"]>;
  source: Readonly<Omit<z.infer<typeof capsuleSchema>["source"],
    "requiredNamespaceIds"> & Readonly<{
      requiredNamespaceIds: readonly string[];
    }>>;
  target: Readonly<z.infer<typeof capsuleSchema>["target"]>;
  originalAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
}>;

export type ProtectedTaskMemoryExactAccessInput = Readonly<{
  authority: ProtectedMemoryAuthority;
  current: ProtectedTaskMemoryAuthorityInput;
  capsule: ProtectedTaskMemoryAccessContinuationCapsule;
  now?: () => number;
  createReferenceId?: () => string;
  openSource(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    memoryId: string;
  }>): Promise<ProtectedTaskMemoryAccessSource | null>;
  resolveTarget(input: Readonly<{
    requesterUserId: string;
    requesterActorId: string;
    normalizedHandle: string;
  }>): Promise<ProtectedTaskMemoryAccessTarget | null>;
  reserveDestination(input: Readonly<{
    requesterUserId: string;
    requesterActorId: string;
    target: ProtectedTaskMemoryAccessTarget;
  }>): Promise<ProtectedTaskMemoryAccessDestination | null>;
  findDestination(input: Readonly<{
    requesterUserId: string;
    requesterActorId: string;
    target: ProtectedTaskMemoryAccessTarget;
  }>): Promise<ProtectedTaskMemoryAccessDestination | null>;
  planProduct(input: Readonly<{
    request: AccessChangeInput;
    source: SealedSource;
    destination: ProtectedTaskMemoryAccessDestination;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "unchanged" | "prepared";
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
  }>>>;
  inspectRecovery(input: Readonly<{
    request: AccessChangeInput;
    source: SealedSource;
    destination: ProtectedTaskMemoryAccessDestination;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "pending" | "complete";
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
    source: ProtectedTaskMemoryAccessSource;
  }>> | null>;
  commit(input: Readonly<{
    request: AccessChangeInput;
    source: SealedSource;
    destination: ProtectedTaskMemoryAccessDestination;
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
  }>): ReturnType<ProtectedTaskMemoryAccessHandoff["changeAuthorized"]>;
}>;

function unavailable<Value>(
  reason: "authorization_required" | "stale_revision" | "integrity_failure",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function digest(value: unknown): Uint8Array {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalIds(values: readonly string[]): readonly string[] | null {
  const canonical = [...new Set(values)].sort();
  return canonical.length === values.length && canonical.length > 0
    ? Object.freeze(canonical)
    : null;
}

function sameAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  return left.mode === "namespace" && right.mode === "namespace"
    && left.subjectUserId === right.subjectUserId
    && left.agentId === right.agentId
    && left.writableNamespaceId === right.writableNamespaceId
    && sameStrings(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameStrings(left.mutableNamespaceIds, right.mutableNamespaceIds);
}

function requirementsFromEvidence(
  current: ProtectedTaskMemoryAuthorityInput,
): ProtectedTaskSemanticAuthorityRequirements {
  return canonicalProtectedTaskSemanticAuthorityRequirements(
    current.evidence.namespaceRequirements.map(requirement => ({
      namespaceId: requirement.namespaceId,
      operations: [...requirement.operations],
    })),
  );
}

function requirementsFor(
  plan: ForegroundAgentMemoryNativeExactAccessPlan,
): ProtectedTaskSemanticAuthorityRequirements {
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const namespaceId of plan.currentNamespaceIds) {
    operations.set(namespaceId, new Set(["decrypt", "encrypt"]));
  }
  for (const namespaceId of plan.targetNamespaceIds) {
    const entry = operations.get(namespaceId) ?? new Set();
    entry.add("encrypt");
    operations.set(namespaceId, entry);
  }
  return canonicalProtectedTaskSemanticAuthorityRequirements(
    [...operations].sort(([left], [right]) => left.localeCompare(right))
      .map(([namespaceId, values]) => ({
        namespaceId,
        operations: [...values].sort(),
      })),
  );
}

function covers(
  available: ProtectedTaskSemanticAuthorityRequirements,
  required: ProtectedTaskSemanticAuthorityRequirements,
): boolean {
  return required.every(requirement => {
    const matches = available.filter(
      candidate => candidate.namespaceId === requirement.namespaceId,
    );
    return matches.length === 1 && requirement.operations.every(
      operation => matches[0]!.operations.includes(operation),
    );
  });
}

function sealedSource(source: ProtectedTaskMemoryAccessSource): SealedSource {
  return Object.freeze({
    memoryId: source.memoryId,
    contentRevision: source.contentRevision,
    cryptoAccessRevision: source.cryptoAccessRevision,
    cryptoObjectId: source.cryptoObjectId,
    requiredNamespaceIds: Object.freeze([...source.requiredNamespaceIds]),
    payloadDigest: source.payloadDigest,
  });
}

function sameSource(
  current: ProtectedTaskMemoryAccessSource,
  expected: SealedSource,
): boolean {
  return current.memoryId === expected.memoryId
    && current.contentRevision === expected.contentRevision
    && current.cryptoAccessRevision === expected.cryptoAccessRevision
    && current.cryptoObjectId === expected.cryptoObjectId
    && sameStrings(current.requiredNamespaceIds, expected.requiredNamespaceIds)
    && current.payloadDigest === expected.payloadDigest;
}

function sameTarget(
  left: ProtectedTaskMemoryAccessTarget,
  right: CapsuleState["target"],
): boolean {
  return left.userId === right.userId
    && left.actorId === right.actorId
    && left.normalizedHandle === right.normalizedHandle;
}

function samePlan(
  left: ProtectedTaskMemoryAccessAuthorityPlan,
  right: ProtectedTaskMemoryAccessAuthorityPlan,
): boolean {
  return left.kind === right.kind
    && left.planVersion === right.planVersion
    && left.operationId === right.operationId
    && sameBytes(left.requestDigest, right.requestDigest)
    && sameProtectedTaskSemanticAuthorityRequirements(
      left.semanticAuthorityRequirements,
      right.semanticAuthorityRequirements,
    )
    && (left.kind === "current_v1" && right.kind === "current_v1"
      || left.kind === "additional_authority_v1"
        && right.kind === "additional_authority_v1"
        && left.authorizationRequestId === right.authorizationRequestId
        && left.effectDisposition === right.effectDisposition);
}

function planFor(input: Readonly<{
  current: ProtectedTaskMemoryAuthorityInput;
  reference: ProtectedAgentMemoryAccessApprovalReference;
  state: CapsuleState;
  destination: ProtectedTaskMemoryAccessDestination;
  product: ForegroundAgentMemoryNativeExactAccessPlan;
}>): ProtectedTaskMemoryAccessAuthorityPlan {
  const requirements = requirementsFor(input.product);
  const requestDigest = digest([
    REQUEST_DOMAIN,
    input.current.occurrence.task.id,
    input.current.occurrence.run.id,
    input.current.occurrence.run.graphThreadId,
    input.reference.referenceId,
    input.reference.toolCallId,
    input.reference.requesterUserId,
    input.reference.taskContinuation?.requesterActorId,
    input.reference.agentId,
    input.reference.taskContinuation?.createdAt,
    input.state.prepared.operationId,
    input.state.source,
    input.state.target,
    {
      roomId: input.destination.roomId,
      namespaceId: input.destination.namespaceId,
      humanActorIds: input.destination.humanActorIds,
    },
    {
      operationId: input.product.operationId,
      memoryId: input.product.memoryId,
      cryptoObjectId: input.product.cryptoObjectId,
      expectedContentRevision: input.product.expectedContentRevision,
      expectedCryptoAccessRevision: input.product.expectedCryptoAccessRevision,
      nextCryptoAccessRevision: input.product.nextCryptoAccessRevision,
      anchorNamespaceId: input.product.anchorNamespaceId,
      currentNamespaceIds: input.product.currentNamespaceIds,
      targetNamespaceIds: input.product.targetNamespaceIds,
      addedNamespaceIds: input.product.addedNamespaceIds,
      removedNamespaceIds: input.product.removedNamespaceIds,
      currentRequiredNamespaceFingerprint:
        hex(input.product.currentRequiredNamespaceFingerprint),
      targetRequiredNamespaceFingerprint:
        hex(input.product.targetRequiredNamespaceFingerprint),
      productMutation: input.product.productMutation,
    },
    requirements,
  ]);
  const common = Object.freeze({
    planVersion: 1 as const,
    operationId: input.state.prepared.operationId,
    requestDigest,
    semanticAuthorityRequirements: requirements,
  });
  const original = canonicalProtectedTaskSemanticAuthorityRequirements(
    input.state.originalAuthorityRequirements,
  );
  if (covers(original, requirements)) {
    return Object.freeze({ ...common, kind: "current_v1" as const });
  }
  return Object.freeze({
    ...common,
    kind: "additional_authority_v1" as const,
    authorizationRequestId: `task.memory.access:${hex(digest([
      AUTHORIZATION_DOMAIN,
      input.current.occurrence.run.id,
      hex(requestDigest),
    ]))}`,
    effectDisposition: "not_started_v1" as const,
  });
}

/**
 * Durable protected Task `share_memory` owner. Preparation is read-only;
 * immutable access-Namespace reservation begins only from `planChange`, after
 * the graph has consumed the Human approval.
 */
export function createProtectedTaskMemoryExactAccess(
  input: ProtectedTaskMemoryExactAccessInput,
): ProtectedTaskMemoryAccessHandoff {
  const now = input.now ?? Date.now;
  const createReferenceId = input.createReferenceId ?? randomUUID;
  if (input.authority.mode !== "namespace") {
    return Object.freeze({
      prepareApproval: (_request) => Promise.resolve(
        unavailable("authorization_required"),
      ),
      restoreApproval: (_request) => Promise.resolve(
        unavailable("authorization_required"),
      ),
      planChange: (_request) => Promise.resolve(
        unavailable("authorization_required"),
      ),
      changeAuthorized: (_request) => Promise.resolve(
        unavailable("authorization_required"),
      ),
    });
  }
  const fixedAuthority = Object.freeze({
    ...input.authority,
    readableNamespaceIds: Object.freeze([...input.authority.readableNamespaceIds]),
    mutableNamespaceIds: Object.freeze([...input.authority.mutableNamespaceIds]),
  });
  const task = input.current.occurrence.task;
  const referenceBound = (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryAccessApprovalReference,
  ): boolean => reference.referenceVersion === 1
    && reference.referenceId.length > 0
    && reference.toolCallId.length > 0
    && reference.requesterUserId === input.current.subject.userId
    && reference.agentId === task.agentId
    && reference.taskContinuation?.kind === "protected_task_v1"
    && reference.taskContinuation.requesterActorId
      === input.current.subject.humanActorId
    && Number.isSafeInteger(reference.taskContinuation.createdAt)
    && reference.taskContinuation.createdAt >= 0
    && reference.taskContinuation.createdAt <= now()
    && reference.taskContinuation.sealedPreparation.length > 0
    && sameAuthority(authority, fixedAuthority);

  const open = async (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryAccessApprovalReference,
  ): Promise<CapsuleState | null> => {
    if (!referenceBound(authority, reference)) return null;
    const parsed = capsuleSchema.safeParse(await input.capsule.open(reference));
    if (!parsed.success) return null;
    const state = parsed.data;
    const ids = canonicalIds(state.source.requiredNamespaceIds);
    if (ids === null
      || !sameStrings(ids, state.source.requiredNamespaceIds)
      || state.prepared.toolCallId !== reference.toolCallId
      || state.prepared.memoryId !== state.source.memoryId
      || state.prepared.userHandle !== state.target.normalizedHandle) return null;
    return Object.freeze({
      ...state,
      source: Object.freeze({ ...state.source,
        requiredNamespaceIds: Object.freeze([...state.source.requiredNamespaceIds]) }),
      target: Object.freeze({ ...state.target }),
      originalAuthorityRequirements:
        canonicalProtectedTaskSemanticAuthorityRequirements(
          state.originalAuthorityRequirements,
        ),
    }) as CapsuleState;
  };

  const derive = async (
    request: AccessChangeInput,
  ): Promise<ProtectedMemoryResult<Readonly<{
    state: CapsuleState;
    destination: ProtectedTaskMemoryAccessDestination;
    product: ForegroundAgentMemoryNativeExactAccessPlan;
    plan: ProtectedTaskMemoryAccessAuthorityPlan;
  }>>> => {
    const reference = request.approvalReference;
    if (reference === undefined || request.operationId.length === 0
      || request.action.kind !== "grant_user"
      || request.memoryId.length === 0) {
      return unavailable("authorization_required");
    }
    const state = await open(request.authority, reference);
    if (state === null
      || state.prepared.operationId !== request.operationId
      || state.prepared.memoryId !== request.memoryId
      || state.prepared.userHandle !== request.action.userHandle) {
      return unavailable("authorization_required");
    }
    const target = await input.resolveTarget({
      requesterUserId: input.current.subject.userId,
      requesterActorId: input.current.subject.humanActorId,
      normalizedHandle: state.target.normalizedHandle,
    });
    if (target === null || !sameTarget(target, state.target)) {
      return unavailable("stale_revision");
    }
    const resolvedDestination = await input.reserveDestination({
      requesterUserId: input.current.subject.userId,
      requesterActorId: input.current.subject.humanActorId,
      target,
    });
    const destination = resolvedDestination === null ? null : Object.freeze({
      roomId: resolvedDestination.roomId,
      namespaceId: resolvedDestination.namespaceId,
      humanActorIds: Object.freeze([...resolvedDestination.humanActorIds]),
    });
    const expectedAudience = [
      input.current.subject.humanActorId,
      target.actorId,
    ].sort();
    if (destination === null
      || !sameStrings([...destination.humanActorIds].sort(), expectedAudience)) {
      return unavailable("authorization_required");
    }
    const recovered = await input.inspectRecovery({
      request,
      source: state.source,
      destination,
    });
    if (recovered !== null) {
      if (recovered.status === "unavailable") return recovered;
      const plan = planFor({ current: input.current, reference, state,
        destination, product: recovered.value.plan });
      return Object.freeze({ status: "success" as const,
        value: Object.freeze({ state, destination,
          product: recovered.value.plan, plan }) });
    }
    const source = await input.openSource({
      authority: request.authority,
      memoryId: state.source.memoryId,
    });
    if (source === null || !sameSource(source, state.source)) {
      return unavailable("stale_revision");
    }
    const product = await input.planProduct({
      request,
      source: state.source,
      destination,
    });
    if (product.status === "unavailable") return product;
    const plan = planFor({ current: input.current, reference, state,
      destination, product: product.value.plan });
    return Object.freeze({ status: "success" as const,
      value: Object.freeze({ state, destination,
        product: product.value.plan, plan }) });
  };

  return Object.freeze({
    async prepareApproval(request) {
      if (!sameAuthority(request.authority, fixedAuthority)
        || request.action.kind !== "grant_user"
        || request.operationId.length === 0
        || request.toolCallId.length === 0) {
        return unavailable("authorization_required");
      }
      const [source, target] = await Promise.all([
        input.openSource({ authority: request.authority,
          memoryId: request.memoryId }),
        input.resolveTarget({
          requesterUserId: input.current.subject.userId,
          requesterActorId: input.current.subject.humanActorId,
          normalizedHandle: request.action.userHandle,
        }),
      ]);
      if (source === null || target === null
        || target.actorId === input.current.subject.humanActorId
        || target.normalizedHandle !== request.action.userHandle) {
        return unavailable("authorization_required");
      }
      const state: CapsuleState = Object.freeze({
        prepared: Object.freeze({ operationId: request.operationId,
          toolCallId: request.toolCallId, memoryId: request.memoryId,
          userHandle: request.action.userHandle }),
        source: sealedSource(source),
        target: Object.freeze({ ...target }),
        originalAuthorityRequirements: requirementsFromEvidence(input.current),
      });
      const referenceId = createReferenceId();
      const createdAt = now();
      const provisional: ProtectedAgentMemoryAccessApprovalReference =
        Object.freeze({ referenceVersion: 1 as const, referenceId,
          toolCallId: request.toolCallId,
          requesterUserId: input.current.subject.userId,
          agentId: task.agentId,
          taskContinuation: Object.freeze({ kind: "protected_task_v1" as const,
            requesterActorId: input.current.subject.humanActorId,
            createdAt, sealedPreparation: "" }) });
      const sealedPreparation = await input.capsule.seal(provisional, state);
      const reference: ProtectedAgentMemoryAccessApprovalReference =
        Object.freeze({ ...provisional, taskContinuation: Object.freeze({
          ...provisional.taskContinuation!, sealedPreparation,
        }) });
      return Object.freeze({ status: "success" as const, value: Object.freeze({
        reference,
        preview: Object.freeze({ type: source.type, content: source.content }),
      }) });
    },
    async restoreApproval({ authority, reference, memoryId, action }) {
      const state = await open(authority, reference);
      if (state === null
        || action.kind !== "grant_user"
        || state.prepared.memoryId !== memoryId
        || state.prepared.userHandle !== action.userHandle) {
        return unavailable("authorization_required");
      }
      const target = await input.resolveTarget({
        requesterUserId: input.current.subject.userId,
        requesterActorId: input.current.subject.humanActorId,
        normalizedHandle: state.target.normalizedHandle,
      });
      if (target === null || !sameTarget(target, state.target)) {
        return unavailable("stale_revision");
      }
      const foundDestination = await input.findDestination({
        requesterUserId: input.current.subject.userId,
        requesterActorId: input.current.subject.humanActorId,
        target,
      });
      const destination = foundDestination === null ? null : Object.freeze({
        roomId: foundDestination.roomId,
        namespaceId: foundDestination.namespaceId,
        humanActorIds: Object.freeze([...foundDestination.humanActorIds]),
      });
      const expectedAudience = [
        input.current.subject.humanActorId,
        target.actorId,
      ].sort();
      if (destination !== null
        && sameStrings([...destination.humanActorIds].sort(),
          expectedAudience)) {
        const recovered = await input.inspectRecovery({
          request: { authority, approvalReference: reference,
            operationId: state.prepared.operationId,
            memoryId: state.prepared.memoryId,
            action: { kind: "grant_user",
              userHandle: state.prepared.userHandle } },
          source: state.source,
          destination,
        });
        if (recovered?.status === "success") return Object.freeze({
          status: "success" as const,
          value: Object.freeze({ type: recovered.value.source.type,
            content: recovered.value.source.content }),
        });
        if (recovered?.status === "unavailable"
          && recovered.reason !== "stale_revision") return recovered;
      }
      const source = await input.openSource({
        authority,
        memoryId: state.source.memoryId,
      });
      return source === null || !sameSource(source, state.source)
        ? unavailable("stale_revision")
        : Object.freeze({ status: "success" as const, value: Object.freeze({
            type: source.type,
            content: source.content,
          }) });
    },
    async planChange(request) {
      const derived = await derive(request);
      return derived.status === "unavailable"
        ? derived
        : Object.freeze({ status: "success" as const,
            value: derived.value.plan });
    },
    async changeAuthorized(request) {
      const derived = await derive(request);
      if (derived.status === "unavailable") return derived;
      if (!samePlan(derived.value.plan, request.authorization.plan)
        || derived.value.plan.kind !== request.authorization.kind) {
        return unavailable("authorization_required");
      }
      if (request.authorization.kind === "additional_authority_v1") {
        const requiredAuthorityDigest =
          protectedTaskSemanticAuthorityRequirementsDigest(
            derived.value.plan.semanticAuthorityRequirements,
          );
        try {
          assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
            request.authorization.acknowledgement,
            {
              authorizationRequestId:
                request.authorization.plan.authorizationRequestId,
              effectDisposition: "not_started_v1",
              operationId: derived.value.plan.operationId,
              requestDigest: derived.value.plan.requestDigest,
              requiredAuthorityDigest,
            },
          );
        } catch {
          return unavailable("authorization_required");
        } finally {
          requiredAuthorityDigest.fill(0);
        }
      }
      if (!covers(requirementsFromEvidence(input.current),
        derived.value.plan.semanticAuthorityRequirements)) {
        return unavailable("authorization_required");
      }
      return input.commit({ request, source: derived.value.state.source,
        destination: derived.value.destination,
        plan: derived.value.product });
    },
  });
}
