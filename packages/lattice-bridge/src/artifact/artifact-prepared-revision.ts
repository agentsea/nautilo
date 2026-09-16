import type {
  LatticeStorage,
  PreparedHumanObjectAccessManifestGenesisSet,
  ResolveCurrentHumanObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  assertPreparedArtifactCryptoRevision,
  type PreparedArtifactCryptoRevision,
} from "./artifact-repository.ts";

export type ArtifactCryptoRevisionSnapshot = Readonly<{
  revision: PreparedArtifactCryptoRevision;
  object: Parameters<LatticeStorage["putObject"]>[0];
  access: PreparedHumanObjectAccessManifestGenesisSet;
  resolveCurrentAuthorization:
    ResolveCurrentHumanObjectAccessGenesisAuthorization;
}>;

const snapshots = new WeakMap<
  PreparedArtifactCryptoRevision,
  ArtifactCryptoRevisionSnapshot & Readonly<{
    objectPayloadHash: Uint8Array;
    manifestHash: Uint8Array;
    envelopeHashes: readonly Uint8Array[];
  }>
>();

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Mint one process-local authentic handle after both the encrypted control
 * object and its exact Namespace access genesis have been prepared. The blob
 * DEK remains inside the encrypted control payload and is never present here.
 */
export function createPreparedArtifactCryptoRevision(input: Readonly<{
  revision: PreparedArtifactCryptoRevision;
  object: Parameters<LatticeStorage["putObject"]>[0];
  access: PreparedHumanObjectAccessManifestGenesisSet;
  resolveCurrentAuthorization:
    ResolveCurrentHumanObjectAccessGenesisAuthorization;
}>): PreparedArtifactCryptoRevision {
  assertPreparedArtifactCryptoRevision(input.revision);
  const payload = decodeEncryptedPayloadV2(input.object.payloadBytes.ciphertext);
  const manifest = decodeObjectAccessManifestV5(input.access.manifestBytes);
  const envelopeFacts = input.access.envelopeBytes.map((bytes) => Object.freeze({
    namespaceId: decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
    hash: sha256(bytes),
  }));
  const envelopeNamespaceIds = envelopeFacts.map((entry) => entry.namespaceId)
    .sort();
  const canonicalEnvelopeHashes = envelopeFacts.map((entry) => entry.hash)
    .sort((left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) return difference;
      }
      return 0;
    });
  if (
    input.object.objectId !== input.revision.objectId
    || payload.context.objectId !== input.revision.objectId
    || payload.context.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
    || payload.context.keyClass !== "ai"
    || manifest.signer.kind !== "human_device"
    || manifest.objectId !== input.revision.objectId
    || manifest.accessRevision !== 0
    || !exactBytes(
      manifest.payloadHash,
      sha256(input.object.payloadBytes.ciphertext),
    )
    || manifest.envelopeHashes.length !== envelopeFacts.length
    || manifest.envelopeHashes.some((hash, index) =>
      !exactBytes(hash, canonicalEnvelopeHashes[index]!)
    )
    || !exactStrings(
      envelopeNamespaceIds,
      input.revision.requiredNamespaceIds,
    )
  ) throw new Error("Prepared Artifact crypto coordinates disagree");

  const revision = Object.freeze({
    ...input.revision,
    ciphertextSha256: input.revision.ciphertextSha256.slice(),
    requiredNamespaceIds: Object.freeze([
      ...input.revision.requiredNamespaceIds,
    ]),
  });
  snapshots.set(revision, Object.freeze({
    revision,
    object: input.object,
    access: input.access,
    resolveCurrentAuthorization: input.resolveCurrentAuthorization,
    objectPayloadHash: sha256(input.object.payloadBytes.ciphertext),
    manifestHash: sha256(input.access.manifestBytes),
    envelopeHashes: Object.freeze(input.access.envelopeBytes.map((bytes) =>
      sha256(bytes)
    )),
  }));
  return revision;
}

export function readPreparedArtifactCryptoRevisionSnapshot(
  revision: PreparedArtifactCryptoRevision,
): ArtifactCryptoRevisionSnapshot {
  const snapshot = snapshots.get(revision);
  if (snapshot === undefined) {
    throw new TypeError(
      "Artifact crypto revision was not prepared by the bridge crypto role",
    );
  }
  if (
    snapshot.object.objectId !== snapshot.revision.objectId
    || !exactBytes(
      sha256(snapshot.object.payloadBytes.ciphertext),
      snapshot.objectPayloadHash,
    )
    || !exactBytes(sha256(snapshot.access.manifestBytes), snapshot.manifestHash)
    || snapshot.access.envelopeBytes.length !== snapshot.envelopeHashes.length
    || snapshot.access.envelopeBytes.some((bytes, index) =>
      !exactBytes(sha256(bytes), snapshot.envelopeHashes[index]!)
    )
  ) {
    throw new TypeError("Prepared Artifact crypto revision was mutated");
  }
  return snapshot;
}
