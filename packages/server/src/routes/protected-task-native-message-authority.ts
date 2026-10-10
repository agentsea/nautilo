import { bytesToHex } from "@noble/hashes/utils.js";
import {
  and,
  eq,
  sessionMessageCryptoRevisions,
  sessionMessages,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import { deriveMessageCryptoObjectIdV2 } from "@nautilo/lattice-bridge";
import {
  PostgresDomainKeyAuthorityRepository,
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type NativeTaskMessageAuthority,
  type NativeTaskMessageCoordinates,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";
import type {
  TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";

import {
  createProtectedTaskMessageProductGuard,
  type ProtectedTaskMessageProductAuthority,
} from "./protected-task-message-product-authority";
import {
  createCurrentProtectedTaskRuntimeAuthorityPort,
  type CurrentProtectedTaskRuntimeAuthorityPort,
  type HeldProtectedTaskRuntimeAuthority,
} from "./task-runtime-current-authority";

type NamespaceProjection = Readonly<{
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespaceBindingDigest: string;
  bundleRevision: number;
  retainedAuthoritySetDigest: string;
  domainId: string;
  domainKeyGeneration: number;
  domainAuthorizationRevision: number;
  domainHeadDigest: string;
}>;

type SignerProjection = Readonly<{
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
}>;

export type ProtectedTaskNativeMessageAuthorityInput = Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  subject: TaskRuntimeAuthoritySubject;
  evidence: TaskRuntimeExecutionEvidence;
  coordinates: NativeTaskMessageCoordinates;
  createdAt: number;
  productAuthority: ProtectedTaskMessageProductAuthority;
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  now(): number;
  signal: AbortSignal;
}>;

export type ProtectedTaskNativeMessageAuthorityDependencies = Readonly<{
  assertEvidence(evidence: TaskRuntimeExecutionEvidence): void;
  validateProduct(
    input: ProtectedTaskNativeMessageAuthorityInput,
    expected: NativeTaskMessageAuthority,
  ): Promise<boolean>;
  withCurrentAuthority: CurrentProtectedTaskRuntimeAuthorityPort;
  inspectNamespace(
    input: ProtectedTaskNativeMessageAuthorityInput,
    expected: NativeTaskMessageAuthority,
  ): Promise<NamespaceProjection | null>;
  inspectSigner(
    input: ProtectedTaskNativeMessageAuthorityInput,
    expected: NativeTaskMessageAuthority,
  ): Promise<SignerProjection | null>;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactMessageRows(
  message: typeof sessionMessages.$inferSelect | undefined,
  lifecycle: typeof sessionMessageCryptoRevisions.$inferSelect | undefined,
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): boolean {
  if (message === undefined || lifecycle === undefined) return false;
  const mapped = message.cryptoObjectId === expected.objectId;
  const pending = message.cryptoObjectId === null;
  const lifecycleState = lifecycle.completion === "pending"
    ? lifecycle.disposition === "active" && pending
    : lifecycle.completion === "complete"
      && (lifecycle.disposition === "active" && pending
        || lifecycle.disposition === "mapped" && mapped);
  return message.id === expected.messageId
    && message.sessionId === expected.sessionId
    && message.editRevision === expected.revision
    && message.role === expected.role
    && message.createdAt.getTime() === expected.createdAt
    && (pending || mapped)
    && message.humanTurnId === null
    && message.transcriptOrigin === "subagent"
    && (input.productAuthority.representation !== "protected"
      || message.content === null
        && message.toolCalls === null
        && message.toolName === null
        && message.metadata === null)
    && lifecycle.sessionId === expected.sessionId
    && lifecycle.messageId === expected.messageId
    && lifecycle.editRevision === expected.revision
    && lifecycle.roomId === expected.roomId
    && lifecycle.namespaceIdAtAllocation === expected.namespaceId
    && lifecycle.cryptoObjectId === expected.objectId
    && lifecycle.objectIdScheme === "message_v2"
    && lifecycle.representationMode === (expected.mode === "shadow_encryption"
      ? "shadow_encryption"
      : "full_encryption")
    && lifecycle.publicationPolicyRevision === (expected.mode === "shadow_encryption"
      ? null
      : expected.policyRevision)
    && lifecycle.keyClass === "ai"
    && lifecycle.authorRole === expected.role
    && lifecycle.appendIdempotencyKey?.startsWith(
      `task-transcript:${expected.taskRunId}:fp:v1:`,
    ) === true
    && lifecycle.shadowOperationId === null
    && lifecycle.humanPeerShadowOperationId === null
    && lifecycle.sharedAgentShadowOperationId === null
    && lifecycle.sharedAgentShadowExecutionId === null
    && lifecycle.failureCode === null
    && lifecycleState;
}

async function validateProduct(
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): Promise<boolean> {
  const guard = createProtectedTaskMessageProductGuard(
    input.productAuthority,
    input.now,
  );
  try {
    return await input.runner.transaction(async (tx) => {
      await guard.assertPublicationAllowed(tx, {
        action: "markCryptoComplete",
        sessionId: expected.sessionId,
        messageId: expected.messageId,
        revision: expected.revision,
      });
      const [message] = await tx.select().from(sessionMessages).where(and(
        eq(sessionMessages.sessionId, expected.sessionId),
        eq(sessionMessages.id, expected.messageId),
      )).limit(2).for("share");
      const [lifecycle] = await tx.select()
        .from(sessionMessageCryptoRevisions).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, expected.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, expected.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, expected.revision),
        )).limit(2).for("share");
      return exactMessageRows(message, lifecycle, input, expected);
    }, { isolationLevel: "read committed" });
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof TypeError) return false;
    throw error;
  }
}

