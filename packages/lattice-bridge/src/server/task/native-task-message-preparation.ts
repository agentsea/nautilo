import { bytesToHex } from "@noble/hashes/utils.js";
import {
  accessRevision, agentRuntimeSignerPublicationMatchesRuntime,
  assertAuthenticTaskRuntimeExecutionEvidence, authorizationRevision,
  createCommonAgentObjectAccessManifest, encryptedObjectWriteRecord,
  encryptObjectPayload, namespaceGeneration, namespaceId, objectId, unixTimestamp,
  verifyHistoricalAgentRuntimeSignerPublication, withOpenedDomainNamespaceBundle,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration, type AgentRuntimeSignerPublication,
  type LatticeCrypto, type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import { encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";
import {
  assertConversationDurableKey, CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveMessageCryptoObjectIdV2, type ConversationRevisionCoordinates,
} from "../../message/conversation-repository.ts";
import { encodeMessagePayloadV2, type MessagePayloadV2 } from "../../message/message-payload-v2.ts";

export type NativeTaskMessageCoordinates = ConversationRevisionCoordinates & Readonly<{
  taskId: string;
  taskRunId: string;
  roomId: string;
  graphThreadId: string;
  humanTurnId: string;
  agentId: string;
  objectId: string;
  role: Exclude<MessagePayloadV2["role"], "user">;
}>;

type NativeNamespaceSource = Omit<Parameters<typeof withOpenedDomainNamespaceBundle>[1], "operation" | "expectedBindingDigest"> & Readonly<{
  expectedBindingDigest: Uint8Array;
}>;

/** Exact current product/crypto projection; all fields are immutable scalars. */
export type NativeTaskMessageAuthority = NativeTaskMessageCoordinates & Readonly<{
  mode: "shadow_encryption" | "encrypted_only";
  serverId: string;
  requestId: string;
  sourceRoomId: string;
  episodeId: string;
  hostAuthorizationRevision: number;
  recipientAuthorizationRevision: number;
  claimId: string;
  authorizationDigest: string;
  policyRevision: number;
  createdAt: number;
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
  participantDigest: string;
  participantCount: number;
  activeNamespaceBindingSetDigest: string;
  activeNamespaceBindingCount: number;
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
}>;

export type PrepareNativeTaskMessageInput = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  coordinates: NativeTaskMessageCoordinates;
  mode: NativeTaskMessageAuthority["mode"];
  payload: MessagePayloadV2;
  createdAt: number;
  namespace: NativeNamespaceSource;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication;
  agentAuthorizationRevision: number;
  resolveHistoricalSignerPublicationManager: ResolveHistoricalAgentRuntimeSignerPublicationManager;
  signal: AbortSignal;
  /**
   * Re-read the exact running Task/TaskRun, allocated Message row, actual
   * Session/Room audience, grant, policy, Domain, Namespace and Runtime signer.
   * Return null on missing authority. Called before and after preparation;
   * publication must independently fence the same projection transactionally.
   */
  resolveCurrentAuthority(expected: NativeTaskMessageAuthority): Promise<NativeTaskMessageAuthority | null>;
}>;

declare const nativeTaskMessageBrand: unique symbol;
/** Deliberately not a PreparedConversationCryptoRevision: V5 completion is separate. */
export type PreparedNativeTaskMessage = Readonly<{
  purpose: "native-task-message-preparation";
  authority: NativeTaskMessageAuthority;
  readonly [nativeTaskMessageBrand]: true;
}>;

export type NativeTaskMessageSnapshot = Readonly<{
  authority: NativeTaskMessageAuthority;
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly [Uint8Array];
}>;
const snapshots = new WeakMap<PreparedNativeTaskMessage, NativeTaskMessageSnapshot>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameAuthority(left: NativeTaskMessageAuthority, right: NativeTaskMessageAuthority): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskMessageAuthority)[];
  return Object.keys(right).length === fields.length && fields.every((field) => left[field] === right[field]);
}

