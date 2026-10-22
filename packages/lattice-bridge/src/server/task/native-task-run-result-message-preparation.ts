import { bytesToHex } from "@noble/hashes/utils.js";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  assertTaskRuntimeTemporarySignerForPreparation,
  assertU64Counter,
  encryptedObjectWriteRecord,
  unixTimestamp,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeTemporarySigner,
} from "@nautilo/lattice-crypto";

import {
  assertConversationDurableKey,
  deriveMessageCryptoObjectIdV2,
} from "../../message/conversation-repository.ts";
import {
  assertAuthenticNativeProtectedTaskRunResultMessageSourceV1,
  type NativeProtectedTaskRunResultMessageSourceV1,
} from "./native-protected-task-run-result-opener.ts";
import { encryptNativeTaskAssistantMessage } from
  "./native-task-assistant-message-encryption.ts";
import type { NativeTaskNamespaceSource } from
  "./native-task-message-preparation.ts";

export type NativeTaskRunResultMessageAllocation = Readonly<{
  sessionId: string;
  messageId: number;
  revision: 0;
  objectId: string;
  createdAt: number;
  mode: "shadow_encryption" | "encrypted_only";
  acceptedPolicyRevision: number;
  publicationPolicyRevision: number;
}>;

export type NativeTaskRunResultMessageAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: 0;
  objectId: string;
  roomId: string;
  namespaceId: string;
  domainId: string;
  mode: "shadow_encryption" | "encrypted_only";
  acceptedPolicyRevision: number;
  publicationPolicyRevision: number;
  signerAgentId: string;
  payloadDigest: string;
  role: "assistant";
  createdAt: number;
  serverId: string;
  requesterHumanId: string;
  requestId: string;
  workId: string;
  claimId: string;
  recipientGeneration: number;
  recipientKeyId: string;
  authorizationDigest: string;
  claimExpiresAt: number;
  recipientExpiresAt: number;
  authorizationExpiresAt: number;
  expiresAt: number;
  sourceRoomId: string;
  episodeId: string;
  hostAuthorizationRevision: number;
  recipientAuthorizationRevision: number;
  resultTerminalStatus: "completed" | "errored";
  resultContentRevision: 1;
  resultObjectId: string;
  resultGenesisManifestHash: string;
  resultCryptoAccessRevision: number;
  resultNamespaceId: string;
  resultDomainId: string;
  resultNamespaceAccessRevision: number;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespaceBindingDigest: string;
  bundleRevision: number;
  retainedAuthoritySetDigest: string;
  domainKeyGeneration: number;
  domainAuthorizationRevision: number;
  domainHeadDigest: string;
  participantDigest: string;
  participantCount: number;
  activeNamespaceBindingSetDigest: string;
  activeNamespaceBindingCount: number;
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
  signerAuthorizationHash?: string;
  signerHostAuthorizationRevision?: number;
}>;

export type PrepareNativeTaskRunResultMessageInput = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeRunResultReadEvidence;
  source: NativeProtectedTaskRunResultMessageSourceV1;
  allocation: NativeTaskRunResultMessageAllocation;
  namespace: NativeTaskNamespaceSource;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication | null;
  temporarySigner?: TaskRuntimeTemporarySigner;
  agentAuthorizationRevision: number;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  signal: AbortSignal;
  resolveCurrentAuthority(expected: NativeTaskRunResultMessageAuthority):
    Promise<NativeTaskRunResultMessageAuthority | null>;
}>;

declare const preparedRunResultMessageBrand: unique symbol;
export type PreparedNativeTaskRunResultMessage = Readonly<{
  purpose: "native-task-run-result-message-preparation";
  authority: NativeTaskRunResultMessageAuthority;
  readonly [preparedRunResultMessageBrand]: true;
}>;

export type NativeTaskRunResultMessageSnapshot = Readonly<{
  authority: NativeTaskRunResultMessageAuthority;
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly [Uint8Array];
  signerEvidenceBytes?: Uint8Array;
}>;

const snapshots = new WeakMap<PreparedNativeTaskRunResultMessage,
  NativeTaskRunResultMessageSnapshot>();

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: NativeTaskRunResultMessageAuthority,
  right: NativeTaskRunResultMessageAuthority,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskRunResultMessageAuthority)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

