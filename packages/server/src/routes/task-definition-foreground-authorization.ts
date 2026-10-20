import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  deriveTaskDefinitionForegroundRecipientKeyIdV1,
  parseTaskDefinitionForegroundAuthorizationIdV1,
  taskDefinitionForegroundAuthorizationIdV1,
  taskDefinitionForegroundAuthorizationIdV1Matches,
  type TaskDefinitionForegroundAuthorizationCoordinatesV1,
} from "@nautilo/lattice-bridge";
import {
  decodeLiveShadowMessagePlanV4,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  verifyHistoricalDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import type { ResolveForegroundAgentAcceptedExecutionEvidence } from
  "@nautilo/lattice-bridge/server";

export type TaskDefinitionForegroundAuthorizationCoordinates =
  TaskDefinitionForegroundAuthorizationCoordinatesV1;

/**
 * Exact current V2 bound for the retained one-Domain Task grant:
 * 1,629 maximum plan bytes + 1,586 maximum sealed one-Domain secret bytes
 * + 460 bytes of fixed authorization framing, digests and signature.
 * The parity test constructs every portable identifier at 128 ASCII bytes,
 * every counter at MAX_SAFE_INTEGER, both operations and the longest legal TTL.
 */
export const TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES = 1_629;
const TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_SEALED_SECRET_BYTES = 1_586;
const TASK_DEFINITION_FOREGROUND_AUTHORIZATION_FIXED_WIRE_BYTES = 460;
export const TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES =
  TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES
  + TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_SEALED_SECRET_BYTES
  + TASK_DEFINITION_FOREGROUND_AUTHORIZATION_FIXED_WIRE_BYTES;

export const taskDefinitionForegroundAuthorizationId =
  taskDefinitionForegroundAuthorizationIdV1;
export const parseTaskDefinitionForegroundAuthorizationId =
  parseTaskDefinitionForegroundAuthorizationIdV1;
const taskDefinitionForegroundAuthorizationIdMatches =
  taskDefinitionForegroundAuthorizationIdV1Matches;

/** Reject every other V2 purpose/scope before Task-only retained proof use. */
export function inspectTaskDefinitionForegroundAuthorizationEvidence(input: Readonly<{
  authorizationBytes: Uint8Array;
  expectedAuthorizationId: string;
  expectedPlanBytes?: Uint8Array;
  expectedRoomId: string;
  expectedHumanId: string;
  expectedNamespaceId: string;
  expectedDomainId: string;
}>): Readonly<{ planBytes: Uint8Array }> | null {
  if (input.authorizationBytes.length > TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES) {
    return null;
  }
  const authorization = parseDomainForegroundAuthorizationV2(
    input.authorizationBytes,
  );
  if (authorization === null) return null;
  const plan = parseDomainForegroundAuthorizationPlanV2(
    authorization.planBytes,
  );
  try {
    if (plan === null
      || authorization.authorizationId !== input.expectedAuthorizationId
      || plan.authorizationId !== input.expectedAuthorizationId
      || (input.expectedPlanBytes !== undefined
        && !equal(authorization.planBytes, input.expectedPlanBytes))
      || plan.roomId !== input.expectedRoomId
      || plan.subjectHumanId !== input.expectedHumanId
      || plan.recipientKind !== "runtime"
      || plan.recipientPrincipalId !== "nautilo_foreground_runtime"
      || plan.recipientAuthorizationRevision !== 0
      || plan.recipientRuntimeGeneration !== 0
      || plan.operations.length !== 2
      || plan.operations[0] !== "decrypt"
      || plan.operations[1] !== "encrypt"
      || plan.domains.length !== 1
      || plan.domainCount !== 1
      || plan.domains[0]!.sourceNamespaceId !== input.expectedNamespaceId
      || plan.domains[0]!.domainId !== input.expectedDomainId) return null;
    return Object.freeze({ planBytes: authorization.planBytes.slice() });
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyDomainForegroundAuthorizationV2(authorization);
  }
}

/** Task-only retained proof verification. This authenticates historical bytes
 * but grants no current Domain, Namespace, Memory or Task authority. */
export function verifyHistoricalTaskDefinitionForegroundAuthorizationEvidence(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    parentOperationId: string;
    taskId: string;
    operation: "create" | "update";
    targetContentRevision: number;
    workDescriptorDigest: Uint8Array;
    privateRoomId: string;
    humanId: string;
    namespaceId: string;
    domainId: string;
    committerDeviceSigningPublicKey: Uint8Array;
  }>,
): Readonly<{ status: "verified" }>
  | Readonly<{ status: "unavailable"; reason: "invalid" }> {
  let authorizationId: string;
  try { authorizationId = taskDefinitionForegroundAuthorizationId(crypto, input); }
  catch { return Object.freeze({ status: "unavailable", reason: "invalid" }); }
  const inspected = inspectTaskDefinitionForegroundAuthorizationEvidence({
    authorizationBytes: input.authorizationBytes,
    expectedAuthorizationId: authorizationId,
    expectedRoomId: input.privateRoomId,
    expectedHumanId: input.humanId,
    expectedNamespaceId: input.namespaceId,
    expectedDomainId: input.domainId,
  });
  if (inspected === null) {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  }
  try {
    return verifyHistoricalDomainForegroundAuthorizationV2(crypto, {
      authorizationBytes: input.authorizationBytes,
      expectedPlanBytes: inspected.planBytes,
      committerDeviceSigningPublicKey:
        input.committerDeviceSigningPublicKey,
    });
  } finally { inspected.planBytes.fill(0); }
}

