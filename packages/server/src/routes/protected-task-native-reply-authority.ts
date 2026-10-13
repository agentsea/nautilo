import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
import type { ProtectedTaskRuntimeMemoryPolicy } from "./protected-task-runtime-grant-plan";
import {
  actors,
  and,
  conversationSharedAgentShadowOperations,
  eq,
  isNull,
  objectCryptoAccessHeads,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  users,
  type PostgresJsBridgeConnection,
  type ProtectedTaskAwaitReplyMessageReference,
  type ProtectedTaskHumanContinuationAcceptance,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresHandle,
  type NativeTaskHumanReplyReadAuthorityV1,
  type ResolveNativeTaskHumanReplyHistoricalSigner,
} from "@nautilo/lattice-bridge/server";
import type { ProtectedTaskRunningOccurrence } from "@nautilo/runtime";
import {
  createProtectedTaskHistoricalHumanDeviceSigningKeyResolver,
} from "./protected-task-historical-human-device-signing-key";

type AcceptedBy = ProtectedTaskHumanContinuationAcceptance["acceptedBy"];

function cryptoStorageInteger(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) {
    throw new TypeError("Protected Task Human reply crypto revision is invalid");
  }
  return Number(parsed);
}

export type ProtectedTaskNativeReplyAuthorityInput = Readonly<{
  policy: ProtectedTaskRuntimeMemoryPolicy;
  occurrence: ProtectedTaskRunningOccurrence;
  evidence: TaskRuntimeExecutionEvidence;
  acceptedBy: AcceptedBy;
  message: ProtectedTaskAwaitReplyMessageReference;
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  signal: AbortSignal;
  assertCurrentTaskAuthority(): Promise<void>;
}>;

export type ProtectedTaskNativeReplyAuthorityResolver = Readonly<{
  readCurrent(): Promise<NativeTaskHumanReplyReadAuthorityV1 | null>;
}>;

/**
 * Adapts the retained Human device-key lookup to the Human-v2 reply verifier
 * while pinning the manifest's device to the exact accepted Human actor.
 */
export function createProtectedTaskHistoricalHumanReplySignerResolver(
  handle: CryptoPostgresHandle,
): ResolveNativeTaskHumanReplyHistoricalSigner {
  const resolveDeviceKey =
    createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle);
  return async ({ sourceHumanActorId, context }) => {
    const committerSigningPublicKey = await resolveDeviceKey({
      subjectHumanId: sourceHumanActorId,
      committerDeviceId: context.committerDeviceId,
      hostAuthorizationRevision: context.hostAuthorizationRevision,
    });
    return committerSigningPublicKey === null ? null : Object.freeze({
      ...context,
      committerSigningPublicKey,
    });
  };
}

export type ProtectedTaskNativeReplyMessageProjection = Readonly<{
  messageId: number;
  sessionId: string;
  editRevision: number;
  role: string;
  createdAt: Date;
  cryptoObjectId: string | null;
  content: string | null;
  toolCalls: string | null;
  toolName: string | null;
  metadata: unknown;
  sessionOwnerId: string;
  sessionAgentId: string | null;
  roomId: string | null;
  namespaceId: string;
  lifecycleRoomId: string;
  lifecycleNamespaceId: string;
  lifecycleCryptoObjectId: string;
  objectIdScheme: string;
  representationMode: string;
  publicationPolicyRevision: number | null;
  payloadVersion: number;
  keyClass: string;
  authorRole: string;
  parityStatus: string;
  completion: string;
  disposition: string;
  lifecycleOperationId: string | null;
  shadowOperationId: string | null;
  humanPeerShadowOperationId: string | null;
  sharedAgentShadowExecutionId: string | null;
  operationId: string;
  operationState: string;
  operationSessionId: string;
  operationRoomId: string;
  operationMessageId: number;
  operationMessageCreatedAt: Date;
  operationSubjectHumanId: string;
  operationNamespaceId: string;
  operationCryptoObjectId: string;
  operationTerminalAt: Date | null;
  actorId: string;
  actorOwnerId: string;
  actorKind: string;
  actorDisabledAt: Date | null;
}>;

