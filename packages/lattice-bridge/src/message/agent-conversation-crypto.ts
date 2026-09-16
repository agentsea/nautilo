import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentObjectAccessManifestGenesis,
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentObjectAccessGrantUseStatus,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type EncryptedPayload,
  type LatticeCrypto,
  type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  encryptedPayloadAadV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import {
  createPreparedAgentConversationCryptoRevision,
  createPreparedDeviceWrappedLiveShadowAgentConversationCryptoRevision,
} from "./conversation-prepared-revision.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "./message-payload-v2.ts";

export interface PrepareAgentConversationCryptoRevisionInput {
  readonly crypto: LatticeCrypto;
  readonly objectId: string;
  readonly payload: MessagePayloadV2;
  readonly createdAt: number;
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly bindingHash: Uint8Array;
    readonly domainId: string;
    readonly domainEpoch: number;
    readonly keyGeneration: number;
    readonly aiKey: Uint8Array;
  }>;
  readonly grant: Readonly<{
    readonly grantId: string;
    readonly grantHash: Uint8Array;
    readonly useStatus: AgentObjectAccessGrantUseStatus;
  }>;
  readonly runtime: AgentRuntimeKeyGeneration;
  readonly signerPublication: AgentRuntimeSignerPublication;
  readonly resolveCurrentAuthorization: Parameters<
    typeof createPreparedAgentConversationCryptoRevision
  >[0]["resolveCurrentAuthorization"];
}

export interface PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput {
  readonly crypto: LatticeCrypto;
  readonly objectId: string;
  readonly payload: MessagePayloadV2;
  readonly createdAt: number;
  readonly objectDek: Uint8Array;
  readonly namespaceEnvelopeBytes?: Uint8Array;
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly keyGeneration: number;
    readonly headDigest: Uint8Array;
    readonly publicationDigest: Uint8Array;
    readonly publicationSetDigest: Uint8Array;
    readonly audienceFingerprint: Uint8Array;
    readonly aiKey: Uint8Array;
  }>;
  readonly operationId: string;
  readonly grant: Readonly<{
    readonly grantId: string;
    readonly grantHash: Uint8Array;
    readonly recipientKeyId: string;
  }>;
  readonly runtime: AgentRuntimeKeyGeneration;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
  readonly agentAuthorizationRevision: number;
  readonly resolveCurrentAuthorization:
    ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization;
}

/**
 * A foreground Runtime may publish a protected representation of an existing
 * Message without becoming that Message's author. The payload role remains
 * immutable; the Runtime signer authenticates only this representation.
 */
export type PrepareForegroundRuntimeExistingMessageCryptoRevisionInput =
  | PrepareAgentConversationCryptoRevisionInput
  | PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput;

function isDeviceWrappedLiveInput(
  input:
    | PrepareAgentConversationCryptoRevisionInput
    | PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput,
): input is PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput {
  return "operationId" in input;
}

