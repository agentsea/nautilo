import { bytesToHex } from "@noble/hashes/utils.js";
import {
  assertAuthenticTaskRuntimeTerminalMessageEvidence,
  assertTaskRuntimeTemporarySignerForPreparation,
  encryptedObjectWriteRecord,
  unixTimestamp,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeTerminalMessageEvidence,
  type TaskRuntimeTemporarySigner,
} from "@nautilo/lattice-crypto";
import {
  assertConversationDurableKey,
  deriveMessageCryptoObjectIdV2,
} from "../../message/conversation-repository.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type { NativeTaskNamespaceSource } from
  "./native-task-message-preparation.ts";
import { encryptNativeTaskAssistantMessage } from
  "./native-task-assistant-message-encryption.ts";

export type NativeTaskTerminalMessageAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: number;
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
  requestId: string;
  claimId: string;
  recipientGeneration: number;
  authorizationDigest: string;
  claimExpiresAt: number;
  recipientExpiresAt: number;
  expiresAt: number;
  sourceRoomId: string;
  episodeId: string;
  hostAuthorizationRevision: number;
  recipientAuthorizationRevision: number;
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

export type PrepareNativeTaskTerminalMessageInput = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeTerminalMessageEvidence;
  payload: MessagePayloadV2;
  createdAt: number;
  namespace: NativeTaskNamespaceSource;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication | null;
  temporarySigner?: TaskRuntimeTemporarySigner;
  agentAuthorizationRevision: number;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  signal: AbortSignal;
  /** Reprove the exact terminal delivery, allocation and destination authority. */
  resolveCurrentAuthority(expected: NativeTaskTerminalMessageAuthority):
    Promise<NativeTaskTerminalMessageAuthority | null>;
}>;

declare const preparedTerminalMessageBrand: unique symbol;
export type PreparedNativeTaskTerminalMessage = Readonly<{
  purpose: "native-task-terminal-message-preparation";
  authority: NativeTaskTerminalMessageAuthority;
  readonly [preparedTerminalMessageBrand]: true;
}>;

export type NativeTaskTerminalMessageSnapshot = Readonly<{
  authority: NativeTaskTerminalMessageAuthority;
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly [Uint8Array];
  signerEvidenceBytes?: Uint8Array;
}>;

const snapshots = new WeakMap<PreparedNativeTaskTerminalMessage,
  NativeTaskTerminalMessageSnapshot>();

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: NativeTaskTerminalMessageAuthority,
  right: NativeTaskTerminalMessageAuthority,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskTerminalMessageAuthority)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