/** Prepare a single Agent-authored Message under its explicitly granted audience. No persistence. */
export async function prepareNativeTaskMessage(input: PrepareNativeTaskMessageInput): Promise<PreparedNativeTaskMessage> {
  const { crypto, evidence, signal, resolveCurrentAuthority } = input;
  const assertActive = (): void => { signal.throwIfAborted(); assertAuthenticTaskRuntimeExecutionEvidence(evidence); };
  assertActive();
  const coordinates: NativeTaskMessageCoordinates = Object.freeze({
    sessionId: input.coordinates.sessionId, messageId: input.coordinates.messageId,
    revision: input.coordinates.revision, taskId: input.coordinates.taskId,
    taskRunId: input.coordinates.taskRunId, roomId: input.coordinates.roomId,
    graphThreadId: input.coordinates.graphThreadId, humanTurnId: input.coordinates.humanTurnId,
    agentId: input.coordinates.agentId, objectId: input.coordinates.objectId, role: input.coordinates.role,
  });
  for (const field of ["taskId", "taskRunId", "roomId", "graphThreadId", "humanTurnId", "agentId"] as const) {
    assertConversationDurableKey(`Task Message ${field}`, coordinates[field]);
  }
  const source = input.namespace;
  const current = source.current;
  const requirements = evidence.namespaceRequirements.filter((entry) => entry.namespaceId === current.namespaceId);
  const requirement = requirements[0];
  const domains = evidence.domainRequirements.filter((entry) => entry.domainId === current.cryptoDomainId);
  const domain = domains[0];
  if ((input.mode !== "shadow_encryption" && input.mode !== "encrypted_only")
    || coordinates.taskId !== evidence.result.taskId || coordinates.taskRunId !== evidence.workId
    || coordinates.taskRunId !== evidence.result.taskRunId || coordinates.agentId !== evidence.result.signerAgentId
    || coordinates.objectId !== deriveMessageCryptoObjectIdV2(coordinates)
    || !["assistant", "tool", "system"].includes(coordinates.role) || coordinates.role !== input.payload.role
    || requirements.length !== 1 || requirement === undefined || !requirement.operations.includes("encrypt")
    || requirement.domainId !== current.cryptoDomainId || requirement.expectedAccessRevision !== current.namespaceAccessRevision
    || requirement.expectedPolicyRevision !== evidence.policyRevision
    || domains.length !== 1 || domain === undefined || current.keyClass !== "ai"
    || current.domainKeyGeneration !== domain.domainKeyGeneration || current.domainAuthorizationRevision !== domain.authorizationRevision
    || current.participantCount !== domain.participantCount || !equalBytes(current.participantDigest, domain.participantDigest)
    || !equalBytes(current.domainHeadDigest, domain.headDigest)
    || input.runtime.agentId !== coordinates.agentId || input.signerPublication.agentId !== coordinates.agentId
    || input.signerPublication.authorizationRevision !== authorizationRevision(input.agentAuthorizationRevision)
    || !agentRuntimeSignerPublicationMatchesRuntime(crypto, input.runtime, input.signerPublication)
    || !verifyHistoricalAgentRuntimeSignerPublication({ crypto, publication: input.signerPublication,
      resolveHistoricalManagerAuthority: input.resolveHistoricalSignerPublicationManager })) {
    throw new TypeError("Native Task Message coordinate or authority disagrees");
  }
  const authority: NativeTaskMessageAuthority = Object.freeze({ ...coordinates,
    mode: input.mode, serverId: current.serverId, requestId: evidence.requestId, claimId: evidence.claimId,
    sourceRoomId: evidence.sourceRoomId, episodeId: evidence.episodeId,
    hostAuthorizationRevision: evidence.hostAuthorizationRevision,
    recipientAuthorizationRevision: evidence.recipientAuthorizationRevision,
    authorizationDigest: bytesToHex(evidence.authorizationDigest), policyRevision: evidence.policyRevision,
    createdAt: unixTimestamp(input.createdAt), namespaceId: current.namespaceId,
    namespaceAccessRevision: current.namespaceAccessRevision, namespaceKeyGeneration: current.namespaceCurrentGeneration,
    namespaceBindingDigest: bytesToHex(source.expectedBindingDigest), bundleRevision: current.bundleRevision,
    retainedAuthoritySetDigest: bytesToHex(current.retainedAuthoritySetDigest), domainId: domain.domainId,
    domainKeyGeneration: domain.domainKeyGeneration, domainAuthorizationRevision: domain.authorizationRevision,
    domainHeadDigest: bytesToHex(domain.headDigest), participantDigest: bytesToHex(domain.participantDigest),
    participantCount: domain.participantCount, activeNamespaceBindingSetDigest: bytesToHex(domain.activeNamespaceBindingSetDigest),
    activeNamespaceBindingCount: domain.activeNamespaceBindingCount, runtimeGeneration: input.runtime.generation,
    agentAuthorizationRevision: input.agentAuthorizationRevision, signerKeyId: input.signerPublication.signerKeyId,
  });
  // Snapshot borrowed inputs before the first asynchronous product check. Only
  // owned copies are wiped here; the grant coordinator owns caller buffers.
  const owned: Uint8Array[] = [];
  const copy = (bytes: Uint8Array): Uint8Array => { const result = bytes.slice(); owned.push(result); return result; };
  try {
    const plaintext = encodeMessagePayloadV2(input.payload);
    owned.push(plaintext);
    const runtime = Object.freeze({ ...input.runtime, key: copy(input.runtime.key) });
    const namespace: NativeNamespaceSource = { bindingBytes: copy(source.bindingBytes), expectedBindingDigest: copy(source.expectedBindingDigest),
      issuerSigningPublicKey: copy(source.issuerSigningPublicKey), domainKey: copy(source.domainKey),
      current: { ...current, participantDigest: copy(current.participantDigest), domainHeadDigest: copy(current.domainHeadDigest),
        retainedAuthoritySetDigest: copy(current.retainedAuthoritySetDigest) } };
    const check = async (): Promise<void> => {
      assertActive();
      const live = await resolveCurrentAuthority(authority);
      assertActive();
      if (live === null || !sameAuthority(authority, live)) throw new TypeError("Native Task Message authority changed");
    };
    await check();
    const opened = await withOpenedDomainNamespaceBundle(crypto, { ...namespace, operation: (retained) => {
      assertActive();
      const keys = retained.filter((entry) => entry.generation === authority.namespaceKeyGeneration
        && entry.accessRevision === authority.namespaceAccessRevision);
      if (keys.length !== 1) throw new TypeError("Native Task Message Namespace generation is unavailable");
      const encrypted = encryptObjectPayload(crypto, { objectId: objectId(coordinates.objectId), keyClass: "ai",
        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE, createdAt: unixTimestamp(authority.createdAt) }, plaintext);
      try {
        const envelope = wrapObjectDekForNamespace(crypto, keys[0]!.generationKey, {
          objectId: objectId(coordinates.objectId), namespaceId: namespaceId(authority.namespaceId), keyClass: "ai",
          keyGeneration: namespaceGeneration(authority.namespaceKeyGeneration), bindingRevisionAtWrap: accessRevision(authority.namespaceAccessRevision),
        }, encrypted.dek);
        try {
          const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
          const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
          const genesis = createCommonAgentObjectAccessManifest(crypto, { objectId: objectId(coordinates.objectId),
            payloadHash: crypto.hash(payloadBytes), accessRevision: accessRevision(0), previousManifestHash: null,
            envelopeHashes: [crypto.hash(envelopeBytes)], signer: { kind: "agent_runtime", agentId: runtime.agentId,
              runtimeGeneration: runtime.generation, signerKeyId: authority.signerKeyId }, signerAuthorizationHash: null,
            hostAuthorizationRevision: authorizationRevision(authority.agentAuthorizationRevision) }, runtime);
          return Object.freeze({ authority, object: encryptedObjectWriteRecord(payloadBytes),
            manifestBytes: genesis.bytes, manifestHash: genesis.hash, envelopeBytes: Object.freeze([envelopeBytes] as const) });
        } finally { envelope.wrappedDek.fill(0); }
      } finally { encrypted.dek.fill(0); encrypted.payload.ciphertext.fill(0); }
    } });
    if (opened.status !== "opened") throw new TypeError("Native Task Message Namespace bundle is unavailable");
    await check();
    const prepared = Object.freeze({ purpose: "native-task-message-preparation", authority }) as PreparedNativeTaskMessage;
    snapshots.set(prepared, opened.value);
    return prepared;
  } finally { owned.forEach((bytes) => bytes.fill(0)); }
}

/** Read detached ciphertext bytes. A forged/spread token never acquires the private preparation brand. */
export function readPreparedNativeTaskMessage(prepared: PreparedNativeTaskMessage): NativeTaskMessageSnapshot {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) throw new TypeError("Native Task Message was not prepared by the bridge");
  return Object.freeze({ authority: snapshot.authority,
    object: encryptedObjectWriteRecord(snapshot.object.payloadBytes.ciphertext.slice()),
    manifestBytes: snapshot.manifestBytes.slice(), manifestHash: snapshot.manifestHash.slice(),
    envelopeBytes: Object.freeze([snapshot.envelopeBytes[0].slice()] as const) });
}