async function inspectNamespace(
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): Promise<NamespaceProjection | null> {
  const authority = await new PostgresDomainKeyAuthorityRepository(
    input.restricted,
    input.crypto,
    input.serverScope,
  ).inspectForegroundNamespaceAuthority({
    namespaceId: expected.namespaceId,
    keyClass: "ai",
  });
  if (authority.status !== "ready") return null;
  try {
    return Object.freeze({
      namespaceId: authority.namespaceId,
      namespaceAccessRevision: authority.namespaceAccessRevision,
      namespaceKeyGeneration: authority.namespaceKeyGeneration,
      namespaceBindingDigest: bytesToHex(authority.bundleDigest),
      bundleRevision: authority.bundleRevision,
      retainedAuthoritySetDigest: bytesToHex(authority.namespaceHeadDigest),
      domainId: authority.domainId,
      domainKeyGeneration: authority.domainKeyGeneration,
      domainAuthorizationRevision: authority.domainAuthorizationRevision,
      domainHeadDigest: bytesToHex(authority.domainHeadDigest),
    });
  } finally {
    authority.namespaceHeadDigest.fill(0);
    authority.namespacePublicationDigest.fill(0);
    authority.namespacePublicationSetDigest.fill(0);
    authority.namespaceAudienceFingerprint.fill(0);
    authority.domainHeadDigest.fill(0);
    authority.bundleDigest.fill(0);
  }
}

function wipeNested(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) wipeNested(nested);
  }
}

async function inspectSigner(
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): Promise<SignerProjection | null> {
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const storage = new PostgresLatticeStorage(handle);
  const state = await storage.getAgentRuntimeAtomicState(expected.agentId);
  if (state === null) return null;
  let publication: Awaited<ReturnType<
    typeof storage.getAgentRuntimeSignerPublication
  >> = null;
  try {
    const generation = state.runtime.runtimeGeneration;
    publication = await storage.getAgentRuntimeSignerPublication(
      expected.agentId,
      generation,
    );
    const envelopes = state.domainEnvelopes.filter((entry) =>
      entry.agentId === expected.agentId
      && entry.domainId === expected.domainId
      && entry.domainEpoch === expected.domainKeyGeneration
      && entry.agentAuthorizationRevision
        === state.runtime.authorizationRevision
      && entry.runtimeGeneration === generation
    );
    if (publication === null
      || state.runtime.agentId !== expected.agentId
      || envelopes.length !== 1
      || publication.agentId !== expected.agentId
      || publication.runtimeGeneration !== generation
      || publication.authorizationRevision
        !== state.runtime.authorizationRevision) return null;
    return Object.freeze({
      runtimeGeneration: generation,
      agentAuthorizationRevision: state.runtime.authorizationRevision,
      signerKeyId: publication.signerKeyId,
    });
  } finally {
    wipeNested(state);
    wipeNested(publication);
  }
}

