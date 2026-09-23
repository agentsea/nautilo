import {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisSet,
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSet,
  type LatticeStorage,
  type PreparedAgentObjectAccessManifestGenesisSet,
  type PreparedHumanObjectAccessManifestGenesisSet,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import type { TaskContentAuthorityV1 } from "./task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1,
  taskContentObjectTypeV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
} from "./task-content-repository.ts";

type CommonTaskContentCryptoRevisionSnapshotV1 = Readonly<{
  coordinate: TaskContentCoordinateV1;
  authority: TaskContentAuthorityV1;
  object: Parameters<LatticeStorage["putObject"]>[0];
}>;

export type HumanTaskContentCryptoRevisionSnapshotV1 =
  CommonTaskContentCryptoRevisionSnapshotV1 & Readonly<{
    signerKind: "human_device";
    access: PreparedHumanObjectAccessManifestGenesisSet;
  }>;

export type AgentTaskContentCryptoRevisionSnapshotV1 =
  CommonTaskContentCryptoRevisionSnapshotV1 & Readonly<{
    signerKind: "agent_runtime";
    access: PreparedAgentObjectAccessManifestGenesisSet;
  }>;

export type TaskContentCryptoRevisionSnapshotV1 =
  | HumanTaskContentCryptoRevisionSnapshotV1
  | AgentTaskContentCryptoRevisionSnapshotV1;

const snapshots = new WeakMap<
  PreparedTaskContentCryptoRevisionV1,
  TaskContentCryptoRevisionSnapshotV1 & Readonly<{
    sealedObjectId: string;
    sealedPayloadHash: Uint8Array;
    sealedManifestHash: Uint8Array;
    sealedEnvelopeHash: Uint8Array;
  }>
>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateCommon(input: TaskContentCryptoRevisionSnapshotV1) {
  const objectId = deriveTaskContentCryptoObjectIdV1(input.coordinate);
  const objectType = taskContentObjectTypeV1(input.coordinate);
  const authorityFingerprint = fingerprintTaskContentAuthorityV1(
    input.authority,
  );
  const payloadBytes = input.object.payloadBytes.ciphertext;
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  const manifest = decodeObjectAccessManifestV5(input.access.manifestBytes);
  if (input.access.envelopeBytes.length !== 1) {
    throw new Error("Prepared Task content requires one Namespace envelope");
  }
  const envelopeBytes = input.access.envelopeBytes[0]!;
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  if (
    input.object.objectId !== objectId
    || payload.context.objectId !== objectId
    || manifest.objectId !== objectId
    || payload.context.objectType !== objectType
    || payload.context.keyClass !== "ai"
    || manifest.accessRevision !== 0
    || !sameBytes(manifest.payloadHash, sha256(payloadBytes))
    || manifest.envelopeHashes.length !== 1
    || !sameBytes(manifest.envelopeHashes[0]!, sha256(envelopeBytes))
    || envelope.context.objectId !== objectId
    || envelope.context.namespaceId !== input.authority.namespaceId
    || envelope.context.keyClass !== "ai"
    || envelope.context.bindingRevisionAtWrap
      !== input.authority.expectedAccessRevision
  ) throw new Error("Prepared Task content crypto coordinates disagree");
  return Object.freeze({
    objectId,
    objectType,
    authorityFingerprint,
    manifest,
  });
}

function seal(
  input: TaskContentCryptoRevisionSnapshotV1,
  common: ReturnType<typeof validateCommon>,
): PreparedTaskContentCryptoRevisionV1 {
  const coordinate = Object.freeze({ ...input.coordinate });
  const revision = Object.freeze({
    coordinate,
    objectId: common.objectId,
    objectType: common.objectType,
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: input.authority.namespaceId,
    authorityFingerprint: common.authorityFingerprint,
  });
  snapshots.set(revision, Object.freeze({
    ...input,
    coordinate,
    authority: Object.freeze({ ...input.authority }),
    sealedObjectId: input.object.objectId,
    sealedPayloadHash: sha256(input.object.payloadBytes.ciphertext),
    sealedManifestHash: sha256(input.access.manifestBytes),
    sealedEnvelopeHash: sha256(input.access.envelopeBytes[0]!),
  }));
  return revision;
}

