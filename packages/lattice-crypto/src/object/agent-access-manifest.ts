import type { LatticeCrypto } from "../crypto/index.ts";
import {
  createAgentObjectAccessManifestV3,
  type ObjectAccessManifestV3,
} from "../format/object-access-manifest-v3.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  type AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../agent-runtime/types.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  grantId,
  namespaceId,
  objectId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const HASH_BYTES = 32;

export type AgentObjectAccessGrantUseStatusV3 =
  | "reusable"
  | "claimed-by-preflight";

export interface AgentObjectAccessGenesisAuthorityContextV3 {
  readonly purpose: "persist-agent-object-access-genesis";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelope: Readonly<{
    readonly objectId: string;
    readonly namespaceId: string;
    readonly keyClass: "ai";
    readonly keyGeneration: number;
    readonly bindingRevisionAtWrap: number;
    readonly envelopeHash: Uint8Array;
  }>;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly grantUseStatus: AgentObjectAccessGrantUseStatusV3;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceBindingHash: Uint8Array;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly agentAuthorizationRevision: number;
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly signerKeyId: string;
}

export interface PrepareAgentObjectAccessManifestGenesisInputV3 {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly [Uint8Array];
  readonly grant: Readonly<{
    readonly grantId: string;
    readonly grantHash: Uint8Array;
    readonly useStatus: AgentObjectAccessGrantUseStatusV3;
  }>;
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly bindingHash: Uint8Array;
    readonly domainId: string;
    readonly domainEpoch: number;
  }>;
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}

export interface DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1 {
  readonly purpose: "persist-device-wrapped-live-shadow-agent-object-access-genesis";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelope: Readonly<{
    readonly objectId: string;
    readonly namespaceId: string;
    readonly keyClass: "ai";
    readonly keyGeneration: number;
    readonly bindingRevisionAtWrap: number;
    readonly envelopeHash: Uint8Array;
  }>;
  readonly operationId: string;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly recipientKeyId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly agentAuthorizationRevision: number;
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly signerKeyId: string;
}

export interface PrepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisInputV1 {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly [Uint8Array];
  readonly operationId: string;
  readonly grant: Readonly<{
    readonly grantId: string;
    readonly grantHash: Uint8Array;
    readonly recipientKeyId: string;
  }>;
  readonly namespace: Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly keyGeneration: number;
    readonly headDigest: Uint8Array;
    readonly publicationDigest: Uint8Array;
    readonly publicationSetDigest: Uint8Array;
    readonly audienceFingerprint: Uint8Array;
  }>;
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
}

export interface PreparedAgentObjectAccessManifestGenesisV3 {
  readonly manifest: ObjectAccessManifestV3;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly [Uint8Array];
  readonly authority: AgentObjectAccessGenesisAuthorityContextV3;
}

export interface PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1 {
  readonly manifest: ObjectAccessManifestV3;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly [Uint8Array];
  readonly authority:
    DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1;
}

const preparedSnapshots = new WeakMap<
  PreparedAgentObjectAccessManifestGenesisV3,
  Readonly<{
    readonly manifestBytes: Uint8Array;
    readonly manifestHash: Uint8Array;
    readonly envelopeBytes: Uint8Array;
    readonly authority: AgentObjectAccessGenesisAuthorityContextV3;
  }>
>();

const deviceWrappedPreparedSnapshots = new WeakMap<
  PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
  Readonly<{
    readonly manifestBytes: Uint8Array;
    readonly manifestHash: Uint8Array;
    readonly envelopeBytes: Uint8Array;
    readonly authority:
      DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1;
  }>
>();

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function authorityEqual(
  left: AgentObjectAccessGenesisAuthorityContextV3,
  right: AgentObjectAccessGenesisAuthorityContextV3,
): boolean {
  return left.purpose === right.purpose
    && left.objectId === right.objectId
    && bytesEqual(left.payloadHash, right.payloadHash)
    && left.envelope.objectId === right.envelope.objectId
    && left.envelope.namespaceId === right.envelope.namespaceId
    && left.envelope.keyClass === right.envelope.keyClass
    && left.envelope.keyGeneration === right.envelope.keyGeneration
    && left.envelope.bindingRevisionAtWrap
      === right.envelope.bindingRevisionAtWrap
    && bytesEqual(left.envelope.envelopeHash, right.envelope.envelopeHash)
    && left.grantId === right.grantId
    && bytesEqual(left.grantHash, right.grantHash)
    && left.grantUseStatus === right.grantUseStatus
    && left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && bytesEqual(left.namespaceBindingHash, right.namespaceBindingHash)
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.agentAuthorizationRevision === right.agentAuthorizationRevision
    && left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.signerKeyId === right.signerKeyId;
}