function sameNamespaceRequirements(
  current: HeldProtectedTaskRuntimeAuthority["namespaceRequirements"],
  expected: TaskRuntimeExecutionEvidence["namespaceRequirements"],
): boolean {
  return current.length === expected.length
    && current.every((entry, index) => {
      const other = expected[index];
      return other !== undefined
        && entry.ordinal === other.ordinal
        && entry.namespaceId === other.namespaceId
        && entry.domainId === other.domainId
        && entry.expectedAccessRevision === other.expectedAccessRevision
        && entry.expectedPolicyRevision === other.expectedPolicyRevision
        && entry.operations.join(",") === other.operations.join(",");
    });
}

function exactGrant(
  current: HeldProtectedTaskRuntimeAuthority,
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): boolean {
  const foreground = current.foreground;
  const targetRequirements = current.namespaceRequirements.filter((entry) =>
    entry.namespaceId === expected.namespaceId
  );
  const targetRequirement = targetRequirements[0];
  const domains = foreground.domains.filter((entry) =>
    entry.domainId === expected.domainId
  );
  const domain = domains[0];
  const evidenceDomains = input.evidence.domainRequirements.filter((entry) =>
    entry.domainId === expected.domainId
  );
  const evidenceDomain = evidenceDomains[0];
  return foreground.authorizationId === expected.requestId
    && foreground.policyRevision === expected.policyRevision
    && foreground.sessionId === expected.episodeId
    && foreground.roomId === expected.sourceRoomId
    && foreground.subjectHumanId === input.subject.humanActorId
    && foreground.committerDeviceId === input.subject.deviceId
    && foreground.hostAuthorizationRevision
      === expected.hostAuthorizationRevision
    && foreground.recipientKind === "runtime"
    && foreground.recipientPrincipalId === "nautilo_task_runtime"
    && foreground.recipientAuthorizationRevision
      === expected.recipientAuthorizationRevision
    && foreground.recipientRuntimeGeneration
      === input.evidence.recipientGeneration
    && foreground.recipientKeyId === input.evidence.recipientKeyId
    && sameNamespaceRequirements(
      current.namespaceRequirements,
      input.evidence.namespaceRequirements,
    )
    && targetRequirements.length === 1
    && targetRequirement !== undefined
    && targetRequirement.domainId === expected.domainId
    && targetRequirement.operations.includes("encrypt")
    && targetRequirement.expectedAccessRevision
      === expected.namespaceAccessRevision
    && targetRequirement.expectedPolicyRevision === expected.policyRevision
    && domains.length === 1
    && domain !== undefined
    && evidenceDomains.length === 1
    && evidenceDomain !== undefined
    && domain.sourceNamespaceId === evidenceDomain.sourceNamespaceId
    && domain.keyClass === "ai"
    && domain.domainKeyGeneration === expected.domainKeyGeneration
    && domain.authorizationRevision === expected.domainAuthorizationRevision
    && domain.participantCount === expected.participantCount
    && sameBytes(domain.participantDigest, evidenceDomain.participantDigest)
    && bytesToHex(domain.participantDigest) === expected.participantDigest
    && sameBytes(domain.headDigest, evidenceDomain.headDigest)
    && bytesToHex(domain.headDigest) === expected.domainHeadDigest
    && domain.activeNamespaceBindingCount
      === expected.activeNamespaceBindingCount
    && sameBytes(
      domain.activeNamespaceBindingSetDigest,
      evidenceDomain.activeNamespaceBindingSetDigest,
    )
    && bytesToHex(domain.activeNamespaceBindingSetDigest)
      === expected.activeNamespaceBindingSetDigest;
}