export function createTaskDefinitionForegroundAuthorizationResolver(input: Readonly<{
  crypto: LatticeCrypto;
  expectedObjectId: string;
  taskId: string;
  operation: "create" | "update";
  targetContentRevision: number;
  privateRoomId: string;
  humanId: string;
  namespaceId: string;
  domainId: string;
  resolveAcceptedExecutionEvidence:
    ResolveForegroundAgentAcceptedExecutionEvidence;
  resolveHistoricalDeviceSigningPublicKey(context: Readonly<{
    humanId: string;
    deviceId: string;
    deviceGeneration: number;
    hostAuthorizationRevision: number;
  }>): Promise<Uint8Array | null>;
}>) {
  return async (evidence: Readonly<{
    principal: Parameters<ResolveForegroundAgentAcceptedExecutionEvidence>[0];
    authorizationHash: Uint8Array;
    objectId: string;
    authorizationBytes: Uint8Array;
  }>): Promise<Uint8Array | null> => {
    const evidenceHash = input.crypto.hash(evidence.authorizationBytes);
    try {
    if (evidence.objectId !== input.expectedObjectId
      || evidence.authorizationBytes.length
        > TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES
      || !equal(evidenceHash, evidence.authorizationHash)) return null;
    } finally {
      evidenceHash.fill(0);
    }
    const authorization = parseDomainForegroundAuthorizationV2(
      evidence.authorizationBytes,
    );
    if (authorization === null) return null;
    const plan = parseDomainForegroundAuthorizationPlanV2(
      authorization.planBytes,
    );
    if (plan === null) {
      destroyDomainForegroundAuthorizationV2(authorization);
      return null;
    }
    let parent: ReturnType<typeof decodeLiveShadowMessagePlanV4> | null = null;
    let deviceKey: Uint8Array | null = null;
    let accepted: Exclude<Awaited<ReturnType<
      ResolveForegroundAgentAcceptedExecutionEvidence
    >>, null> | null = null;
    let coordinates: TaskDefinitionForegroundAuthorizationCoordinates | null = null;
    try {
      coordinates = parseTaskDefinitionForegroundAuthorizationId(
        authorization.authorizationId,
      );
      if (coordinates === null
        || coordinates.taskId !== input.taskId
        || coordinates.operation !== input.operation
        || coordinates.targetContentRevision !== input.targetContentRevision) {
        coordinates?.parentOperationHash.fill(0);
        coordinates?.workDescriptorDigest.fill(0);
        return null;
      }
      accepted = await input.resolveAcceptedExecutionEvidence(
        evidence.principal,
        { parentOperationHash: coordinates.parentOperationHash },
      );
      if (accepted === null) return null;
      try { parent = decodeLiveShadowMessagePlanV4(accepted.planBytes); }
      catch { return null; }
      // The V4 deadline admits the Message request, not the whole foreground
      // turn. Only authenticated retained grant facts may extend that window.
      const grantLifetime = accepted.acceptedAuthority?.grantLifetime;
      if (!taskDefinitionForegroundAuthorizationIdMatches(input.crypto, {
        authorizationId: authorization.authorizationId,
        parentOperationId: parent.operationId,
        taskId: input.taskId,
        operation: input.operation,
        targetContentRevision: input.targetContentRevision,
        workDescriptorDigest: coordinates.workDescriptorDigest,
      }) || parent.subjectHumanId !== input.humanId
        || parent.recipientAgentId !== evidence.principal.agentId
        || parent.agentRuntimeGeneration !== evidence.principal.runtimeGeneration
        || parent.agentSignerKeyId !== evidence.principal.signerKeyId
        || plan.policyRevision !== parent.policyRevision
        || plan.sessionId !== parent.sessionId
        || plan.committerDeviceId !== parent.committerDeviceId
        || plan.committerDeviceSigningGeneration
          !== parent.committerDeviceSigningKeyGeneration
        || plan.hostAuthorizationRevision !== parent.hostAuthorizationRevision
        || plan.recipientKeyId
          !== deriveTaskDefinitionForegroundRecipientKeyIdV1(input.crypto, {
            authorizationId: authorization.authorizationId,
            parentAgentSignerPublicKey: parent.agentSignerPublicKey,
          })
        || plan.issuedAt < parent.issuedAt
        || (grantLifetime === undefined
          ? plan.deadlineAt > parent.deadlineAt
          : accepted.acceptedAuthority?.subjectHumanId !== input.humanId
            || plan.issuedAt < grantLifetime.issuedAt
            || plan.deadlineAt > grantLifetime.deadlineAt)) return null;
      if (!equal(parent.agentSignerPublicKey, accepted.signerPublicKey)) {
        return null;
      }
      deviceKey = await input.resolveHistoricalDeviceSigningPublicKey({
        humanId: input.humanId,
        deviceId: plan.committerDeviceId,
        deviceGeneration: plan.committerDeviceSigningGeneration,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
      });
      if (deviceKey === null) return null;
      const verified = verifyHistoricalTaskDefinitionForegroundAuthorizationEvidence(
        input.crypto,
        {
          authorizationBytes: evidence.authorizationBytes,
          parentOperationId: parent.operationId,
          taskId: input.taskId,
          operation: input.operation,
          targetContentRevision: input.targetContentRevision,
          workDescriptorDigest: coordinates.workDescriptorDigest,
          privateRoomId: input.privateRoomId,
          humanId: input.humanId,
          namespaceId: input.namespaceId,
          domainId: input.domainId,
          committerDeviceSigningPublicKey: deviceKey,
        },
      );
      return verified.status === "verified"
        ? accepted.signerPublicKey.slice() : null;
    } finally {
      deviceKey?.fill(0);
      accepted?.signerPublicKey.fill(0);
      accepted?.planBytes.fill(0);
      accepted?.planDigest.fill(0);
      coordinates?.parentOperationHash.fill(0);
      coordinates?.workDescriptorDigest.fill(0);
      if (parent !== null) destroyLiveShadowPlan(parent);
      destroyDomainForegroundAuthorizationPlanV2(plan);
      destroyDomainForegroundAuthorizationV2(authorization);
    }
  };
}

function destroyLiveShadowPlan(plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
