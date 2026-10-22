import { sha256 } from "@noble/hashes/sha2.js";
import {
  accessRevision,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareDeviceWrappedAgentObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
  type TaskRuntimePublicationSigning,
  type PreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

export interface DeviceWrappedAgentObjectNamespaceMaterial {
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
  readonly key: Uint8Array;
}

export interface PreparedDeviceWrappedAgentObject {
  readonly objectId: string;
  readonly objectType: string;
}

type Snapshot = Readonly<{
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  access: PreparedDeviceWrappedAgentObjectAccessManifestGenesisSet;
}>;

const plaintextDigests = new WeakMap<PreparedDeviceWrappedAgentObject, Uint8Array>();

/** Compare only bytes actually encrypted by this owner; never accept a caller digest. */
export function assertPreparedDeviceWrappedAgentObjectPlaintext(
  prepared: PreparedDeviceWrappedAgentObject, plaintext: Uint8Array,
): void {
  const expected = plaintextDigests.get(prepared);
  const actual = sha256(plaintext);
  try {
    if (expected === undefined || expected.length !== actual.length
      || !expected.every((byte, index) => byte === actual[index])) {
      throw new TypeError("Prepared Agent object plaintext changed");
    }
  } finally { actual.fill(0); }
}

const snapshots = new WeakMap<PreparedDeviceWrappedAgentObject, Snapshot>();

export function readPreparedDeviceWrappedAgentObjectSnapshot(
  prepared: PreparedDeviceWrappedAgentObject,
): Snapshot {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) {
    throw new TypeError("Device-wrapped object lacks preparation custody");
  }
  return snapshot;
}

/** Encrypt arbitrary canonical bytes once for one exact Namespace audience. */
export function prepareDeviceWrappedAgentObject(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  objectType: string;
  plaintextBytes: Uint8Array;
  createdAt: number;
  namespaceSet: readonly DeviceWrappedAgentObjectNamespaceMaterial[];
  operationId: string;
  grant: Readonly<{
    grantId: string;
    grantHash: Uint8Array;
    recipientKeyId: string;
  }>;
  runtime: AgentRuntimeKeyGeneration;
  signerKeyId: string;
  signerPublicKey: Uint8Array;
  agentAuthorizationRevision: number;
  taskRuntimeSigner?: TaskRuntimePublicationSigning;
  taskDefinitionForegroundAuthorizationBytes?: Uint8Array | undefined;
}>): PreparedDeviceWrappedAgentObject {
  if (
    input.namespaceSet.length < 1
    || input.namespaceSet.length > 256
    || input.namespaceSet.some((entry, index) =>
      index > 0
      && input.namespaceSet[index - 1]!.namespaceId >= entry.namespaceId
    )
  ) throw new TypeError("Device-wrapped object Namespace set is not canonical");
  const plaintext = input.plaintextBytes.slice();
  let dek: Uint8Array | null = null;
  try {
    const encrypted = encryptObjectPayload(input.crypto, {
      objectId: objectId(input.objectId),
      keyClass: "ai",
      objectType: input.objectType,
      createdAt: unixTimestamp(input.createdAt),
    }, plaintext);
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = input.namespaceSet.map((entry) =>
      encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
        input.crypto,
        entry.key,
        {
          objectId: objectId(input.objectId),
          namespaceId: namespaceId(entry.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(entry.keyGeneration),
          bindingRevisionAtWrap: accessRevision(entry.accessRevision),
        },
        dek!,
      ))
    );
    const access = prepareDeviceWrappedAgentObjectAccessManifestGenesisSet(
      input.crypto,
      {
        objectId: input.objectId,
        payloadHash: input.crypto.hash(payloadBytes),
        envelopeBytes,
        operationId: input.operationId,
        grant: input.grant,
        namespaces: input.namespaceSet.map((entry) => ({
          namespaceId: entry.namespaceId,
          accessRevision: entry.accessRevision,
          keyGeneration: entry.keyGeneration,
          domainId: entry.domainId,
          domainKeyGeneration: entry.domainKeyGeneration,
          domainAuthorizationRevision: entry.domainAuthorizationRevision,
          domainHeadDigest: entry.domainHeadDigest,
          headDigest: entry.headDigest,
          publicationDigest: entry.publicationDigest,
          publicationSetDigest: entry.publicationSetDigest,
          audienceFingerprint: entry.audienceFingerprint,
        })),
        agentAuthorizationRevision: input.agentAuthorizationRevision,
        runtime: input.runtime,
        signerKeyId: input.signerKeyId,
        signerPublicKey: input.signerPublicKey,
        ...(input.taskRuntimeSigner === undefined ? {} : { taskRuntimeSigner: input.taskRuntimeSigner }),
        ...(input.taskDefinitionForegroundAuthorizationBytes === undefined ? {} : {
          taskDefinitionForegroundAuthorizationBytes:
            input.taskDefinitionForegroundAuthorizationBytes,
        }),
      },
    );
    const prepared = Object.freeze({
      objectId: input.objectId,
      objectType: input.objectType,
    });
    plaintextDigests.set(prepared, sha256(plaintext));
    snapshots.set(prepared, Object.freeze({
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
    }));
    return prepared;
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
  }
}