function cloneAuthority(
  value: AgentObjectAccessGenesisAuthorityContextV3,
): AgentObjectAccessGenesisAuthorityContextV3 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelope: Object.freeze({
      ...value.envelope,
      envelopeHash: copyOwnedBytesV2(value.envelope.envelopeHash),
    }),
    grantHash: copyOwnedBytesV2(value.grantHash),
    namespaceBindingHash:
      copyOwnedBytesV2(value.namespaceBindingHash),
  });
}

function cloneDeviceWrappedAuthority(
  value: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
): DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelope: Object.freeze({
      ...value.envelope,
      envelopeHash: copyOwnedBytesV2(value.envelope.envelopeHash),
    }),
    grantHash: copyOwnedBytesV2(value.grantHash),
    namespaceHeadDigest: copyOwnedBytesV2(value.namespaceHeadDigest),
    namespacePublicationDigest:
      copyOwnedBytesV2(value.namespacePublicationDigest),
    namespacePublicationSetDigest:
      copyOwnedBytesV2(value.namespacePublicationSetDigest),
    namespaceAudienceFingerprint:
      copyOwnedBytesV2(value.namespaceAudienceFingerprint),
  });
}

function deviceWrappedAuthorityEqual(
  left: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
  right: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
): boolean {
  return left.purpose === right.purpose
    && left.objectId === right.objectId
    && bytesEqual(left.payloadHash, right.payloadHash)
    && left.envelope.objectId === right.envelope.objectId
    && left.envelope.namespaceId === right.envelope.namespaceId
    && left.envelope.keyClass === right.envelope.keyClass
    && left.envelope.keyGeneration === right.envelope.keyGeneration
    && left.envelope.bindingRevisionAtWrap
      === right.envelope.bindingRevisionAtWrap
    && bytesEqual(left.envelope.envelopeHash, right.envelope.envelopeHash)
    && left.operationId === right.operationId
    && left.grantId === right.grantId
    && bytesEqual(left.grantHash, right.grantHash)
    && left.recipientKeyId === right.recipientKeyId
    && left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && bytesEqual(left.namespaceHeadDigest, right.namespaceHeadDigest)
    && bytesEqual(
      left.namespacePublicationDigest,
      right.namespacePublicationDigest,
    )
    && bytesEqual(
      left.namespacePublicationSetDigest,
      right.namespacePublicationSetDigest,
    )
    && bytesEqual(
      left.namespaceAudienceFingerprint,
      right.namespaceAudienceFingerprint,
    )
    && left.agentAuthorizationRevision === right.agentAuthorizationRevision
    && left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.signerKeyId === right.signerKeyId;
}