function sameReadSource(
  evidence: TaskRuntimeRunResultReadEvidence,
  source: NativeProtectedTaskRunResultMessageSourceV1,
): boolean {
  const result = evidence.result;
  const sourceResult = source.result;
  const invocation = evidence.invocation;
  const sourceInvocation = source.invocation;
  const write = evidence.messageWrite;
  const sourceWrite = source.messageWrite;
  return write !== null
    && source.requesterHumanId === evidence.requesterHumanId
    && sourceResult.taskId === result.taskId
    && sourceResult.taskRunId === result.taskRunId
    && sourceResult.terminalStatus === result.terminalStatus
    && sourceResult.contentRevision === result.contentRevision
    && sourceResult.objectId === result.objectId
    && sourceResult.cryptoAccessRevision === result.cryptoAccessRevision
    && equal(sourceResult.genesisManifestHash, result.genesisManifestHash)
    && sourceResult.signerAgentId === result.signerAgentId
    && sourceResult.namespace.namespaceId === result.namespace.namespaceId
    && sourceResult.namespace.domainId === result.namespace.domainId
    && sourceResult.namespace.expectedAccessRevision
      === result.namespace.expectedAccessRevision
    && sourceResult.namespace.expectedPolicyRevision
      === result.namespace.expectedPolicyRevision
    && invocation.kind === "raw"
    && sourceInvocation.bindingId === invocation.bindingId
    && sourceInvocation.operationId === invocation.operationId
    && sourceInvocation.roomId === invocation.roomId
    && sourceInvocation.sessionId === invocation.sessionId
    && sourceWrite.taskId === write.taskId
    && sourceWrite.taskRunId === write.taskRunId
    && sourceWrite.bindingId === write.bindingId
    && sourceWrite.messageOperationId === write.messageOperationId
    && sourceWrite.roomId === write.roomId
    && sourceWrite.sessionId === write.sessionId
    && sourceWrite.signerAgentId === write.signerAgentId
    && sourceWrite.namespace.namespaceId === write.namespace.namespaceId
    && sourceWrite.namespace.domainId === write.namespace.domainId
    && sourceWrite.namespace.expectedAccessRevision
      === write.namespace.expectedAccessRevision
    && sourceWrite.namespace.expectedPolicyRevision
      === write.namespace.expectedPolicyRevision
    && sourceWrite.domain.domainId === write.domain.domainId
    && sourceWrite.domain.sourceNamespaceId === write.domain.sourceNamespaceId
    && sourceWrite.domain.domainKeyGeneration === write.domain.domainKeyGeneration
    && sourceWrite.domain.authorizationRevision === write.domain.authorizationRevision
    && sourceWrite.domain.participantCount === write.domain.participantCount
    && sourceWrite.domain.activeNamespaceBindingCount
      === write.domain.activeNamespaceBindingCount
    && equal(sourceWrite.domain.participantDigest, write.domain.participantDigest)
    && equal(sourceWrite.domain.headDigest, write.domain.headDigest)
    && equal(sourceWrite.domain.activeNamespaceBindingSetDigest,
      write.domain.activeNamespaceBindingSetDigest);
}

