import type { LatticeCrypto } from "../crypto/index.ts";
import {
  createAgentObjectAccessManifestV5,
  type ObjectAccessManifestV5,
} from "../format/object-access-manifest-v5.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import {
  accessRevision,
  authorizationRevision,
  grantId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const HASH_BYTES = 32;

export interface DeviceWrappedAgentNamespaceAuthorityV1 {
  readonly namespaceId: string;
  readonly accessRevision: number;
  readonly keyGeneration: number;
  readonly domainId: string;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: number;
  readonly domainHeadDigest: Uint8Array;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
}

export interface DeviceWrappedAgentEnvelopeAuthorityV1 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly keyClass: "ai";
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1 {
  readonly purpose:
    "persist-device-wrapped-live-shadow-agent-object-access-genesis-set";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes: readonly DeviceWrappedAgentEnvelopeAuthorityV1[];
  readonly operationId: string;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly recipientKeyId: string;
  readonly namespaces: readonly DeviceWrappedAgentNamespaceAuthorityV1[];
  readonly agentAuthorizationRevision: number;
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly signerKeyId: string;
}

export interface PrepareDeviceWrappedAgentObjectAccessManifestGenesisSetInputV1 {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly operationId: string;
  readonly grant: Readonly<{
    readonly grantId: string;
    readonly grantHash: Uint8Array;
    readonly recipientKeyId: string;
  }>;
  readonly namespaces: readonly DeviceWrappedAgentNamespaceAuthorityV1[];
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
}

export interface PreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authority:
    DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1;
}

type PreparedSnapshot = Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  authorityFingerprint: string;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneNamespace(
  value: DeviceWrappedAgentNamespaceAuthorityV1,
): DeviceWrappedAgentNamespaceAuthorityV1 {
  namespaceId(value.namespaceId);
  accessRevision(value.accessRevision);
  namespaceGeneration(value.keyGeneration);
  return Object.freeze({
    ...value,
    domainHeadDigest: exactHash(
      "Domain head digest",
      value.domainHeadDigest,
    ),
    headDigest: exactHash("Namespace head digest", value.headDigest),
    publicationDigest: exactHash(
      "Namespace publication digest",
      value.publicationDigest,
    ),
    publicationSetDigest: exactHash(
      "Namespace publication-set digest",
      value.publicationSetDigest,
    ),
    audienceFingerprint: exactHash(
      "Namespace audience fingerprint",
      value.audienceFingerprint,
    ),
  });
}

export function cloneDeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1(
  value: DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
): DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1 {
  return Object.freeze({
    ...value,
    payloadHash: exactHash("Agent object payload hash", value.payloadHash),
    grantHash: exactHash("Agent object Grant hash", value.grantHash),
    envelopes: Object.freeze(value.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: exactHash("Namespace envelope hash", entry.envelopeHash),
    }))),
    namespaces: Object.freeze(value.namespaces.map(cloneNamespace)),
  });
}

function fingerprint(
  value: DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
): string {
  return JSON.stringify({
    ...value,
    payloadHash: Buffer.from(value.payloadHash).toString("base64url"),
    grantHash: Buffer.from(value.grantHash).toString("base64url"),
    envelopes: value.envelopes.map((entry) => ({
      ...entry,
      envelopeHash: Buffer.from(entry.envelopeHash).toString("base64url"),
    })),
    namespaces: value.namespaces.map((entry) => ({
      ...entry,
      headDigest: Buffer.from(entry.headDigest).toString("base64url"),
      publicationDigest:
        Buffer.from(entry.publicationDigest).toString("base64url"),
      publicationSetDigest:
        Buffer.from(entry.publicationSetDigest).toString("base64url"),
      audienceFingerprint:
        Buffer.from(entry.audienceFingerprint).toString("base64url"),
    })),
  });
}

export function deviceWrappedAgentObjectAccessGenesisSetAuthorityContextsEqualV1(
  left: DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
  right: DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
): boolean {
  return fingerprint(left) === fingerprint(right);
}