/** Mint an opaque Task revision prepared and signed by a Human device. */
export function createPreparedHumanTaskContentCryptoRevisionV1(
  input: HumanTaskContentCryptoRevisionSnapshotV1,
): PreparedTaskContentCryptoRevisionV1 {
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSet(input.access);
  const common = validateCommon(input);
  if (
    common.manifest.signer.kind !== "human_device"
    || common.manifest.signer.subjectHumanId
      !== input.authority.requesterHumanId
  ) throw new Error("Prepared Human Task content signer is invalid");
  return seal(input, common);
}

/** Mint an opaque Task revision prepared and signed by an Agent Runtime. */
export function createPreparedAgentTaskContentCryptoRevisionV1(
  input: AgentTaskContentCryptoRevisionSnapshotV1,
): PreparedTaskContentCryptoRevisionV1 {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisSet(input.access);
  const common = validateCommon(input);
  if (common.manifest.signer.kind !== "agent_runtime") {
    throw new Error("Prepared Agent Task content authority is invalid");
  }
  const preparedAuthority = input.access.authority;
  if (preparedAuthority === undefined) {
    throw new Error("Prepared Agent Task content authority is invalid");
  }
  const namespaceBinding = preparedAuthority.namespaceBindings[0];
  const namespaceRequirement = preparedAuthority.namespaceRequirements[0];
  const envelope = preparedAuthority.envelopes[0];
  if (
    preparedAuthority.objectId !== common.objectId
    || preparedAuthority.namespaceBindings.length !== 1
    || preparedAuthority.namespaceRequirements.length !== 1
    || preparedAuthority.domainRequirements.length !== 1
    || preparedAuthority.envelopes.length !== 1
    || namespaceBinding === undefined
    || namespaceBinding.namespaceId !== input.authority.namespaceId
    || namespaceBinding.domainId !== input.authority.domainId
    || namespaceBinding.expectedAccessRevision
      !== input.authority.expectedAccessRevision
    || namespaceBinding.expectedPolicyRevision
      !== input.authority.expectedPolicyRevision
    || namespaceRequirement === undefined
    || namespaceRequirement.namespaceId !== input.authority.namespaceId
    || namespaceRequirement.domainId !== input.authority.domainId
    || namespaceRequirement.expectedAccessRevision
      !== input.authority.expectedAccessRevision
    || namespaceRequirement.expectedPolicyRevision
      !== input.authority.expectedPolicyRevision
    || !namespaceRequirement.operations.includes("encrypt")
    || envelope === undefined
    || envelope.namespaceId !== input.authority.namespaceId
    || envelope.bindingRevisionAtWrap
      !== input.authority.expectedAccessRevision
    || !sameBytes(preparedAuthority.payloadHash, common.manifest.payloadHash)
  ) throw new Error("Prepared Agent Task content authority is invalid");
  return seal(input, common);
}

export function readPreparedTaskContentCryptoRevisionSnapshotV1(
  revision: PreparedTaskContentCryptoRevisionV1,
): TaskContentCryptoRevisionSnapshotV1 {
  const snapshot = snapshots.get(revision);
  if (
    snapshot === undefined
    || !sameTaskContentCoordinateV1(snapshot.coordinate, revision.coordinate)
    || snapshot.object.objectId !== snapshot.sealedObjectId
    || !sameBytes(
      sha256(snapshot.object.payloadBytes.ciphertext),
      snapshot.sealedPayloadHash,
    )
    || !sameBytes(
      sha256(snapshot.access.manifestBytes),
      snapshot.sealedManifestHash,
    )
    || snapshot.access.envelopeBytes.length !== 1
    || !sameBytes(
      sha256(snapshot.access.envelopeBytes[0]!),
      snapshot.sealedEnvelopeHash,
    )
  ) {
    throw new TypeError(
      "Task content crypto revision is foreign or changed after preparation",
    );
  }
  return snapshot as TaskContentCryptoRevisionSnapshotV1;
}