/** Prepare one normal raw Task result as a durable assistant Message. */
export async function prepareNativeTaskRunResultMessage(
  input: PrepareNativeTaskRunResultMessageInput,
): Promise<PreparedNativeTaskRunResultMessage> {
  const { evidence, source, allocation, signal } = input;
  const assertActive = (): void => {
    signal.throwIfAborted();
    assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
    assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
  };
  assertActive();
  const result = evidence.result;
  const invocation = evidence.invocation;
  const write = evidence.messageWrite;
  if (evidence.workKind !== "task.deliver_result"
    || result.contentRevision !== 1
    || (result.terminalStatus !== "completed"
      && result.terminalStatus !== "errored")
    || invocation.kind !== "raw"
    || write === null
    || !sameReadSource(evidence, source)) {
    throw new TypeError("Native Task result Message source disagrees");
  }
  for (const [label, value] of [
    ["Task", result.taskId], ["Task Run", result.taskRunId],
    ["binding", invocation.bindingId], ["operation", invocation.operationId],
    ["Room", invocation.roomId], ["Session", allocation.sessionId],
    ["Namespace", write.namespace.namespaceId],
    ["Domain", write.namespace.domainId], ["Agent", write.signerAgentId],
  ] as const) assertConversationDurableKey(`Task result Message ${label}`, value);
  const namespace = input.namespace;
  const current = namespace.current;
  const domain = write.domain;
  const temporary = input.temporarySigner;
  if ((input.signerPublication === null) === (temporary === undefined)) {
    throw new TypeError("Native Task result Message requires one signer authority");
  }
  const certified = temporary === undefined ? null
    : assertTaskRuntimeTemporarySignerForPreparation(
      input.crypto, evidence, input.runtime, temporary,
    );
  assertU64Counter("Task result Message accepted policy revision",
    allocation.acceptedPolicyRevision);
  assertU64Counter("Task result Message publication policy revision",
    allocation.publicationPolicyRevision);
  if (allocation.revision !== 0
    || (allocation.mode !== "shadow_encryption"
      && allocation.mode !== "encrypted_only")
    || allocation.sessionId !== invocation.sessionId
    || allocation.sessionId !== write.sessionId
    || allocation.objectId !== deriveMessageCryptoObjectIdV2(allocation)
    || allocation.acceptedPolicyRevision > allocation.publicationPolicyRevision
    || allocation.publicationPolicyRevision !== evidence.policyRevision
    || write.taskId !== result.taskId
    || write.taskRunId !== result.taskRunId
    || write.bindingId !== invocation.bindingId
    || write.messageOperationId !== invocation.operationId
    || write.roomId !== invocation.roomId
    || write.signerAgentId !== result.signerAgentId
    || write.namespace.operations.length !== 1
    || write.namespace.operations[0] !== "encrypt"
    || write.namespace.expectedPolicyRevision !== evidence.policyRevision
    || current.namespaceId !== write.namespace.namespaceId
    || current.cryptoDomainId !== write.namespace.domainId
    || current.namespaceAccessRevision !== write.namespace.expectedAccessRevision
    || current.keyClass !== "ai"
    || current.domainKeyGeneration !== domain.domainKeyGeneration
    || current.domainAuthorizationRevision !== domain.authorizationRevision
    || current.participantCount !== domain.participantCount
    || !equal(current.participantDigest, domain.participantDigest)
    || !equal(current.domainHeadDigest, domain.headDigest)) {
    throw new TypeError("Native Task result Message authority disagrees");
  }
  const authority: NativeTaskRunResultMessageAuthority = Object.freeze({
    taskId: result.taskId,
    taskRunId: result.taskRunId,
    bindingId: invocation.bindingId,
    messageOperationId: invocation.operationId,
    sessionId: allocation.sessionId,
    messageId: allocation.messageId,
    revision: 0,
    objectId: allocation.objectId,
    roomId: invocation.roomId,
    namespaceId: write.namespace.namespaceId,
    domainId: write.namespace.domainId,
    mode: allocation.mode,
    acceptedPolicyRevision: allocation.acceptedPolicyRevision,
    publicationPolicyRevision: allocation.publicationPolicyRevision,
    signerAgentId: write.signerAgentId,
    payloadDigest: bytesToHex(source.payloadDigest),
    role: "assistant",
    createdAt: unixTimestamp(allocation.createdAt),
    serverId: current.serverId,
    requesterHumanId: evidence.requesterHumanId,
    requestId: evidence.requestId,
    workId: evidence.workId,
    claimId: evidence.claimId,
    recipientGeneration: evidence.recipientGeneration,
    recipientKeyId: evidence.recipientKeyId,
    authorizationDigest: bytesToHex(evidence.authorizationDigest),
    claimExpiresAt: evidence.claimExpiresAt,
    recipientExpiresAt: evidence.recipientExpiresAt,
    authorizationExpiresAt: evidence.authorizationExpiresAt,
    expiresAt: evidence.expiresAt,
    sourceRoomId: evidence.sourceRoomId,
    episodeId: evidence.episodeId,
    hostAuthorizationRevision: evidence.hostAuthorizationRevision,
    recipientAuthorizationRevision: evidence.recipientAuthorizationRevision,
    resultTerminalStatus: result.terminalStatus,
    resultContentRevision: 1,
    resultObjectId: result.objectId,
    resultGenesisManifestHash: bytesToHex(result.genesisManifestHash),
    resultCryptoAccessRevision: result.cryptoAccessRevision,
    resultNamespaceId: result.namespace.namespaceId,
    resultDomainId: result.namespace.domainId,
    resultNamespaceAccessRevision: result.namespace.expectedAccessRevision,
    namespaceAccessRevision: current.namespaceAccessRevision,
    namespaceKeyGeneration: current.namespaceCurrentGeneration,
    namespaceBindingDigest: bytesToHex(namespace.expectedBindingDigest),
    bundleRevision: current.bundleRevision,
    retainedAuthoritySetDigest: bytesToHex(current.retainedAuthoritySetDigest),
    domainKeyGeneration: domain.domainKeyGeneration,
    domainAuthorizationRevision: domain.authorizationRevision,
    domainHeadDigest: bytesToHex(domain.headDigest),
    participantDigest: bytesToHex(domain.participantDigest),
    participantCount: domain.participantCount,
    activeNamespaceBindingSetDigest:
      bytesToHex(domain.activeNamespaceBindingSetDigest),
    activeNamespaceBindingCount: domain.activeNamespaceBindingCount,
    runtimeGeneration: input.runtime.generation,
    agentAuthorizationRevision: input.agentAuthorizationRevision,
    signerKeyId: certified?.signerKeyId
      ?? input.signerPublication!.signerKeyId,
    ...(certified === null ? {} : {
      signerAuthorizationHash: bytesToHex(certified.certificateHash),
      signerHostAuthorizationRevision:
        certified.hostAuthorizationRevision,
    }),
  });
  certified?.certificateHash.fill(0);
  const check = async (): Promise<void> => {
    assertActive();
    const resolved = await input.resolveCurrentAuthority(authority);
    assertActive();
    if (resolved === null || !sameAuthority(authority, resolved)) {
      throw new TypeError("Native Task result Message authority changed");
    }
  };
  await check();
  const encrypted = await encryptNativeTaskAssistantMessage({
    crypto: input.crypto,
    payload: source.payload,
    expectedPayloadDigest: source.payloadDigest,
    objectId: authority.objectId,
    createdAt: authority.createdAt,
    namespaceId: authority.namespaceId,
    namespaceAccessRevision: authority.namespaceAccessRevision,
    namespaceKeyGeneration: authority.namespaceKeyGeneration,
    namespace,
    signerAgentId: authority.signerAgentId,
    runtime: input.runtime,
    signerPublication: input.signerPublication,
    ...(temporary === undefined ? {} : { temporarySigner: temporary }),
    agentAuthorizationRevision: input.agentAuthorizationRevision,
    resolveHistoricalSignerPublicationManager:
      input.resolveHistoricalSignerPublicationManager,
    assertActive,
  });
  await check();
  const prepared = Object.freeze({
    purpose: "native-task-run-result-message-preparation",
    authority,
  }) as PreparedNativeTaskRunResultMessage;
  snapshots.set(prepared, Object.freeze({ authority, ...encrypted }));
  return prepared;
}

/** Detached opaque bytes; spreading the token loses the private brand. */
export function readPreparedNativeTaskRunResultMessage(
  prepared: PreparedNativeTaskRunResultMessage,
): NativeTaskRunResultMessageSnapshot {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) {
    throw new TypeError(
      "Native Task result Message was not prepared by the bridge",
    );
  }
  return Object.freeze({
    authority: snapshot.authority,
    object: encryptedObjectWriteRecord(
      snapshot.object.payloadBytes.ciphertext.slice()),
    manifestBytes: snapshot.manifestBytes.slice(),
    manifestHash: snapshot.manifestHash.slice(),
    envelopeBytes: Object.freeze([snapshot.envelopeBytes[0].slice()] as const),
    ...(snapshot.signerEvidenceBytes === undefined ? {} : {
      signerEvidenceBytes: snapshot.signerEvidenceBytes.slice(),
    }),
  });
}