function prepareAgentObjectAccessManifestGenesisWithSignerV3(
  crypto: LatticeCrypto,
  input: Omit<
    PrepareAgentObjectAccessManifestGenesisInputV3,
    "signerPublication"
  > & Readonly<{ signerKeyId: string }>,
): PreparedAgentObjectAccessManifestGenesisV3 {
  if (
    !Array.isArray(input.envelopeBytes as unknown)
    || input.envelopeBytes.length !== 1
  ) {
    throw new TypeError(
      "Agent object access genesis requires exactly one Namespace envelope",
    );
  }
  const targetObjectId = objectId(input.objectId);
  const targetNamespaceId = namespaceId(input.namespace.namespaceId);
  const namespaceAccessRevision =
    accessRevision(input.namespace.accessRevision);
  const envelopeBytes = copyOwnedBytesV2(input.envelopeBytes[0]);
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  if (
    !bytesEqual(
      encodeNamespaceObjectEnvelopeV2(envelope),
      envelopeBytes,
    )
    || envelope.context.objectId !== targetObjectId
    || envelope.context.namespaceId !== targetNamespaceId
    || envelope.context.keyClass !== "ai"
    || envelope.context.bindingRevisionAtWrap
      !== namespaceAccessRevision
  ) {
    envelopeBytes.fill(0);
    throw new Error(
      "Agent object access Namespace envelope coordinates are invalid",
    );
  }
  const agentAuthorization =
    authorizationRevision(input.agentAuthorizationRevision);
  const payloadHash = exactHash("Agent object payload hash", input.payloadHash);
  const authority = cloneAuthority({
    purpose: "persist-agent-object-access-genesis",
    objectId: targetObjectId,
    payloadHash,
    envelope: {
      objectId: envelope.context.objectId,
      namespaceId: envelope.context.namespaceId,
      keyClass: "ai",
      keyGeneration: envelope.context.keyGeneration,
      bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
      envelopeHash: crypto.hash(envelopeBytes),
    },
    grantId: grantId(input.grant.grantId),
    grantHash: exactHash("Agent object Grant hash", input.grant.grantHash),
    grantUseStatus: input.grant.useStatus,
    namespaceId: targetNamespaceId,
    namespaceAccessRevision,
    namespaceBindingHash: exactHash(
      "Agent object Namespace binding hash",
      input.namespace.bindingHash,
    ),
    domainId: cryptoDomainId(input.namespace.domainId),
    domainEpoch: domainEpoch(input.namespace.domainEpoch),
    agentAuthorizationRevision: agentAuthorization,
    agentId: input.runtime.agentId,
    runtimeGeneration: input.runtime.generation,
    signerKeyId: input.signerKeyId,
  });
  if (
    authority.grantUseStatus !== "reusable"
    && authority.grantUseStatus !== "claimed-by-preflight"
  ) {
    envelopeBytes.fill(0);
    throw new TypeError("Agent object Grant use status is invalid");
  }
  const created = createAgentObjectAccessManifestV3(
    crypto,
    {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [authority.envelope.envelopeHash],
      signer: {
        kind: "agent_runtime",
        agentId: input.runtime.agentId,
        runtimeGeneration: input.runtime.generation,
        signerKeyId: input.signerKeyId,
      },
      hostAuthorizationRevision: agentAuthorization,
    },
    input.runtime,
  );
  const prepared: PreparedAgentObjectAccessManifestGenesisV3 = Object.freeze({
    manifest: created.manifest,
    manifestBytes: created.bytes,
    manifestHash: created.hash,
    envelopeBytes: Object.freeze([envelopeBytes] as const),
    authority,
  });
  preparedSnapshots.set(prepared, Object.freeze({
    manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
    manifestHash: copyOwnedBytesV2(prepared.manifestHash),
    envelopeBytes: copyOwnedBytesV2(envelopeBytes),
    authority: cloneAuthority(authority),
  }));
  return prepared;
}

export function prepareAgentObjectAccessManifestGenesisV3(
  crypto: LatticeCrypto,
  input: PrepareAgentObjectAccessManifestGenesisInputV3,
): PreparedAgentObjectAccessManifestGenesisV3 {
  const agentAuthorization = authorizationRevision(
    input.agentAuthorizationRevision,
  );
  if (
    input.signerPublication.authorizationRevision !== agentAuthorization
    || !agentRuntimeSignerPublicationMatchesRuntimeV1(
      crypto,
      input.runtime,
      input.signerPublication,
    )
  ) {
    throw new Error(
      "Agent Runtime signer publication does not match the prepared Runtime",
    );
  }
  const { signerPublication, ...rest } = input;
  return prepareAgentObjectAccessManifestGenesisWithSignerV3(crypto, {
    ...rest,
    signerKeyId: signerPublication.signerKeyId,
  });
}

/**
 * Prepare the same generic Agent-signed access manifest while binding its
 * unforgeable persistence receipt to the current Namespace publication.
 */
