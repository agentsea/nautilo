import type {
  LatticeStorage,
  PreparedAgentObjectAccessManifestGenesis,
  PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  PreparedObjectAccessManifestGenesis,
  ResolveCurrentAgentObjectAccessGenesisAuthorization,
  ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
  ResolveCurrentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2,
  decodeObjectAccessManifestV3,
} from "@nautilo/lattice-crypto/wire";
import type {
  PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
} from "./conversation-repository.ts";

export interface ConversationCryptoRevisionSnapshot {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly object: Parameters<LatticeStorage["putObject"]>[0];
  readonly access: PreparedObjectAccessManifestGenesis;
  readonly resolveCurrentAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorization;
}

export interface AgentConversationCryptoRevisionSnapshot {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly object: Parameters<LatticeStorage["putObject"]>[0];
  readonly access: PreparedAgentObjectAccessManifestGenesis;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentObjectAccessGenesisAuthorization;
}

export interface DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot
  extends Omit<
    AgentConversationCryptoRevisionSnapshot,
    "access" | "resolveCurrentAuthorization"
  > {
  readonly access:
    PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis;
  readonly resolveCurrentAuthorization:
    ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization;
  readonly signerPublicKey: Uint8Array;
}

export type PreparedConversationCryptoRevisionSnapshot =
  | Readonly<{
    readonly kind: "human-v2";
    readonly value: ConversationCryptoRevisionSnapshot;
  }>
  | Readonly<{
    readonly kind: "agent-v3";
    readonly value: AgentConversationCryptoRevisionSnapshot;
  }>
  | Readonly<{
    readonly kind: "agent-v3-device-wrapped-live-shadow";
    readonly value: DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot;
  }>;

const snapshots = new WeakMap<
  PreparedConversationCryptoRevision,
  PreparedConversationCryptoRevisionSnapshot
>();

function copySnapshot(
  input: ConversationCryptoRevisionSnapshot,
): ConversationCryptoRevisionSnapshot {
  return Object.freeze({
    objectId: input.objectId,
    namespaceId: input.namespaceId,
    object: input.object,
    access: input.access,
    resolveCurrentAuthorization: input.resolveCurrentAuthorization,
  });
}

export function createPreparedConversationCryptoRevision(
  input: ConversationCryptoRevisionSnapshot,
): PreparedConversationCryptoRevision {
  const payload = decodeEncryptedPayloadV2(
    input.object.payloadBytes.ciphertext,
  );
  const manifest = decodeObjectAccessManifestV2(input.access.manifestBytes);
  if (
    input.objectId !== input.object.objectId
    || input.objectId !== payload.context.objectId
    || input.objectId !== manifest.objectId
  ) {
    throw new Error("Prepared conversation crypto coordinates disagree");
  }
  if (payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE) {
    throw new Error("Prepared conversation crypto object type is invalid");
  }
  if (input.access.envelopeBytes.length !== 1) {
    throw new Error(
      "Prepared conversation revision requires one Namespace envelope",
    );
  }
  const envelope = decodeNamespaceObjectEnvelopeV2(
    input.access.envelopeBytes[0]!,
  );
  if (
    envelope.context.objectId !== input.objectId
    || envelope.context.namespaceId !== input.namespaceId
  ) {
    throw new Error("Prepared conversation Namespace coordinates disagree");
  }
  if (envelope.context.keyClass !== payload.context.keyClass) {
    throw new Error(
      "Prepared conversation payload and envelope key class disagree",
    );
  }
  const revision = Object.freeze({
    objectId: input.objectId,
    namespaceId: input.namespaceId,
    objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
    payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
    keyClass: payload.context.keyClass,
  }) as PreparedConversationCryptoRevision;
  snapshots.set(revision, Object.freeze({
    kind: "human-v2",
    value: copySnapshot(input),
  }));
  return revision;
}

export function readPreparedConversationCryptoRevision(
  revision: PreparedConversationCryptoRevision,
): ConversationCryptoRevisionSnapshot {
  const snapshot = snapshots.get(revision);
  if (snapshot === undefined || snapshot.kind !== "human-v2") {
    throw new TypeError(
      "Conversation crypto revision is not a bridge-prepared Human revision",
    );
  }
  return snapshot.value;
}

function createPreparedAgentConversationCryptoRevisionWithKind(
  input:
    | AgentConversationCryptoRevisionSnapshot
    | DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot,
  kind:
    | "agent-v3"
    | "agent-v3-device-wrapped-live-shadow",
): PreparedConversationCryptoRevision {
  const payload = decodeEncryptedPayloadV2(
    input.object.payloadBytes.ciphertext,
  );
  const manifest = decodeObjectAccessManifestV3(
    input.access.manifestBytes,
  );
  if (
    input.objectId !== input.object.objectId
    || input.objectId !== payload.context.objectId
    || input.objectId !== manifest.objectId
  ) {
    throw new Error("Prepared Agent conversation crypto coordinates disagree");
  }
  if (
    payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
    || payload.context.keyClass !== "ai"
    || input.access.envelopeBytes.length !== 1
  ) {
    throw new Error("Prepared Agent conversation crypto shape is invalid");
  }
  const envelope = decodeNamespaceObjectEnvelopeV2(
    input.access.envelopeBytes[0],
  );
  if (
    envelope.context.objectId !== input.objectId
    || envelope.context.namespaceId !== input.namespaceId
    || envelope.context.keyClass !== "ai"
    || manifest.signer.agentId !== input.access.authority.agentId
    || manifest.signer.runtimeGeneration
      !== input.access.authority.runtimeGeneration
    || manifest.signer.signerKeyId
      !== input.access.authority.signerKeyId
  ) {
    throw new Error(
      "Prepared Agent conversation Namespace or signer coordinates disagree",
    );
  }
  const revision = Object.freeze({
    objectId: input.objectId,
    namespaceId: input.namespaceId,
    objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
    payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
    keyClass: "ai",
  }) as PreparedConversationCryptoRevision;
  snapshots.set(revision, Object.freeze({
    kind,
    value: Object.freeze({ ...input }),
  }) as PreparedConversationCryptoRevisionSnapshot);
  return revision;
}

export function createPreparedAgentConversationCryptoRevision(
  input: AgentConversationCryptoRevisionSnapshot,
): PreparedConversationCryptoRevision {
  return createPreparedAgentConversationCryptoRevisionWithKind(
    input,
    "agent-v3",
  );
}

export function createPreparedDeviceWrappedLiveShadowAgentConversationCryptoRevision(
  input: DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot,
): PreparedConversationCryptoRevision {
  return createPreparedAgentConversationCryptoRevisionWithKind(
    input,
    "agent-v3-device-wrapped-live-shadow",
  );
}

export function readPreparedConversationCryptoRevisionSnapshot(
  revision: PreparedConversationCryptoRevision,
): PreparedConversationCryptoRevisionSnapshot {
  const snapshot = snapshots.get(revision);
  if (snapshot === undefined) {
    throw new TypeError(
      "Conversation crypto revision was not prepared by the bridge crypto role",
    );
  }
  return snapshot;
}