function exactFixedProjection(
  input: ProtectedTaskNativeMessageAuthorityInput,
  expected: NativeTaskMessageAuthority,
): boolean {
  const { occurrence, evidence, coordinates, productAuthority } = input;
  return input.record.snapshot.state === "running"
    && input.record.snapshot.claimId === evidence.claimId
    && input.record.snapshot.requestId === evidence.requestId
    && input.record.snapshot.workId === evidence.workId
    && input.record.expectedPolicyRevision === evidence.policyRevision
    && input.request.requestId === evidence.requestId
    && input.request.workId === evidence.workId
    && input.request.episodeId === evidence.episodeId
    && input.request.sourceRoomId === evidence.sourceRoomId
    && occurrence.task.id === evidence.result.taskId
    && occurrence.run.id === evidence.workId
    && occurrence.run.id === evidence.result.taskRunId
    && occurrence.task.agentId === evidence.result.signerAgentId
    && coordinates.taskId === occurrence.task.id
    && coordinates.taskRunId === occurrence.run.id
    && coordinates.graphThreadId === occurrence.run.graphThreadId
    && coordinates.roomId === productAuthority.roomId
    && coordinates.agentId === occurrence.task.agentId
    && coordinates.objectId === deriveMessageCryptoObjectIdV2(coordinates)
    && expected.taskId === coordinates.taskId
    && expected.taskRunId === coordinates.taskRunId
    && expected.sessionId === coordinates.sessionId
    && expected.messageId === coordinates.messageId
    && expected.revision === coordinates.revision
    && expected.roomId === coordinates.roomId
    && expected.graphThreadId === coordinates.graphThreadId
    && expected.humanTurnId === coordinates.humanTurnId
    && expected.agentId === coordinates.agentId
    && expected.objectId === coordinates.objectId
    && expected.role === coordinates.role
    && expected.mode === (productAuthority.representation === "dual"
      ? "shadow_encryption"
      : "encrypted_only")
    && expected.serverId === input.serverScope
    && expected.requestId === evidence.requestId
    && expected.sourceRoomId === evidence.sourceRoomId
    && expected.episodeId === evidence.episodeId
    && expected.hostAuthorizationRevision
      === evidence.hostAuthorizationRevision
    && expected.recipientAuthorizationRevision
      === evidence.recipientAuthorizationRevision
    && expected.claimId === evidence.claimId
    && expected.authorizationDigest === bytesToHex(
      evidence.authorizationDigest,
    )
    && expected.policyRevision === evidence.policyRevision
    && expected.createdAt === input.createdAt
    && expected.namespaceId === productAuthority.namespaceId
    && productAuthority.taskId === occurrence.task.id
    && productAuthority.taskRunId === occurrence.run.id
    && productAuthority.taskOwnerId === occurrence.task.ownerId
    && productAuthority.graphThreadId === occurrence.run.graphThreadId
    && productAuthority.sessionId === coordinates.sessionId
    && productAuthority.agentId === occurrence.task.agentId
    && productAuthority.requestorId === occurrence.task.requestorId
    && productAuthority.contentNamespaceId
      === occurrence.task.contentNamespaceId
    && productAuthority.contentRevision === occurrence.task.contentRevision
    && productAuthority.requiredNamespaceFingerprint.length
      === occurrence.task.cryptoRequiredNamespaceFingerprint.length
    && productAuthority.requiredNamespaceFingerprint.every((value, index) =>
      value === occurrence.task.cryptoRequiredNamespaceFingerprint[index]
    )
    && productAuthority.inputObjectId === occurrence.task.cryptoObjectId
    && productAuthority.representation
      === occurrence.task.contentRepresentation
    && productAuthority.authorizationRequestId === evidence.requestId
    && productAuthority.resultObjectId === evidence.result.objectId
    && productAuthority.policyRevision === evidence.policyRevision
    && productAuthority.authorizationExpiresAt === evidence.expiresAt
    && productAuthority.signal === input.signal;
}