function prepareWithOwnedDek(
  input:
    | PrepareAgentConversationCryptoRevisionInput
    | PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput,
  ownedDek: Uint8Array,
  exactEnvelopeBytes?: Uint8Array,
  publicationKind: "agent_authored" | "existing_message_repair" =
    "agent_authored",
): PreparedConversationCryptoRevision {
  if (
    publicationKind === "agent_authored"
    && input.payload.role === "user"
  ) {
    throw new TypeError(
      "Agent conversation preparation cannot author a Human message",
    );
  }
  if (ownedDek.length !== 32) {
    throw new TypeError("Agent conversation object DEK must be 32 bytes");
  }
  const plaintext = encodeMessagePayloadV2(input.payload);
  const namespaceKey = input.namespace.aiKey.slice();
  try {
    const context = Object.freeze({
      objectId: objectId(input.objectId),
      keyClass: "ai" as const,
      objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
      createdAt: unixTimestamp(input.createdAt),
    });
    const encrypted: EncryptedPayload = Object.freeze({
      formatVersion: 2 as const,
      context,
      ciphertext: input.crypto.aeadSeal(
        ownedDek,
        plaintext,
        encryptedPayloadAadV2(context),
      ),
    });
    const payloadBytes = encodeEncryptedPayloadV2(encrypted);
    const envelopeBytes = exactEnvelopeBytes?.slice()
      ?? encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespace(
          input.crypto,
          namespaceKey,
          {
            objectId: objectId(input.objectId),
            namespaceId: namespaceId(input.namespace.namespaceId),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(
              input.namespace.keyGeneration,
            ),
            bindingRevisionAtWrap: accessRevision(
              input.namespace.accessRevision,
            ),
          },
          ownedDek,
        ),
      );
    const accessInput = {
        objectId: objectId(input.objectId),
        payloadHash: input.crypto.hash(payloadBytes),
        envelopeBytes: [envelopeBytes] as const,
        agentAuthorizationRevision: authorizationRevision(
          "signerPublication" in input
            ? input.signerPublication.authorizationRevision
            : input.agentAuthorizationRevision,
        ),
        runtime: input.runtime,
      };
    if ("signerPublication" in input) {
      const access = prepareAgentObjectAccessManifestGenesis(input.crypto, {
        ...accessInput,
        grant: input.grant,
        namespace: {
          namespaceId: namespaceId(input.namespace.namespaceId),
          accessRevision: accessRevision(input.namespace.accessRevision),
          bindingHash: input.namespace.bindingHash,
          domainId: cryptoDomainId(input.namespace.domainId),
          domainEpoch: domainEpoch(input.namespace.domainEpoch),
        },
        signerPublication: input.signerPublication,
      });
      return createPreparedAgentConversationCryptoRevision({
        objectId: input.objectId,
        namespaceId: input.namespace.namespaceId,
        object: encryptedObjectWriteRecord(payloadBytes),
        access,
        resolveCurrentAuthorization: input.resolveCurrentAuthorization,
      });
    }
    if (!isDeviceWrappedLiveInput(input)) {
      throw new TypeError("Agent conversation authority shape is invalid");
    }
    const access = prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(
      input.crypto,
      {
        ...accessInput,
        operationId: input.operationId,
        grant: input.grant,
        namespace: {
          namespaceId: namespaceId(input.namespace.namespaceId),
          accessRevision: accessRevision(input.namespace.accessRevision),
          keyGeneration: namespaceGeneration(input.namespace.keyGeneration),
          headDigest: input.namespace.headDigest,
          publicationDigest: input.namespace.publicationDigest,
          publicationSetDigest: input.namespace.publicationSetDigest,
          audienceFingerprint: input.namespace.audienceFingerprint,
        },
        signerKeyId: input.signerKeyId,
        signerPublicKey: input.signerPublicKey,
      },
    );
    return createPreparedDeviceWrappedLiveShadowAgentConversationCryptoRevision({
      objectId: input.objectId,
      namespaceId: input.namespace.namespaceId,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: input.resolveCurrentAuthorization,
      signerPublicKey: input.signerPublicKey.slice(),
    });
  } finally {
    plaintext.fill(0);
    namespaceKey.fill(0);
  }
}

export function prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek(
  input: PrepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDekInput,
): PreparedConversationCryptoRevision {
  const ownedDek = input.objectDek.slice();
  try {
    return prepareWithOwnedDek(input, ownedDek, input.namespaceEnvelopeBytes);
  } finally {
    ownedDek.fill(0);
  }
}

/**
 * Prepare one Agent-authored encrypted message while its AI Namespace key and
 * Runtime generation are live. The encoded plaintext, copied Namespace key,
 * and object DEK are wiped before this function returns.
 */
export function prepareAgentConversationCryptoRevision(
  input: PrepareAgentConversationCryptoRevisionInput,
): PreparedConversationCryptoRevision {
  let dek: Uint8Array | null = null;
  try {
    const seedPlaintext = encodeMessagePayloadV2(input.payload);
    const encrypted = encryptObjectPayload(
      input.crypto,
      {
        objectId: objectId(input.objectId),
        keyClass: "ai",
        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
        createdAt: unixTimestamp(input.createdAt),
      },
      seedPlaintext,
    );
    seedPlaintext.fill(0);
    dek = encrypted.dek;
    return prepareWithOwnedDek(input, dek);
  } finally {
    dek?.fill(0);
  }
}

/** Prepare one exact existing-Message sibling under live Runtime authority. */
export function prepareForegroundRuntimeExistingMessageCryptoRevision(
  input: PrepareForegroundRuntimeExistingMessageCryptoRevisionInput,
): PreparedConversationCryptoRevision {
  let dek: Uint8Array | null = "objectDek" in input
    ? input.objectDek.slice()
    : null;
  try {
    if (dek === null) {
      const seedPlaintext = encodeMessagePayloadV2(input.payload);
      const encrypted = encryptObjectPayload(
        input.crypto,
        {
          objectId: objectId(input.objectId),
          keyClass: "ai",
          objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
          createdAt: unixTimestamp(input.createdAt),
        },
        seedPlaintext,
      );
      seedPlaintext.fill(0);
      dek = encrypted.dek;
    }
    return prepareWithOwnedDek(
      input,
      dek,
      "namespaceEnvelopeBytes" in input
        ? input.namespaceEnvelopeBytes
        : undefined,
      "existing_message_repair",
    );
  } finally {
    dek?.fill(0);
  }
}