/** Prepare the one fixed terminal assistant Message without granting a read. */
export async function prepareNativeTaskTerminalMessage(
  input: PrepareNativeTaskTerminalMessageInput,
): Promise<PreparedNativeTaskTerminalMessage> {
  const { crypto, evidence, signal } = input;
  const assertActive = (): void => {
    signal.throwIfAborted();
    assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
  };
  assertActive();
  const message = evidence.message;
  for (const [label, value] of [
    ["Task", message.taskId], ["Task Run", message.taskRunId],
    ["binding", message.bindingId], ["operation", message.messageOperationId],
    ["Room", message.roomId], ["Namespace", message.namespaceId],
    ["Domain", message.domainId], ["Agent", message.signerAgentId],
  ] as const) assertConversationDurableKey(`Terminal Message ${label}`, value);
  const source = input.namespace;
  const current = source.current;
  const requirements = evidence.namespaceRequirements.filter(entry =>
    entry.namespaceId === current.namespaceId);
  const requirement = requirements[0];
  const domains = evidence.domainRequirements.filter(entry =>
    entry.domainId === current.cryptoDomainId);
  const domain = domains[0];
  const temporary = input.temporarySigner;
  if ((input.signerPublication === null) === (temporary === undefined)) {
    throw new TypeError("Native terminal Task Message requires one signer authority");
  }
  const certified = temporary === undefined ? null
    : assertTaskRuntimeTemporarySignerForPreparation(
      crypto, evidence, input.runtime, temporary,
    );
  const plaintext = encodeMessagePayloadV2(input.payload);
  const payloadDigest = crypto.hash(plaintext);
  try {
    if (input.payload.role !== "assistant"
      || !equal(payloadDigest, message.payloadDigest)
      || message.objectId !== deriveMessageCryptoObjectIdV2(message)
      || message.publicationPolicyRevision !== evidence.policyRevision
      || message.roomId !== evidence.sourceRoomId
      || message.namespaceId !== current.namespaceId
      || message.domainId !== current.cryptoDomainId
      || requirements.length !== 1 || requirement === undefined
      || requirement.operations.length !== 1
      || requirement.operations[0] !== "encrypt"
      || requirement.expectedAccessRevision !== current.namespaceAccessRevision
      || requirement.expectedPolicyRevision !== message.publicationPolicyRevision
      || domains.length !== 1 || domain === undefined
      || current.keyClass !== "ai"
      || current.domainKeyGeneration !== domain.domainKeyGeneration
      || current.domainAuthorizationRevision !== domain.authorizationRevision
      || current.participantCount !== domain.participantCount
      || !equal(current.participantDigest, domain.participantDigest)
      || !equal(current.domainHeadDigest, domain.headDigest)) {
      throw new TypeError("Native terminal Task Message authority disagrees");
    }
    const authority: NativeTaskTerminalMessageAuthority = Object.freeze({
      taskId: message.taskId,
      taskRunId: message.taskRunId,
      bindingId: message.bindingId,
      messageOperationId: message.messageOperationId,
      sessionId: message.sessionId,
      messageId: message.messageId,
      revision: message.revision,
      objectId: message.objectId,
      roomId: message.roomId,
      namespaceId: message.namespaceId,
      domainId: message.domainId,
      mode: message.mode,
      acceptedPolicyRevision: message.acceptedPolicyRevision,
      publicationPolicyRevision: message.publicationPolicyRevision,
      signerAgentId: message.signerAgentId,
      payloadDigest: bytesToHex(message.payloadDigest),
      role: "assistant",
      createdAt: unixTimestamp(input.createdAt),
      serverId: current.serverId,
      requestId: evidence.requestId,
      claimId: evidence.claimId,
      recipientGeneration: evidence.recipientGeneration,
      authorizationDigest: bytesToHex(evidence.authorizationDigest),
      claimExpiresAt: evidence.claimExpiresAt,
      recipientExpiresAt: evidence.recipientExpiresAt,
      expiresAt: evidence.expiresAt,
      sourceRoomId: evidence.sourceRoomId,
      episodeId: evidence.episodeId,
      hostAuthorizationRevision: evidence.hostAuthorizationRevision,
      recipientAuthorizationRevision: evidence.recipientAuthorizationRevision,
      namespaceAccessRevision: current.namespaceAccessRevision,
      namespaceKeyGeneration: current.namespaceCurrentGeneration,
      namespaceBindingDigest: bytesToHex(source.expectedBindingDigest),
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
        throw new TypeError("Native terminal Task Message authority changed");
      }
    };
    await check();
    const encrypted = await encryptNativeTaskAssistantMessage({
      crypto,
      payload: input.payload,
      expectedPayloadDigest: message.payloadDigest,
      objectId: authority.objectId,
      createdAt: authority.createdAt,
      namespaceId: authority.namespaceId,
      namespaceAccessRevision: authority.namespaceAccessRevision,
      namespaceKeyGeneration: authority.namespaceKeyGeneration,
      namespace: source,
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
      purpose: "native-task-terminal-message-preparation",
      authority,
    }) as PreparedNativeTaskTerminalMessage;
    snapshots.set(prepared, Object.freeze({ authority, ...encrypted }));
    return prepared;
  } finally {
    plaintext.fill(0);
    payloadDigest.fill(0);
  }
}

/** Detached opaque bytes; spreading the token loses the private brand. */
export function readPreparedNativeTaskTerminalMessage(
  prepared: PreparedNativeTaskTerminalMessage,
): NativeTaskTerminalMessageSnapshot {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) {
    throw new TypeError("Native terminal Task Message was not prepared by the bridge");
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