function sameNamespace(
  current: NamespaceProjection,
  expected: NativeTaskMessageAuthority,
): boolean {
  return current.namespaceId === expected.namespaceId
    && current.namespaceAccessRevision === expected.namespaceAccessRevision
    && current.namespaceKeyGeneration === expected.namespaceKeyGeneration
    && current.namespaceBindingDigest === expected.namespaceBindingDigest
    && current.bundleRevision === expected.bundleRevision
    && current.retainedAuthoritySetDigest
      === expected.retainedAuthoritySetDigest
    && current.domainId === expected.domainId
    && current.domainKeyGeneration === expected.domainKeyGeneration
    && current.domainAuthorizationRevision
      === expected.domainAuthorizationRevision
    && current.domainHeadDigest === expected.domainHeadDigest;
}

function sameSigner(
  current: SignerProjection,
  expected: NativeTaskMessageAuthority,
): boolean {
  return current.runtimeGeneration === expected.runtimeGeneration
    && current.agentAuthorizationRevision
      === expected.agentAuthorizationRevision
    && current.signerKeyId === expected.signerKeyId;
}

const productionDependencies: ProtectedTaskNativeMessageAuthorityDependencies =
  Object.freeze({
    assertEvidence: assertAuthenticTaskRuntimeExecutionEvidence,
    validateProduct,
    withCurrentAuthority: createCurrentProtectedTaskRuntimeAuthorityPort(),
    inspectNamespace,
    inspectSigner,
  });

/**
 * Dark exact-current resolver shared by native Task Message preparation and
 * crypto completion. It never creates a grant or publishes a Message.
 */
export function createProtectedTaskNativeMessageAuthorityResolver(
  input: ProtectedTaskNativeMessageAuthorityInput,
  overrides: Partial<ProtectedTaskNativeMessageAuthorityDependencies> = {},
): (expected: NativeTaskMessageAuthority) =>
  Promise<NativeTaskMessageAuthority | null> {
  if (input.occurrence.run.status !== "running"
    || typeof input.occurrence.run.jobId !== "string"
    || input.occurrence.run.jobId.length === 0
    || !Number.isSafeInteger(input.createdAt)
    || input.createdAt < 0
    || input.serverScope.length === 0
    || !(input.signal instanceof AbortSignal)
    || input.productAuthority.signal !== input.signal) {
    throw new TypeError("Protected Task Message authority identity is invalid");
  }
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  return async expected => {
    input.signal.throwIfAborted();
    try {
      dependencies.assertEvidence(input.evidence);
    } catch {
      input.signal.throwIfAborted();
      return null;
    }
    if (!exactFixedProjection(input, expected)) return null;
    const productCurrent = await dependencies.validateProduct(input, expected);
    input.signal.throwIfAborted();
    if (!productCurrent) return null;
    const grantCurrent = await dependencies.withCurrentAuthority({
      runner: input.runner,
      restricted: input.restricted,
      crypto: input.crypto,
      serverScope: input.serverScope,
      subject: input.subject,
      occurrence: input.occurrence,
      record: input.record,
      request: input.request,
      now: input.now,
      signal: input.signal,
      use: current => exactGrant(current, input, expected),
    });
    input.signal.throwIfAborted();
    if (grantCurrent !== true) return null;
    const [namespace, signer] = await Promise.all([
      dependencies.inspectNamespace(input, expected),
      dependencies.inspectSigner(input, expected),
    ]);
    input.signal.throwIfAborted();
    if (namespace === null || signer === null
      || !sameNamespace(namespace, expected)
      || !sameSigner(signer, expected)) return null;
    try {
      dependencies.assertEvidence(input.evidence);
    } catch {
      input.signal.throwIfAborted();
      return null;
    }
    return Object.freeze({ ...expected });
  };
}
