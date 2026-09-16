import type {
  LatticeStorage,
  PreparedAgentObjectAccessManifestGenesisSet,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";

import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  type PreparedMemoryCryptoRevision,
} from "./memory-repository.ts";

export interface MemoryCryptoRevisionSnapshot {
  readonly objectId: string;
  readonly requiredNamespaceIds: readonly string[];
  readonly object: Parameters<LatticeStorage["putObject"]>[0];
  readonly access: PreparedAgentObjectAccessManifestGenesisSet;
}

const snapshots = new WeakMap<
  PreparedMemoryCryptoRevision,
  MemoryCryptoRevisionSnapshot
>();

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Seal one bridge-created Memory revision behind an opaque public handle.
 * Raw ciphertext, envelopes, and manifests are retained only in the
 * process-local snapshot consumed by restricted storage. Deletion manifests
 * are deliberately absent: they are prepared only for an authorized delete.
 */
export function createPreparedMemoryCryptoRevision(input: Readonly<{
  memoryId: string;
  contentRevision: number;
  objectId: string;
  requiredNamespaceIds: readonly string[];
  object: Parameters<LatticeStorage["putObject"]>[0];
  access: PreparedAgentObjectAccessManifestGenesisSet;
}>): PreparedMemoryCryptoRevision {
  const payload = decodeEncryptedPayloadV2(input.object.payloadBytes.ciphertext);
  const manifest = decodeObjectAccessManifestV5(input.access.manifestBytes);
  const envelopeNamespaceIds = input.access.envelopeBytes
    .map((bytes) => decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId)
    .sort();
  if (
    input.objectId !== input.object.objectId
    || input.objectId !== payload.context.objectId
    || input.objectId !== manifest.objectId
    || payload.context.objectType !== MEMORY_OBJECT_TYPE
    || payload.context.keyClass !== "ai"
    || manifest.accessRevision !== 0
    || !exactStrings(envelopeNamespaceIds, input.requiredNamespaceIds)
    || !exactStrings(
      input.access.authority.namespaceRequirements.map((entry) =>
        entry.namespaceId
      ),
      input.requiredNamespaceIds,
    )
  ) {
    throw new Error("Prepared Memory crypto coordinates disagree");
  }
  const revision = Object.freeze({
    memoryId: input.memoryId,
    contentRevision: input.contentRevision,
    objectId: input.objectId,
    objectType: MEMORY_OBJECT_TYPE,
    payloadVersion: MEMORY_PAYLOAD_VERSION,
    requiredNamespaceIds: Object.freeze([...input.requiredNamespaceIds]),
  });
  snapshots.set(revision, Object.freeze({
    objectId: input.objectId,
    requiredNamespaceIds: Object.freeze([...input.requiredNamespaceIds]),
    object: input.object,
    access: input.access,
  }));
  return revision;
}

export function readPreparedMemoryCryptoRevisionSnapshot(
  revision: PreparedMemoryCryptoRevision,
): MemoryCryptoRevisionSnapshot {
  const snapshot = snapshots.get(revision);
  if (snapshot === undefined) {
    throw new TypeError(
      "Memory crypto revision was not prepared by the bridge crypto role",
    );
  }
  return snapshot;
}