/** Prepare one Runtime-signed access genesis for one exact Namespace set. */
export function prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1(
  crypto: LatticeCrypto,
  input: PrepareDeviceWrappedAgentObjectAccessManifestGenesisSetInputV1,
): PreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1 {
  if (
    input.envelopeBytes.length < 1
    || input.envelopeBytes.length > V2_LIMITS.namespaceEnvelopesPerManifest
    || input.envelopeBytes.length !== input.namespaces.length
  ) throw new TypeError("Device-wrapped Agent Namespace set is invalid");
  const targetObjectId = objectId(input.objectId);
  const namespaces = input.namespaces.map(cloneNamespace);
  if (namespaces.some((entry, index) =>
    index > 0 && namespaces[index - 1]!.namespaceId >= entry.namespaceId
  )) throw new TypeError("Device-wrapped Agent Namespace set is not canonical");
  const namespaceById = new Map(
    namespaces.map((entry) => [entry.namespaceId, entry]),
  );
  const envelopeEntries = input.envelopeBytes.map((bytes) => {
    const owned = copyOwnedBytesV2(bytes);
    try {
      const decoded = decodeNamespaceObjectEnvelopeV2(owned);
      const namespace = namespaceById.get(decoded.context.namespaceId);
      if (
        !equalBytes(encodeNamespaceObjectEnvelopeV2(decoded), owned)
        || decoded.context.objectId !== targetObjectId
        || decoded.context.keyClass !== "ai"
        || namespace === undefined
        || decoded.context.keyGeneration !== namespace.keyGeneration
        || decoded.context.bindingRevisionAtWrap !== namespace.accessRevision
      ) throw new TypeError("Device-wrapped Agent envelope is invalid");
      return Object.freeze({
        bytes: owned,
        context: Object.freeze({
          objectId: targetObjectId,
          namespaceId: decoded.context.namespaceId,
          keyClass: "ai" as const,
          keyGeneration: decoded.context.keyGeneration,
          bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
          envelopeHash: crypto.hash(owned),
        }),
      });
    } catch (cause) {
      owned.fill(0);
      throw cause;
    }
  });
  try {
    envelopeEntries.sort((left, right) => {
      const leftId = left.context.namespaceId;
      const rightId = right.context.namespaceId;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    if (envelopeEntries.some((entry, index) =>
      entry.context.namespaceId !== namespaces[index]!.namespaceId
    )) throw new TypeError("Device-wrapped Agent envelope set is incomplete");
    const derived = deriveAgentRuntimeObjectSignerPublicV1(
      crypto,
      input.runtime,
    );
    try {
      if (
        derived.principal.signerKeyId !== input.signerKeyId
        || !equalBytes(derived.publicKey, input.signerPublicKey)
      ) throw new TypeError("Device-wrapped Agent Runtime signer is invalid");
      const agentAuthorization = authorizationRevision(
        input.agentAuthorizationRevision,
      );
      const payloadHash = exactHash(
        "Agent object payload hash",
        input.payloadHash,
      );
      const created = createAgentObjectAccessManifestV5(crypto, {
        objectId: targetObjectId,
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: envelopeEntries.map((entry) =>
          entry.context.envelopeHash
        ),
        signer: derived.principal,
        signerAuthorizationHash: null,
        hostAuthorizationRevision: agentAuthorization,
      }, input.runtime);
      const authority =
        cloneDeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1({
          purpose:
            "persist-device-wrapped-live-shadow-agent-object-access-genesis-set",
          objectId: targetObjectId,
          payloadHash,
          envelopes: envelopeEntries.map((entry) => entry.context),
          operationId: input.operationId,
          grantId: grantId(input.grant.grantId),
          grantHash: exactHash(
            "Agent object Grant hash",
            input.grant.grantHash,
          ),
          recipientKeyId: input.grant.recipientKeyId,
          namespaces,
          agentAuthorizationRevision: agentAuthorization,
          agentId: input.runtime.agentId,
          runtimeGeneration: input.runtime.generation,
          signerKeyId: input.signerKeyId,
        });
      const prepared = Object.freeze({
        manifest: created.manifest,
        manifestBytes: created.bytes,
        manifestHash: created.hash,
        envelopeBytes: Object.freeze(
          envelopeEntries.map((entry) => entry.bytes),
        ),
        authority,
      });
      preparedSnapshots.set(prepared, Object.freeze({
        manifestBytes: copyOwnedBytesV2(created.bytes),
        manifestHash: copyOwnedBytesV2(created.hash),
        envelopeBytes: Object.freeze(
          envelopeEntries.map((entry) => copyOwnedBytesV2(entry.bytes)),
        ),
        authorityFingerprint: fingerprint(authority),
      }));
      return prepared;
    } finally {
      derived.publicKey.fill(0);
    }
  } catch (cause) {
    envelopeEntries.forEach((entry) => entry.bytes.fill(0));
    throw cause;
  }
}

export function assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1(
  prepared: PreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1,
): void {
  const snapshot = preparedSnapshots.get(prepared);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((entry, index) =>
      !equalBytes(entry, prepared.envelopeBytes[index]!)
    )
    || snapshot.authorityFingerprint !== fingerprint(prepared.authority)
  ) throw new TypeError(
    "Device-wrapped Agent set persistence requires authentic preparation",
  );
}
