import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import { createPreparedConversationCryptoRevision } from
  "./conversation-prepared-revision.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "./message-payload-v2.ts";

export interface PrepareHumanExistingMessageRepresentationCryptoRevisionInput {
  readonly crypto: LatticeCrypto;
  readonly objectId: string;
  readonly payload: MessagePayloadV2;
  readonly createdAt: number;
  /**
   * Conversation ciphertext uses the Room AI keyring so the active Agent and
   * every authorized Human can consume one canonical revision.
   */
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly keyGeneration: number;
    readonly aiKey: Uint8Array;
  }>;
  readonly device: Readonly<{
    readonly deviceId: string;
    readonly hostAuthorizationRevision: number;
    readonly signingPrivateKey: Uint8Array;
  }>;
  readonly resolveCurrentAuthorization: Parameters<
    typeof createPreparedConversationCryptoRevision
  >[0]["resolveCurrentAuthorization"];
}
/**
 * Prepare one existing Message revision with the existing v2
 * payload/envelope/manifest lifecycle. Plaintext, copied Namespace key, copied
 * signing key, and object DEK are wiped before returning.
 */
export function prepareHumanExistingMessageRepresentationCryptoRevision(
  input: PrepareHumanExistingMessageRepresentationCryptoRevisionInput,
): PreparedConversationCryptoRevision {
  const plaintext = encodeMessagePayloadV2(input.payload);
  const namespaceKey = input.namespace.aiKey.slice();
  const signingPrivateKey = input.device.signingPrivateKey.slice();
  let dek: Uint8Array | null = null;
  try {
    const encrypted = encryptObjectPayload(
      input.crypto,
      {
        objectId: objectId(input.objectId),
        keyClass: "ai",
        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
        createdAt: unixTimestamp(input.createdAt),
      },
      plaintext,
    );
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        input.crypto,
        namespaceKey,
        {
          objectId: objectId(input.objectId),
          namespaceId: namespaceId(input.namespace.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(input.namespace.keyGeneration),
          bindingRevisionAtWrap: accessRevision(
            input.namespace.accessRevision,
          ),
        },
        dek,
      ),
    );
    const access = prepareObjectAccessManifestGenesis(input.crypto, {
      objectId: objectId(input.objectId),
      payloadHash: input.crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId(input.device.deviceId),
      hostAuthorizationRevision: authorizationRevision(
        input.device.hostAuthorizationRevision,
      ),
      signingPrivateKey,
    });
    return createPreparedConversationCryptoRevision({
      objectId: input.objectId,
      namespaceId: input.namespace.namespaceId,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: input.resolveCurrentAuthorization,
    });
  } finally {
    plaintext.fill(0);
    namespaceKey.fill(0);
    signingPrivateKey.fill(0);
    dek?.fill(0);
  }
}

export interface PrepareHumanPeerLiveShadowCryptoRevisionInput {
  readonly crypto: LatticeCrypto;
  readonly objectId: string;
  readonly payload: MessagePayloadV2;
  readonly createdAt: number;
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly keyGeneration: number;
    readonly humanKey: Uint8Array;
  }>;
  readonly device: Readonly<{
    readonly deviceId: string;
    readonly hostAuthorizationRevision: number;
    readonly signingPrivateKey: Uint8Array;
  }>;
  readonly resolveCurrentAuthorization: Parameters<
    typeof createPreparedConversationCryptoRevision
  >[0]["resolveCurrentAuthorization"];
}

/** M295 Human-only sibling: the same object lifecycle under key_class=human. */
export function prepareHumanPeerLiveShadowCryptoRevision(
  input: PrepareHumanPeerLiveShadowCryptoRevisionInput,
): PreparedConversationCryptoRevision {
  const plaintext = encodeMessagePayloadV2(input.payload);
  const namespaceKey = input.namespace.humanKey.slice();
  const signingPrivateKey = input.device.signingPrivateKey.slice();
  let dek: Uint8Array | null = null;
  try {
    const encrypted = encryptObjectPayload(
      input.crypto,
      {
        objectId: objectId(input.objectId),
        keyClass: "human",
        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
        createdAt: unixTimestamp(input.createdAt),
      },
      plaintext,
    );
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        input.crypto,
        namespaceKey,
        {
          objectId: objectId(input.objectId),
          namespaceId: namespaceId(input.namespace.namespaceId),
          keyClass: "human",
          keyGeneration: namespaceGeneration(input.namespace.keyGeneration),
          bindingRevisionAtWrap: accessRevision(
            input.namespace.accessRevision,
          ),
        },
        dek,
      ),
    );
    const access = prepareObjectAccessManifestGenesis(input.crypto, {
      objectId: objectId(input.objectId),
      payloadHash: input.crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId(input.device.deviceId),
      hostAuthorizationRevision: authorizationRevision(
        input.device.hostAuthorizationRevision,
      ),
      signingPrivateKey,
    });
    return createPreparedConversationCryptoRevision({
      objectId: input.objectId,
      namespaceId: input.namespace.namespaceId,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: input.resolveCurrentAuthorization,
    });
  } finally {
    plaintext.fill(0);
    namespaceKey.fill(0);
    signingPrivateKey.fill(0);
    dek?.fill(0);
  }
}
