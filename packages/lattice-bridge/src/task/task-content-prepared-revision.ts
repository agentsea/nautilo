import {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisSet,
  assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSet,
  assertAuthenticPreparedTaskRuntimeResultObject,
  encryptedObjectWriteRecord,
  verifyHumanTaskPublicationRequest,
  verifyHumanTaskPublicationRequestExactReplay,
  verifyHumanExistingTaskRepresentationPublicationRequest,
  verifyHumanExistingTaskRepresentationPublicationRequestExactReplay,
  type HumanExistingTaskRepresentationPublicationRequest,
  type HumanTaskPublicationRequest,
  type LatticeCrypto,
  type LatticeStorage,
  type PreparedAgentObjectAccessManifestGenesisSet,
  type PreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  type PreparedHumanObjectAccessManifestGenesisSet,
  type PreparedTaskRuntimeResultObject,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  readPreparedDeviceWrappedAgentObjectSnapshot,
  type PreparedDeviceWrappedAgentObject,
} from "../object/device-wrapped-agent-object-crypto.ts";

import { deriveTaskHistoricalContentCryptoObjectIdV1 } from "./task-historical-content-identity.ts";
import type { TaskContentAuthorityV1 } from "./task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1,
  taskContentObjectTypeV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
  type TaskDefinitionContentCoordinateV1,
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

export type TaskRuntimeResultContentCryptoRevisionSnapshotV1 =
  CommonTaskContentCryptoRevisionSnapshotV1 & Readonly<{
    signerKind: "agent_runtime";
    access: PreparedTaskRuntimeResultObject["access"];
  }>;

export type ForegroundTaskDefinitionCryptoRevisionSnapshotV1 =
  CommonTaskContentCryptoRevisionSnapshotV1 & Readonly<{
    signerKind: "agent_runtime";
    publicationFamily: "foreground_definition";
    foregroundPrepared: PreparedDeviceWrappedAgentObject;
    access: PreparedDeviceWrappedAgentObjectAccessManifestGenesisSet;
  }>;

export type TaskContentCryptoRevisionSnapshotV1 =
  | HumanTaskContentCryptoRevisionSnapshotV1
  | AgentTaskContentCryptoRevisionSnapshotV1
  | TaskRuntimeResultContentCryptoRevisionSnapshotV1
  | ForegroundTaskDefinitionCryptoRevisionSnapshotV1;

const snapshots = new WeakMap<
  PreparedTaskContentCryptoRevisionV1,
  TaskContentCryptoRevisionSnapshotV1 & Readonly<{
    sealedObjectId: string;
    sealedPayloadHash: Uint8Array;
    sealedManifestHash: Uint8Array;
    sealedEnvelopeHash: Uint8Array;
    sealedSignerEvidenceHash: Uint8Array | null;
  }>