export function prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(
  crypto: LatticeCrypto,
  input: PrepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisInputV1,
): PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1 {
  if (input.envelopeBytes.length !== 1) {
    throw new TypeError(
      "Device-wrapped Agent object access requires one Namespace envelope",
    );
  }
  const targetObjectId = objectId(input.objectId);
  const targetNamespaceId = namespaceId(input.namespace.namespaceId);
  const namespaceAccessRevision = accessRevision(
    input.namespace.accessRevision,
  );
  const envelopeBytes = copyOwnedBytesV2(input.envelopeBytes[0]);
  const derived = deriveAgentRuntimeObjectSignerPublicV1(crypto, input.runtime);
  try {
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    if (
      !bytesEqual(encodeNamespaceObjectEnvelopeV2(envelope), envelopeBytes)
      || envelope.context.objectId !== targetObjectId
      || envelope.context.namespaceId !== targetNamespaceId
      || envelope.context.keyClass !== "ai"
      || envelope.context.keyGeneration !== input.namespace.keyGeneration
      || envelope.context.bindingRevisionAtWrap !== namespaceAccessRevision
      || derived.principal.signerKeyId !== input.signerKeyId
      || !bytesEqual(derived.publicKey, input.signerPublicKey)
    ) {
      throw new Error(
        "Device-wrapped Agent object access coordinates are invalid",
      );
    }
    const agentAuthorization = authorizationRevision(
      input.agentAuthorizationRevision,
    );
    const payloadHash = exactHash(
      "Device-wrapped Agent object payload hash",
      input.payloadHash,
    );
    const authority = cloneDeviceWrappedAuthority({
      purpose:
        "persist-device-wrapped-live-shadow-agent-object-access-genesis",
      objectId: targetObjectId,
      payloadHash,
      envelope: {
        objectId: envelope.context.objectId,
        namespaceId: envelope.context.namespaceId,
        keyClass: "ai",
        keyGeneration: envelope.context.keyGeneration,
        bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
        envelopeHash: crypto.hash(envelopeBytes),
      },
      operationId: input.operationId,
      grantId: grantId(input.grant.grantId),
      grantHash: exactHash(
        "Device-wrapped Agent object Grant hash",
        input.grant.grantHash,
      ),
      recipientKeyId: input.grant.recipientKeyId,
      namespaceId: targetNamespaceId,
      namespaceAccessRevision,
      namespaceHeadDigest: exactHash(
        "Device-wrapped Namespace head digest",
        input.namespace.headDigest,
      ),
      namespacePublicationDigest: exactHash(
        "Device-wrapped Namespace publication digest",
        input.namespace.publicationDigest,
      ),
      namespacePublicationSetDigest: exactHash(
        "Device-wrapped Namespace publication-set digest",
        input.namespace.publicationSetDigest,
      ),
      namespaceAudienceFingerprint: exactHash(
        "Device-wrapped Namespace audience fingerprint",
        input.namespace.audienceFingerprint,
      ),
      agentAuthorizationRevision: agentAuthorization,
      agentId: input.runtime.agentId,
      runtimeGeneration: input.runtime.generation,
      signerKeyId: input.signerKeyId,
    });
    const created = createAgentObjectAccessManifestV3(
      crypto,
      {
        objectId: targetObjectId,
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [authority.envelope.envelopeHash],
        signer: derived.principal,
        hostAuthorizationRevision: agentAuthorization,
      },
      input.runtime,
    );
    const prepared = Object.freeze({
      manifest: created.manifest,
      manifestBytes: created.bytes,
      manifestHash: created.hash,
      envelopeBytes: Object.freeze([envelopeBytes] as const),
      authority,
    });
    deviceWrappedPreparedSnapshots.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: copyOwnedBytesV2(envelopeBytes),
      authority: cloneDeviceWrappedAuthority(authority),
    }));
    return prepared;
  } catch (cause) {
    envelopeBytes.fill(0);
    throw cause;
  } finally {
    derived.publicKey.fill(0);
  }
}

export function assertAuthenticPreparedAgentObjectAccessManifestGenesisV3(
  prepared: PreparedAgentObjectAccessManifestGenesisV3,
): void {
  const snapshot = preparedSnapshots.get(prepared);
  if (
    snapshot === undefined
    || !bytesEqual(snapshot.manifestBytes, prepared.manifestBytes)
    || !bytesEqual(snapshot.manifestHash, prepared.manifestHash)
    || prepared.envelopeBytes.length !== 1
    || !bytesEqual(snapshot.envelopeBytes, prepared.envelopeBytes[0])
    || !authorityEqual(snapshot.authority, prepared.authority)
  ) {
    throw new TypeError(
      "Agent object access persistence requires an authentic prepared genesis",
    );
  }
}

export function assertAuthenticPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(
  prepared: PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
): void {
  const snapshot = deviceWrappedPreparedSnapshots.get(prepared);
  if (
    snapshot === undefined
    || !bytesEqual(snapshot.manifestBytes, prepared.manifestBytes)
    || !bytesEqual(snapshot.manifestHash, prepared.manifestHash)
    || prepared.envelopeBytes.length !== 1
    || !bytesEqual(snapshot.envelopeBytes, prepared.envelopeBytes[0])
    || !deviceWrappedAuthorityEqual(snapshot.authority, prepared.authority)
  ) {
    throw new TypeError(
      "Device-wrapped Agent persistence requires an authentic prepared genesis",
    );
  }
}
