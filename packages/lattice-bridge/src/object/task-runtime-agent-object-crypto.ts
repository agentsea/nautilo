import {
  LATTICE_LIMITS,
  accessRevision,
  assertAuthenticTaskRuntimeExecutionEvidence,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareTaskRuntimeAgentObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type PreparedTaskRuntimeAgentObjectAccessManifestGenesisSet,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

export interface TaskRuntimeAgentObjectNamespaceMaterial {
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

export interface PreparedTaskRuntimeAgentObject {
  readonly objectId: string;
  readonly objectType: string;
}

type Snapshot = Readonly<{
  evidence: TaskRuntimeExecutionEvidence;
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  access: PreparedTaskRuntimeAgentObjectAccessManifestGenesisSet;
}>;

const snapshots = new WeakMap<PreparedTaskRuntimeAgentObject, Snapshot>();

export function readPreparedTaskRuntimeAgentObjectSnapshot(
  prepared: PreparedTaskRuntimeAgentObject,
  evidence: TaskRuntimeExecutionEvidence,
): Readonly<Omit<Snapshot, "evidence">> {
  assertAuthenticTaskRuntimeExecutionEvidence(evidence);
  const snapshot = snapshots.get(prepared);
  if (
    snapshot === undefined
    || snapshot.evidence !== evidence
    || prepared.objectId !== snapshot.object.objectId
  ) throw new TypeError(
    "Task Runtime Agent object requires its authentic preparation and exact evidence",
  );
  return Object.freeze({
    object: encryptedObjectWriteRecord(
      snapshot.object.payloadBytes.ciphertext.slice(),
    ),
    access: snapshot.access,
  });
}

/** Encrypt canonical Task-owned bytes for an exact authorized Namespace set. */
export function prepareTaskRuntimeAgentObject(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  objectId: string;
  objectType: string;
  plaintextBytes: Uint8Array;
  createdAt: number;
  namespaceSet: readonly TaskRuntimeAgentObjectNamespaceMaterial[];
  operationId: string;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  agentAuthorizationRevision: number;
}>): PreparedTaskRuntimeAgentObject {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  if (
    input.namespaceSet.length < 1
    || input.namespaceSet.length > LATTICE_LIMITS.namespaceEnvelopesPerManifest
    || input.namespaceSet.some((entry, index) =>
      index > 0
      && input.namespaceSet[index - 1]!.namespaceId >= entry.namespaceId
    )
  ) throw new TypeError("Task Runtime Agent object Namespace set is not canonical");
  const targetObjectId = objectId(input.objectId);
  const plaintext = input.plaintextBytes.slice();
  let dek: Uint8Array | null = null;
  try {
    const encrypted = encryptObjectPayload(input.crypto, {
      objectId: targetObjectId,
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
          objectId: targetObjectId,
          namespaceId: namespaceId(entry.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(entry.keyGeneration),
          bindingRevisionAtWrap: accessRevision(entry.accessRevision),
        },
        dek!,
      ))
    );
    const access = prepareTaskRuntimeAgentObjectAccessManifestGenesisSet(
      input.crypto,
      {
        evidence: input.evidence,
        objectId: targetObjectId,
        payloadHash: input.crypto.hash(payloadBytes),
        envelopeBytes,
        operationId: input.operationId,
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
        signerPublication: input.signerPublication,
        resolveHistoricalSignerPublicationManager:
          input.resolveHistoricalSignerPublicationManager,
      },
    );
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
    const prepared = Object.freeze({
      objectId: targetObjectId,
      objectType: input.objectType,
    });
    snapshots.set(prepared, Object.freeze({
      evidence: input.evidence,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
    }));
    return prepared;
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
  }
}