export type ProtectedTaskNativeReplyAuthorityDependencies = Readonly<{
  assertEvidence(evidence: TaskRuntimeExecutionEvidence): void;
  readProductProjection(
    input: ProtectedTaskNativeReplyAuthorityInput,
  ): Promise<ProtectedTaskNativeReplyMessageProjection | null>;
  readCryptoAccessRevision(
    input: ProtectedTaskNativeReplyAuthorityInput,
  ): Promise<number | null>;
}>;

function exactMessageProjection(
  row: ProtectedTaskNativeReplyMessageProjection | undefined,
  input: ProtectedTaskNativeReplyAuthorityInput,
): row is ProtectedTaskNativeReplyMessageProjection {
  if (row === undefined) return false;
  const reference = input.message;
  const messageId = Number(reference.messageId);
  const full = row.representationMode === "full_encryption";
  return row.messageId === messageId
    && row.sessionId === reference.sessionId
    && row.editRevision === reference.editRevision
    && row.role === "user"
    && row.cryptoObjectId === reference.cryptoObjectId
    && row.sessionOwnerId === reference.sourceUserId
    && row.sessionAgentId === input.occurrence.task.agentId
    && row.roomId === reference.roomId
    && row.namespaceId === reference.namespaceId
    && row.lifecycleRoomId === reference.roomId
    && row.lifecycleNamespaceId === reference.namespaceId
    && row.lifecycleCryptoObjectId === reference.cryptoObjectId
    && row.objectIdScheme === "live_shadow_v1"
    && (row.representationMode === "shadow_encryption" || full)
    && (full
      ? row.publicationPolicyRevision !== null
        && row.parityStatus === "client_authenticated"
        && row.content === null
        && row.toolCalls === null
        && row.toolName === null
        && row.metadata === null
      : row.publicationPolicyRevision === null
        && row.parityStatus === "client_verified")
    && row.payloadVersion === 2
    && row.keyClass === "ai"
    && row.authorRole === "user"
    && row.completion === "complete"
    && row.disposition === "mapped"
    && row.lifecycleOperationId === row.operationId
    && row.shadowOperationId === null
    && row.humanPeerShadowOperationId === null
    && row.sharedAgentShadowExecutionId === null
    && row.operationState === "published"
    && row.operationSessionId === reference.sessionId
    && row.operationRoomId === reference.roomId
    && row.operationMessageId === messageId
    && row.operationMessageCreatedAt.getTime() === row.createdAt.getTime()
    && row.operationSubjectHumanId === input.acceptedBy.humanActorId
    && row.operationNamespaceId === reference.namespaceId
    && row.operationCryptoObjectId === reference.cryptoObjectId
    && row.operationTerminalAt !== null
    && row.operationTerminalAt.getTime() >= row.createdAt.getTime()
    && row.actorId === input.acceptedBy.humanActorId
    && row.actorOwnerId === input.acceptedBy.userId
    && row.actorKind === "user"
    && row.actorDisabledAt === null
    && input.acceptedBy.userId === reference.sourceUserId;
}