>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateCommon(input: TaskContentCryptoRevisionSnapshotV1,
  objectId = deriveTaskContentCryptoObjectIdV1(input.coordinate)) {
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
  const envelopeBytes = input.access.envelopeBytes[0];
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
  const signerEvidenceBytes = "signerEvidenceBytes" in input.access
    && input.access.signerEvidenceBytes instanceof Uint8Array
    ? input.access.signerEvidenceBytes
    : null;
  snapshots.set(revision, Object.freeze({
    ...input,
    coordinate,
    authority: Object.freeze({ ...input.authority }),
    sealedObjectId: input.object.objectId,
    sealedPayloadHash: sha256(input.object.payloadBytes.ciphertext),
    sealedManifestHash: sha256(input.access.manifestBytes),
    sealedEnvelopeHash: sha256(input.access.envelopeBytes[0]),
    sealedSignerEvidenceHash: signerEvidenceBytes === null
      ? null
      : sha256(signerEvidenceBytes),
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

export type AuthenticatePreparedHumanTaskContentInputV1 = Readonly<{
  crypto: LatticeCrypto;
  now: number;
  operation: "create" | "update";
  operationId: string;
  coordinate: TaskDefinitionContentCoordinateV1;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  authority: TaskContentAuthorityV1;
  planDigest: Uint8Array;
  operationalFieldsDigest: Uint8Array;
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  signedPublicationRequestBytes: Uint8Array;
  /** Verify current Human/device, private Namespace, binding, policy and key generation. */
  resolveCurrentAuthority: (
    request: HumanTaskPublicationRequest,
  ) => Promise<Uint8Array | null>;
}>;

export type AuthenticatePreparedHumanTaskContentExactReplayInputV1 = Readonly<
  Omit<AuthenticatePreparedHumanTaskContentInputV1, "now"> & {
    expectedSignedRequestDigest: Uint8Array;
  }
>;

/**
 * The HTTP import is a separate authentication boundary. It never fabricates
 * a crypto-owned prepared genesis token; only fully verified bytes may enter
 * this module's existing opaque Task-revision custody.
 */
async function authenticatePreparedHumanTaskContentCryptoRevision(
  input:
    | AuthenticatePreparedHumanTaskContentInputV1
    | AuthenticatePreparedHumanTaskContentExactReplayInputV1,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  if (input.coordinate.kind !== "definition") {
    throw new TypeError("Human Task HTTP publication requires a definition coordinate");
  }
  // Own every mutable value before crossing the authority resolver await.
  const expected = Object.freeze({
    operation: input.operation,
    operationId: input.operationId,
    coordinate: Object.freeze({ ...input.coordinate }),
    expectedContentRevision: input.expectedContentRevision,
    expectedCryptoAccessRevision: input.expectedCryptoAccessRevision,
    authority: Object.freeze({ ...input.authority }),
    planDigest: Uint8Array.from(input.planDigest),
    operationalFieldsDigest: Uint8Array.from(input.operationalFieldsDigest),
  });
  const payloadBytes = Uint8Array.from(input.payloadBytes);
  const manifestBytes = Uint8Array.from(input.manifestBytes);
  const envelopeBytes = Uint8Array.from(input.envelopeBytes);
  const signedBytes = Uint8Array.from(input.signedPublicationRequestBytes);
  const crypto = input.crypto;
  const manifest = decodeObjectAccessManifestV5(manifestBytes);
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  const snapshot: HumanTaskContentCryptoRevisionSnapshotV1 = Object.freeze({
    signerKind: "human_device",
    coordinate: expected.coordinate,
    authority: expected.authority,
    object: encryptedObjectWriteRecord(payloadBytes),
    access: Object.freeze({
      manifest,
      manifestBytes,
      manifestHash: crypto.hash(manifestBytes),
      envelopeBytes: Object.freeze([envelopeBytes]),
    }),
  });
  const common = validateCommon(snapshot);
  let publicKey: Uint8Array | undefined;
  try {
    const resolveCurrentAuthority = async (request: HumanTaskPublicationRequest) => {
      if (
        request.operation !== expected.operation
        || request.operationId !== expected.operationId
        || request.taskId !== expected.coordinate.taskId
        || request.cryptoObjectId !== common.objectId
        || request.nextContentRevision !== expected.coordinate.contentRevision
        || request.expectedContentRevision !== expected.expectedContentRevision
        || request.expectedCryptoAccessRevision !== expected.expectedCryptoAccessRevision
        || !sameBytes(request.planDigest, expected.planDigest)
        || !sameBytes(request.operationalFieldsDigest, expected.operationalFieldsDigest)
        || request.subjectHumanId !== expected.authority.requesterHumanId
        || request.namespaceId !== expected.authority.namespaceId
        || request.domainId !== expected.authority.domainId
        || request.expectedNamespaceAccessRevision !== expected.authority.expectedAccessRevision
        || request.expectedPolicyRevision !== expected.authority.expectedPolicyRevision
        || request.keyGeneration !== envelope.context.keyGeneration
        || !sameBytes(request.payloadHash, crypto.hash(payloadBytes))
        || !sameBytes(request.manifestHash, crypto.hash(manifestBytes))
        || !sameBytes(request.envelopeHash, crypto.hash(envelopeBytes))
      ) throw new TypeError("Signed Task publication coordinates disagree");
      const resolved = await input.resolveCurrentAuthority(request);
      publicKey = resolved === null ? undefined : Uint8Array.from(resolved);
      return publicKey ?? null;
    };
    const request = "expectedSignedRequestDigest" in input
      ? await verifyHumanTaskPublicationRequestExactReplay(crypto, {
          requestBytes: signedBytes,
          expectedRequestDigest: input.expectedSignedRequestDigest,
          resolveCurrentAuthority,
        })
      : await verifyHumanTaskPublicationRequest(crypto, {
      requestBytes: signedBytes,
      now: input.now,
      resolveCurrentAuthority,
    });
    const signingBytes = objectAccessManifestSigningBytesV5({
      objectId: manifest.objectId,
      payloadHash: manifest.payloadHash,
      accessRevision: manifest.accessRevision,
      previousManifestHash: manifest.previousManifestHash,
      envelopeHashes: manifest.envelopeHashes,
      signer: manifest.signer,
      signerAuthorizationHash: manifest.signerAuthorizationHash,
      hostAuthorizationRevision: manifest.hostAuthorizationRevision,
    });
    try {
      if (manifest.previousManifestHash !== null
        || manifest.signerAuthorizationHash !== null
        || manifest.signer.kind !== "human_device"
        || manifest.signer.subjectHumanId !== expected.authority.requesterHumanId
        || manifest.signer.committerDeviceId !== request.committerDeviceId
        || manifest.hostAuthorizationRevision !== request.hostAuthorizationRevision
        || publicKey === undefined
        || !crypto.verify(publicKey, signingBytes, manifest.signature)) {
        throw new TypeError("Task access manifest signature is invalid");
      }
    } finally {
      signingBytes.fill(0);
    }
    return seal(snapshot, common);
  } finally {
    publicKey?.fill(0);
    signedBytes.fill(0);
  }
}

export function authenticatePreparedHumanTaskContentCryptoRevisionV1(
  input: AuthenticatePreparedHumanTaskContentInputV1,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  return authenticatePreparedHumanTaskContentCryptoRevision(input);
}

/** Resume only a ledger-proven exact publication; this grants no fresh admission. */
export function authenticatePreparedHumanTaskContentCryptoRevisionExactReplayV1(
  input: AuthenticatePreparedHumanTaskContentExactReplayInputV1,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  return authenticatePreparedHumanTaskContentCryptoRevision(input);
}

/** Mint an opaque Task revision prepared and signed by an Agent Runtime. */
const historicalRequests = new WeakMap<PreparedTaskContentCryptoRevisionV1,
  HumanExistingTaskRepresentationPublicationRequest>();

export type AuthenticatePreparedHistoricalTaskContentInputV1 = Readonly<{
  crypto: LatticeCrypto;
  now: number;
  operationId: string;
  claimId: string;
  coordinate: TaskContentCoordinateV1;
  authority: TaskContentAuthorityV1;
  sourceDigest: Uint8Array;
  sourcePayloadHash: Uint8Array;
  planDigest: Uint8Array;
  operationalFieldsDigest: Uint8Array;
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  signedPublicationRequestBytes: Uint8Array;
  expectedSignedRequestDigest?: Uint8Array;
  resolveCurrentAuthority(request: HumanExistingTaskRepresentationPublicationRequest):
    Promise<Uint8Array | null>;
}>;

/** Import only an exact source-bound device repair; ordinary Task publishers cannot mint it. */
export async function authenticatePreparedHistoricalTaskContentCryptoRevisionV1(
  input: AuthenticatePreparedHistoricalTaskContentInputV1,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  const copyDigest = (value: Uint8Array): Uint8Array => {
    if (!(value instanceof Uint8Array) || value.length !== 32) {
      throw new TypeError("Historical Task source digest is invalid");
    }
    return Uint8Array.from(value);
  };
  const expected = Object.freeze({
    coordinate: Object.freeze({ ...input.coordinate }),
    authority: Object.freeze({ ...input.authority }),
    operationId: input.operationId, claimId: input.claimId,
    sourceDigest: copyDigest(input.sourceDigest),
    sourcePayloadHash: copyDigest(input.sourcePayloadHash),
    planDigest: copyDigest(input.planDigest),
    operationalFieldsDigest: copyDigest(input.operationalFieldsDigest),
  });
  const payloadBytes = Uint8Array.from(input.payloadBytes);
  const manifestBytes = Uint8Array.from(input.manifestBytes);
  const envelopeBytes = Uint8Array.from(input.envelopeBytes);
  const signedBytes = Uint8Array.from(input.signedPublicationRequestBytes);
  const replayDigest = input.expectedSignedRequestDigest === undefined
    ? undefined : copyDigest(input.expectedSignedRequestDigest);
  const manifest = decodeObjectAccessManifestV5(manifestBytes);
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  const snapshot: HumanTaskContentCryptoRevisionSnapshotV1 = Object.freeze({
    signerKind: "human_device", coordinate: expected.coordinate,
    authority: expected.authority, object: encryptedObjectWriteRecord(payloadBytes),
    access: Object.freeze({ manifest, manifestBytes,
      manifestHash: input.crypto.hash(manifestBytes), envelopeBytes: Object.freeze([envelopeBytes]) }),
  });
  const historicalObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate: expected.coordinate, sourceDigest: expected.sourceDigest, namespaceId: expected.authority.namespaceId,
  });
  // A durable exact-replay digest is the only route for already-published legacy identities.
  const legacyReplay = replayDigest !== undefined
    && snapshot.object.objectId === deriveTaskContentCryptoObjectIdV1(expected.coordinate);
  const common = validateCommon(snapshot, legacyReplay ? snapshot.object.objectId : historicalObjectId);
  let publicKey: Uint8Array | undefined;
  try {
    const resolveCurrentAuthority = async (request: HumanExistingTaskRepresentationPublicationRequest) => {
      if (request.kind !== expected.coordinate.kind
        || request.taskId !== expected.coordinate.taskId
        || request.entityId !== (expected.coordinate.kind === "definition"
          ? expected.coordinate.taskId : expected.coordinate.taskRunId)
        || expected.coordinate.contentRevision !== 1
        || request.operationId !== expected.operationId || request.claimId !== expected.claimId
        || request.cryptoObjectId !== common.objectId
        || request.subjectHumanId !== expected.authority.requesterHumanId
        || request.namespaceId !== expected.authority.namespaceId
        || request.domainId !== expected.authority.domainId
        || request.expectedNamespaceAccessRevision !== expected.authority.expectedAccessRevision
        || request.expectedPolicyRevision !== expected.authority.expectedPolicyRevision
        || request.keyGeneration !== envelope.context.keyGeneration
        || !sameBytes(request.sourceDigest, expected.sourceDigest)
        || !sameBytes(request.sourcePayloadHash, expected.sourcePayloadHash)
        || !sameBytes(request.planDigest, expected.planDigest)
        || !sameBytes(request.operationalFieldsDigest, expected.operationalFieldsDigest)
        || !sameBytes(request.payloadHash, input.crypto.hash(payloadBytes))
        || !sameBytes(request.manifestHash, input.crypto.hash(manifestBytes))
        || !sameBytes(request.envelopeHash, input.crypto.hash(envelopeBytes))) {
        throw new TypeError("Historical Task publication coordinates disagree");
      }
      const resolved = await input.resolveCurrentAuthority(request);
      publicKey = resolved === null ? undefined : Uint8Array.from(resolved);
      return publicKey ?? null;
    };
    const request = replayDigest === undefined
      ? await verifyHumanExistingTaskRepresentationPublicationRequest(input.crypto, {
        requestBytes: signedBytes, now: input.now, resolveCurrentAuthority,
      })
      : await verifyHumanExistingTaskRepresentationPublicationRequestExactReplay(input.crypto, {
        requestBytes: signedBytes, expectedRequestDigest: replayDigest, resolveCurrentAuthority,
      });
    const signingBytes = objectAccessManifestSigningBytesV5({
      objectId: manifest.objectId, payloadHash: manifest.payloadHash,
      accessRevision: manifest.accessRevision, previousManifestHash: manifest.previousManifestHash,
      envelopeHashes: manifest.envelopeHashes, signer: manifest.signer,
      signerAuthorizationHash: manifest.signerAuthorizationHash,
      hostAuthorizationRevision: manifest.hostAuthorizationRevision,
    });
    try {
      if (manifest.previousManifestHash !== null || manifest.signerAuthorizationHash !== null
        || manifest.signer.kind !== "human_device"
        || manifest.signer.subjectHumanId !== expected.authority.requesterHumanId
        || manifest.signer.committerDeviceId !== request.committerDeviceId
        || manifest.hostAuthorizationRevision !== request.hostAuthorizationRevision
        || publicKey === undefined || !input.crypto.verify(publicKey, signingBytes, manifest.signature)) {
        throw new TypeError("Historical Task access manifest signature is invalid");
      }
    } finally { signingBytes.fill(0); }
    const revision = seal(snapshot, common);
    historicalRequests.set(revision, request);
    return revision;
  } finally { publicKey?.fill(0); signedBytes.fill(0); replayDigest?.fill(0); }
}

/** The returned facts retain no private key and remain tied to the authentic prepared bytes. */
export function readPreparedHistoricalTaskContentRequestV1(
  revision: PreparedTaskContentCryptoRevisionV1,
): HumanExistingTaskRepresentationPublicationRequest {
  readPreparedTaskContentCryptoRevisionSnapshotV1(revision);
  const request = historicalRequests.get(revision);
  if (request === undefined) throw new TypeError("Task revision is not an authenticated historical repair");
  return Object.freeze({ ...request,
    sourceDigest: Uint8Array.from(request.sourceDigest),
    sourcePayloadHash: Uint8Array.from(request.sourcePayloadHash),
    planDigest: Uint8Array.from(request.planDigest),
    operationalFieldsDigest: Uint8Array.from(request.operationalFieldsDigest),
    bindingHash: Uint8Array.from(request.bindingHash),
    payloadHash: Uint8Array.from(request.payloadHash),
    manifestHash: Uint8Array.from(request.manifestHash),
    envelopeHash: Uint8Array.from(request.envelopeHash),
    signature: Uint8Array.from(request.signature),
  });
}

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

/** Preserve the foreground device-wrapped family; never manufacture execution evidence. */
export function createPreparedForegroundTaskDefinitionCryptoRevisionV1(input: Readonly<{
  coordinate: TaskDefinitionContentCoordinateV1;
  authority: TaskContentAuthorityV1;
  prepared: PreparedDeviceWrappedAgentObject;
}>): PreparedTaskContentCryptoRevisionV1 {
  if (input.coordinate.kind !== "definition"
    || !Number.isSafeInteger(input.coordinate.contentRevision)
    || input.coordinate.contentRevision < 1) {
    throw new TypeError("Foreground Task definition revision is invalid");
  }
  const prepared = readPreparedDeviceWrappedAgentObjectSnapshot(input.prepared);
  assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet(prepared.access);
  const snapshot: ForegroundTaskDefinitionCryptoRevisionSnapshotV1 = {
    coordinate: input.coordinate, authority: input.authority,
    signerKind: "agent_runtime", publicationFamily: "foreground_definition",
    foregroundPrepared: input.prepared, object: prepared.object, access: prepared.access,
  };
  const common = validateCommon(snapshot);
  const context = prepared.access.authority;
  const namespace = context.namespaces[0];
  if (context.objectId !== common.objectId || context.namespaces.length !== 1
    || namespace === undefined || namespace.namespaceId !== input.authority.namespaceId
    || namespace.domainId !== input.authority.domainId
    || namespace.accessRevision !== input.authority.expectedAccessRevision
    || !sameBytes(context.payloadHash, common.manifest.payloadHash)
    || common.manifest.signer.kind !== "agent_runtime") {
    throw new TypeError("Foreground Task definition authority disagrees");
  }
  return seal(snapshot, common);
}

/** Mint an opaque Task result revision from live Task Runtime evidence. */
export function createPreparedTaskRuntimeResultContentCryptoRevisionV1(
  input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    authority: TaskContentAuthorityV1;
    prepared: PreparedTaskRuntimeResultObject;
  }>,
): PreparedTaskContentCryptoRevisionV1 {
  assertAuthenticPreparedTaskRuntimeResultObject(input.prepared);
  if (input.coordinate.kind !== "run_result") {
    throw new TypeError("Task Runtime preparation requires a result coordinate");
  }
  const snapshot: TaskRuntimeResultContentCryptoRevisionSnapshotV1 =
    Object.freeze({
      signerKind: "agent_runtime",
      coordinate: input.coordinate,
      authority: input.authority,
      object: input.prepared.object,
      access: input.prepared.access,
    });
  const common = validateCommon(snapshot);
  const preparedAuthority = input.prepared.access.authority;
  if (
    input.coordinate.taskId !== preparedAuthority.taskId
    || input.coordinate.taskRunId !== preparedAuthority.taskRunId
    || input.coordinate.contentRevision !== preparedAuthority.contentRevision
    || common.objectId !== preparedAuthority.objectId
    || common.manifest.signer.kind !== "agent_runtime"
    || common.manifest.signer.agentId !== preparedAuthority.agentId
    || common.manifest.signer.runtimeGeneration
      !== preparedAuthority.runtimeGeneration
    || common.manifest.signer.signerKeyId !== preparedAuthority.signerKeyId
    || (input.prepared.access.signerEvidenceBytes === undefined
      ? common.manifest.hostAuthorizationRevision
        !== preparedAuthority.agentAuthorizationRevision
      : common.manifest.signerAuthorizationHash === null
        || !sameBytes(
          common.manifest.signerAuthorizationHash,
          sha256(input.prepared.access.signerEvidenceBytes),
        ))
    || input.authority.namespaceId
      !== preparedAuthority.namespace.namespaceId
    || input.authority.domainId !== preparedAuthority.namespace.domainId
    || input.authority.expectedAccessRevision
      !== preparedAuthority.namespace.expectedAccessRevision
    || input.authority.expectedPolicyRevision
      !== preparedAuthority.namespace.expectedPolicyRevision
    || !sameBytes(
      common.manifest.payloadHash,
      preparedAuthority.payloadHash,
    )
  ) throw new TypeError("Prepared Task Runtime result authority is invalid");
  return seal(snapshot, common);
}

export function readPreparedTaskContentCryptoRevisionSnapshotV1(
  revision: PreparedTaskContentCryptoRevisionV1,
): TaskContentCryptoRevisionSnapshotV1 {
  const snapshot = snapshots.get(revision);
  const signerEvidenceBytes = snapshot !== undefined
    && "signerEvidenceBytes" in snapshot.access
    && snapshot.access.signerEvidenceBytes instanceof Uint8Array
    ? snapshot.access.signerEvidenceBytes
    : null;
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
      sha256(snapshot.access.envelopeBytes[0]),
      snapshot.sealedEnvelopeHash,
    )
    || (snapshot.sealedSignerEvidenceHash === null)
      !== (signerEvidenceBytes === null)
    || (snapshot.sealedSignerEvidenceHash !== null
      && !sameBytes(
        sha256(signerEvidenceBytes!),
        snapshot.sealedSignerEvidenceHash,
      ))
  ) {
    throw new TypeError(
      "Task content crypto revision is foreign or changed after preparation",
    );
  }
  if ("publicationFamily" in snapshot && snapshot.publicationFamily === "foreground_definition") {
    assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet(snapshot.access);
  }
  return snapshot as TaskContentCryptoRevisionSnapshotV1;
}