async function readProductProjection(
  input: ProtectedTaskNativeReplyAuthorityInput,
): Promise<ProtectedTaskNativeReplyMessageProjection | null> {
  const messageId = Number(input.message.messageId);
  return input.runner.transaction(async tx => {
    const rows = await tx.select({
      messageId: sessionMessages.id,
      sessionId: sessionMessages.sessionId,
      editRevision: sessionMessages.editRevision,
      role: sessionMessages.role,
      createdAt: sessionMessages.createdAt,
      cryptoObjectId: sessionMessages.cryptoObjectId,
      content: sessionMessages.content,
      toolCalls: sessionMessages.toolCalls,
      toolName: sessionMessages.toolName,
      metadata: sessionMessages.metadata,
      sessionOwnerId: sessions.ownerId,
      sessionAgentId: sessions.agentId,
      roomId: sessions.roomId,
      namespaceId: rooms.namespaceId,
      lifecycleRoomId: sessionMessageCryptoRevisions.roomId,
      lifecycleNamespaceId:
        sessionMessageCryptoRevisions.namespaceIdAtAllocation,
      lifecycleCryptoObjectId: sessionMessageCryptoRevisions.cryptoObjectId,
      objectIdScheme: sessionMessageCryptoRevisions.objectIdScheme,
      representationMode: sessionMessageCryptoRevisions.representationMode,
      publicationPolicyRevision:
        sessionMessageCryptoRevisions.publicationPolicyRevision,
      payloadVersion: sessionMessageCryptoRevisions.payloadVersion,
      keyClass: sessionMessageCryptoRevisions.keyClass,
      authorRole: sessionMessageCryptoRevisions.authorRole,
      parityStatus: sessionMessageCryptoRevisions.parityStatus,
      completion: sessionMessageCryptoRevisions.completion,
      disposition: sessionMessageCryptoRevisions.disposition,
      lifecycleOperationId:
        sessionMessageCryptoRevisions.sharedAgentShadowOperationId,
      shadowOperationId: sessionMessageCryptoRevisions.shadowOperationId,
      humanPeerShadowOperationId:
        sessionMessageCryptoRevisions.humanPeerShadowOperationId,
      sharedAgentShadowExecutionId:
        sessionMessageCryptoRevisions.sharedAgentShadowExecutionId,
      operationId: conversationSharedAgentShadowOperations.operationId,
      operationState: conversationSharedAgentShadowOperations.state,
      operationSessionId: conversationSharedAgentShadowOperations.sessionId,
      operationRoomId: conversationSharedAgentShadowOperations.roomId,
      operationMessageId:
        conversationSharedAgentShadowOperations.humanMessageId,
      operationMessageCreatedAt:
        conversationSharedAgentShadowOperations.humanMessageCreatedAt,
      operationSubjectHumanId:
        conversationSharedAgentShadowOperations.subjectHumanId,
      operationNamespaceId:
        conversationSharedAgentShadowOperations.namespaceId,
      operationCryptoObjectId:
        conversationSharedAgentShadowOperations.cryptoObjectId,
      operationTerminalAt: conversationSharedAgentShadowOperations.terminalAt,
      actorId: actors.id,
      actorOwnerId: actors.ownerId,
      actorKind: actors.kind,
      actorDisabledAt: users.disabledAt,
    }).from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .innerJoin(sessionMessageCryptoRevisions, and(
        eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
        eq(
          sessionMessageCryptoRevisions.editRevision,
          sessionMessages.editRevision,
        ),
      ))
      .innerJoin(conversationSharedAgentShadowOperations, eq(
        conversationSharedAgentShadowOperations.operationId,
        sessionMessageCryptoRevisions.sharedAgentShadowOperationId,
      ))
      .innerJoin(actors, and(
        eq(actors.id, conversationSharedAgentShadowOperations.subjectHumanId),
        eq(actors.ownerId, sessions.ownerId),
        eq(actors.kind, "user"),
      ))
      .innerJoin(users, and(
        eq(users.id, actors.ownerId),
        isNull(users.disabledAt),
      ))
      .where(and(
        eq(sessionMessages.id, messageId),
        eq(sessionMessages.sessionId, input.message.sessionId),
        eq(sessionMessages.editRevision, input.message.editRevision),
      )).limit(2).for("share");
    const row = rows[0];
    return rows.length === 1 && exactMessageProjection(row, input)
      ? Object.freeze({ ...row }) as ProtectedTaskNativeReplyMessageProjection
      : null;
  }, { isolationLevel: "read committed" });
}

async function readCryptoAccessRevision(
  input: ProtectedTaskNativeReplyAuthorityInput,
): Promise<number | null> {
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const accessRows = await executeTypedCryptoQuery(
    handle,
    cryptoTypedDb.select({
      object_id: objectCryptoAccessHeads.objectId,
      access_revision: objectCryptoAccessHeads.accessRevision,
    }).from(objectCryptoAccessHeads).where(eq(
      objectCryptoAccessHeads.objectId,
      input.message.cryptoObjectId,
    )).limit(2),
  );
  const access = accessRows[0];
  return accessRows.length === 1
      && access !== undefined
      && access.object_id === input.message.cryptoObjectId
    ? cryptoStorageInteger(access.access_revision)
    : null;
}

const productionDependencies: ProtectedTaskNativeReplyAuthorityDependencies =
  Object.freeze({
    assertEvidence: assertAuthenticTaskRuntimeExecutionEvidence,
    readProductProjection,
    readCryptoAccessRevision,
  });

/**
 * Reconstructs the exact current authority for one accepted Human reply.
 * Product and crypto coordinates are reread on every call; the opener compares
 * this projection before and after plaintext use.
 */
export function createProtectedTaskNativeReplyAuthorityResolver(
  input: ProtectedTaskNativeReplyAuthorityInput,
  overrides: Partial<ProtectedTaskNativeReplyAuthorityDependencies> = {},
): ProtectedTaskNativeReplyAuthorityResolver {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  const messageId = Number(input.message.messageId);
  if (input.runner.role !== "nautilo"
    || input.occurrence.run.status !== "running"
    || typeof input.occurrence.run.jobId !== "string"
    || input.occurrence.run.jobId.length === 0
    || !(input.signal instanceof AbortSignal)
    || !Number.isSafeInteger(messageId)
    || messageId < 1
    || input.message.messageId !== String(messageId)
    || input.acceptedBy.userId !== input.message.sourceUserId
    || input.evidence.purpose !== "task.runtime.execution"
    || input.evidence.result.taskId !== input.occurrence.task.id
    || input.evidence.result.taskRunId !== input.occurrence.run.id
    || input.evidence.result.signerAgentId !== input.occurrence.task.agentId
    || input.evidence.workId !== input.occurrence.run.id) {
    throw new TypeError("Protected Task Human reply authority is invalid");
  }
  dependencies.assertEvidence(input.evidence);
  const requirements = input.evidence.namespaceRequirements.filter(entry =>
    entry.namespaceId === input.message.namespaceId);
  const requirement = requirements[0];
  const domains = requirement === undefined ? []
    : input.evidence.domainRequirements.filter(entry =>
      entry.domainId === requirement.domainId);
  const domain = domains[0];
  if (requirements.length !== 1
    || requirement === undefined
    || !requirement.operations.includes("decrypt")
    || requirement.expectedPolicyRevision !== input.evidence.policyRevision
    || domains.length !== 1
    || domain === undefined) {
    throw new TypeError(
      "Protected Task Human reply decrypt authority is unavailable",
    );
  }
  const mode = input.policy.mode;
  if (!protectedTaskDefinitionSupportsPolicy(input.occurrence.task.contentRepresentation, mode)
    || input.policy.revision !== input.evidence.policyRevision) {
    throw new TypeError("Protected Task Human reply policy is unavailable");
  }

  return Object.freeze({
    readCurrent: async () => {
      input.signal.throwIfAborted();
      try {
        dependencies.assertEvidence(input.evidence);
        await input.assertCurrentTaskAuthority();
        input.signal.throwIfAborted();
        const product = await dependencies.readProductProjection(input);
        if (product === null) return null;
        const cryptoAccessRevision =
          await dependencies.readCryptoAccessRevision(input);
        if (cryptoAccessRevision === null) return null;
        await input.assertCurrentTaskAuthority();
        input.signal.throwIfAborted();
        return Object.freeze({
          mode,
          taskId: input.occurrence.task.id,
          taskRunId: input.occurrence.run.id,
          sourceRoomId: input.evidence.sourceRoomId,
          roomId: input.message.roomId,
          sessionId: input.message.sessionId,
          messageId,
          revision: input.message.editRevision,
          sourceUserId: input.message.sourceUserId,
          sourceHumanActorId: input.acceptedBy.humanActorId,
          agentId: input.occurrence.task.agentId,
          createdAt: product.createdAt.getTime(),
          objectId: input.message.cryptoObjectId,
          cryptoAccessRevision,
          namespaceId: input.message.namespaceId,
          domainId: requirement.domainId,
          expectedAccessRevision: requirement.expectedAccessRevision,
          expectedPolicyRevision: requirement.expectedPolicyRevision,
        });
      } catch (error) {
        input.signal.throwIfAborted();
        if (error instanceof TypeError) return null;
        throw error;
      }
    },
  });
}
