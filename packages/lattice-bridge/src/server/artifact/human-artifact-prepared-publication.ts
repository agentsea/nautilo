import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
  type HumanArtifactPublicationRequest,
  type LatticeCrypto,
  unixTimestamp,
  verifyHumanArtifactPublicationRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeHumanArtifactPublicationRequestV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "@nautilo/lattice-crypto/wire";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  artifactBlobStorageRefV1,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactPublicationPlanInput,
  type PreparedArtifactCryptoRevision,
} from "../../artifact/artifact-repository.ts";
import type { EncryptedArtifactBlobReferenceV1 } from "../../artifact/filesystem-blob-store.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export type HumanArtifactPublicationAuthorityContext = Readonly<{
  purpose: "authorize-human-artifact-publication";
  expectedHumanId: string;
  operationId: string;
  artifactId: string;
  anchorNamespaceId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
  entries: HumanArtifactPublicationRequest["entries"];
}>;

export type ResolveHumanArtifactPublicationAuthority = (
  context: HumanArtifactPublicationAuthorityContext,
) => Promise<Readonly<{
  context: HumanArtifactPublicationAuthorityContext;
  committerSigningPublicKey: Uint8Array;
}> | null>;

export type AuthenticatedHumanArtifactPublication = Readonly<{
  operationId: string;
  artifactId: string;
  artifactRevision: number;
}>;

export type AuthenticatedHumanArtifactPublicationSnapshot = Readonly<{
  prepared: AuthenticatedHumanArtifactPublication;
  expectedHumanId: string;
  authority: HumanArtifactPublicationAuthorityContext;
  lifecycleAction: "activate" | "archive";
  /** Durable server-issued plan digest. */
  requestDigest: Uint8Array;
  /** Hash of the complete canonical signed publication request. */
  allocationRequestDigest: Uint8Array;
  plan: ArtifactPublicationPlanInput;
  revision: PreparedArtifactCryptoRevision;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopes: readonly Readonly<{
    namespaceId: string;
    envelopeBytes: Uint8Array;
    envelopeHash: Uint8Array;
  }>[];
}>;

const snapshots = new WeakMap<
  AuthenticatedHumanArtifactPublication,
  AuthenticatedHumanArtifactPublicationSnapshot
>();

function decodeBase64url(label: string, value: string, maximum: number): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString("base64url") !== value) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function humanArtifactPublicationAuthorityMatches(
  left: HumanArtifactPublicationAuthorityContext,
  right: HumanArtifactPublicationAuthorityContext,
): boolean {
  return left.purpose === right.purpose
    && left.expectedHumanId === right.expectedHumanId
    && left.operationId === right.operationId
    && left.artifactId === right.artifactId
    && left.anchorNamespaceId === right.anchorNamespaceId
    && left.committerDeviceId === right.committerDeviceId
    && left.hostAuthorizationRevision === right.hostAuthorizationRevision
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const expected = right.entries[index]!;
      return entry.namespaceId === expected.namespaceId
        && entry.domainId === expected.domainId
        && entry.expectedNamespaceAccessRevision
          === expected.expectedNamespaceAccessRevision
        && entry.expectedPolicyRevision === expected.expectedPolicyRevision
        && equalBytes(entry.bindingHash, expected.bindingHash)
        && entry.keyGeneration === expected.keyGeneration
        && entry.bindingRevisionAtWrap === expected.bindingRevisionAtWrap
        && equalBytes(entry.envelopeHash, expected.envelopeHash);
    });
}

function cloneEntries(
  entries: HumanArtifactPublicationRequest["entries"],
): HumanArtifactPublicationRequest["entries"] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    bindingHash: entry.bindingHash.slice(),
    envelopeHash: entry.envelopeHash.slice(),
  })));
}

function wipeRequest(request: HumanArtifactPublicationRequest | undefined): void {
  if (request === undefined) return;
  request.controlPayloadHash.fill(0);
  request.accessManifestHash.fill(0);
  request.ciphertextSha256.fill(0);
  request.signature.fill(0);
  request.entries.forEach((entry) => {
    entry.bindingHash.fill(0);
    entry.envelopeHash.fill(0);
  });
}

export async function authenticateHumanArtifactPublication(input: Readonly<{
  crypto: LatticeCrypto;
  expectedHumanId: string;
  prepared: ProtectedArtifactPreparedPublicationRequestV1;
  blob: EncryptedArtifactBlobReferenceV1;
  now: number;
  resolveAuthority: ResolveHumanArtifactPublicationAuthority;
}>): Promise<AuthenticatedHumanArtifactPublication> {
  const expectedObjectId = deriveArtifactControlObjectIdV1({
    artifactId: input.prepared.artifactId,
    artifactRevision: input.prepared.nextArtifactRevision,
  });
  let payloadBytes: Uint8Array | undefined;
  let manifestBytes: Uint8Array | undefined;
  let signedBytes: Uint8Array | undefined;
  let planDigest: Uint8Array | undefined;
  let request: HumanArtifactPublicationRequest | undefined;
  let decodedRequest: HumanArtifactPublicationRequest | undefined;
  let authorityContext: HumanArtifactPublicationAuthorityContext | undefined;
  let publicKey: Uint8Array | undefined;
  let payloadHash: Uint8Array | undefined;
  let manifestHash: Uint8Array | undefined;
  const envelopeFacts: Array<Readonly<{
    namespaceId: string;
    envelopeBytes: Uint8Array;
    envelopeHash: Uint8Array;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
  }>> = [];
  try {
    payloadBytes = decodeBase64url(
      "Artifact encrypted control",
      input.prepared.encryptedControlPayloadBytesBase64url,
      4 * 1_048_576,
    );
    manifestBytes = decodeBase64url(
      "Artifact access manifest",
      input.prepared.accessManifestBytesBase64url,
      512 * 1_024,
    );
    signedBytes = decodeBase64url(
      "Artifact signed publication",
      input.prepared.signedPublicationRequestBytesBase64url,
      256 * 1_024,
    );
    planDigest = decodeBase64url(
      "Artifact plan digest",
      input.prepared.planDigestBase64url,
      32,
    );
    if (planDigest.length !== 32) {
      throw new TypeError("Artifact plan digest must be exactly 32 bytes");
    }
    payloadHash = input.crypto.hash(payloadBytes);
    manifestHash = input.crypto.hash(manifestBytes);
    const payload = decodeEncryptedPayloadV2(payloadBytes);
    const manifest = decodeObjectAccessManifestV5(manifestBytes);
    for (const outer of input.prepared.namespaceEnvelopes) {
      const envelopeBytes = decodeBase64url(
        "Artifact Namespace envelope",
        outer.envelopeBytesBase64url,
        512 * 1_024,
      );
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      const envelopeHash = input.crypto.hash(envelopeBytes);
      if (
        outer.namespaceId !== envelope.context.namespaceId
        || envelope.context.objectId !== expectedObjectId
        || envelope.context.keyClass !== "ai"
      ) throw new TypeError("Artifact Namespace envelope coordinates disagree");
      envelopeFacts.push(Object.freeze({
        namespaceId: outer.namespaceId,
        envelopeBytes,
        envelopeHash,
        keyGeneration: envelope.context.keyGeneration,
        bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
      }));
    }
    const requiredNamespaceIds = envelopeFacts.map((entry) => entry.namespaceId);
    const sortedHashes = envelopeFacts.map((entry) => entry.envelopeHash)
      .sort((left, right) => Buffer.compare(left, right));
    if (
      !equalStrings(requiredNamespaceIds, input.prepared.requiredNamespaceIds)
      || !equalStrings(requiredNamespaceIds, [...requiredNamespaceIds].sort())
      || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
      || payload.context.objectId !== expectedObjectId
      || payload.context.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
      || payload.context.keyClass !== "ai"
      || manifest.objectId !== expectedObjectId
      || manifest.accessRevision !== 0
      || manifest.previousManifestHash !== null
      || !equalBytes(manifest.payloadHash, payloadHash)
      || manifest.envelopeHashes.length !== sortedHashes.length
      || manifest.envelopeHashes.some((hash, index) =>
        !equalBytes(hash, sortedHashes[index]!)
      )
    ) throw new TypeError("Artifact encrypted control/access coordinates disagree");

    decodedRequest = decodeHumanArtifactPublicationRequestV1(signedBytes);
    const currentAuthorityContext = Object.freeze({
      purpose: "authorize-human-artifact-publication",
      expectedHumanId: input.expectedHumanId,
      operationId: decodedRequest.operationId,
      artifactId: decodedRequest.artifactId,
      anchorNamespaceId: decodedRequest.anchorNamespaceId,
      committerDeviceId: decodedRequest.committerDeviceId,
      hostAuthorizationRevision: decodedRequest.hostAuthorizationRevision,
      entries: cloneEntries(decodedRequest.entries),
    });
    authorityContext = currentAuthorityContext;
    const authority = await input.resolveAuthority(currentAuthorityContext);
    if (
      authority === null
      || !humanArtifactPublicationAuthorityMatches(
        authority.context,
        currentAuthorityContext,
      )
    ) {
      authority?.committerSigningPublicKey.fill(0);
      throw new TypeError("Artifact publication authority is unavailable");
    }
    publicKey = authority.committerSigningPublicKey.slice();
    authority.committerSigningPublicKey.fill(0);
    request = verifyHumanArtifactPublicationRequest(input.crypto, {
      requestBytes: signedBytes,
      now: unixTimestamp(input.now),
      resolveCurrentAuthority: (context) =>
        context.subjectHumanId === input.expectedHumanId
          && context.operationId === currentAuthorityContext.operationId
          && context.committerDeviceId === currentAuthorityContext.committerDeviceId
          && context.hostAuthorizationRevision
            === currentAuthorityContext.hostAuthorizationRevision
          ? publicKey! : null,
    });
    const operation = input.prepared.operation === "create"
      ? "create" : input.prepared.operation === "replace_content" ? "content" : "control";
    if (
      request.subjectHumanId !== input.expectedHumanId
      || request.operationId !== input.prepared.operationId
      || !equalBytes(request.planDigest, planDigest)
      || request.operation !== input.prepared.operation
      || request.lifecycleAction !== input.prepared.lifecycleAction
      || request.artifactRowId !== input.prepared.artifactRowId
      || request.artifactId !== input.prepared.artifactId
      || request.anchorNamespaceId !== input.prepared.anchorNamespaceId
      || request.cryptoObjectId !== expectedObjectId
      || input.prepared.cryptoObjectId !== expectedObjectId
      || request.expectedArtifactRevision !== input.prepared.expectedArtifactRevision
      || request.nextArtifactRevision !== input.prepared.nextArtifactRevision
      || request.expectedAccessRevision !== input.prepared.expectedCryptoAccessRevision
      || request.resultAccessRevision !== input.prepared.resultCryptoAccessRevision
      || request.expectedBlobGeneration !== input.prepared.expectedBlobGeneration
      || request.resultBlobGeneration !== input.prepared.resultBlobGeneration
      || request.expectedBlobId !== input.prepared.expectedBlobId
      || request.resultBlobId !== input.prepared.resultBlobId
      || !equalBytes(request.controlPayloadHash, payloadHash)
      || !equalBytes(request.accessManifestHash, manifestHash)
      || request.entries.length !== envelopeFacts.length
      || request.entries.some((entry, index) => {
        const envelope = envelopeFacts[index]!;
        return entry.namespaceId !== envelope.namespaceId
          || entry.keyGeneration !== envelope.keyGeneration
          || entry.bindingRevisionAtWrap !== envelope.bindingRevisionAtWrap
          || !equalBytes(entry.envelopeHash, envelope.envelopeHash);
      })
      || request.ciphertextLength !== input.prepared.ciphertextLength
      || request.ciphertextLength !== input.blob.ciphertextLength
      || !equalBytes(request.ciphertextSha256, input.blob.ciphertextSha256)
      || request.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES
      || request.chunkCount !== input.blob.chunkCount
      || request.mimeClass !== input.prepared.mimeClass
      || request.sizeBucket !== input.prepared.sizeBucket
      || input.blob.artifactId !== input.prepared.artifactId
      || input.blob.blobId !== input.prepared.resultBlobId
      || input.blob.blobGeneration !== input.prepared.resultBlobGeneration
    ) throw new TypeError("Signed Artifact publication coordinates disagree");
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
      if (
        manifest.signer.kind !== "human_device"
        || manifest.signer.subjectHumanId !== input.expectedHumanId
        || manifest.signer.committerDeviceId !== request.committerDeviceId
        || manifest.hostAuthorizationRevision !== request.hostAuthorizationRevision
        || !input.crypto.verify(publicKey, signingBytes, manifest.signature)
      ) throw new TypeError("Artifact access manifest signature is invalid");
    } finally {
      signingBytes.fill(0);
    }
    const requiredFingerprint = fingerprintRequiredArtifactNamespaces(
      requiredNamespaceIds,
    );
    const allocationRequestDigest = input.crypto.hash(signedBytes);
    const revision: PreparedArtifactCryptoRevision = Object.freeze({
      artifactId: input.prepared.artifactId,
      artifactRevision: input.prepared.nextArtifactRevision,
      blobGeneration: input.prepared.resultBlobGeneration,
      objectId: expectedObjectId,
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      controlVersion: ARTIFACT_CONTROL_VERSION_V1,
      blobId: input.prepared.resultBlobId,
      plaintextLength: input.blob.plaintextLength,
      ciphertextLength: input.blob.ciphertextLength,
      ciphertextSha256: input.blob.ciphertextSha256.slice(),
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
      chunkCount: input.blob.chunkCount,
      requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    });
    const prepared = Object.freeze({
      operationId: input.prepared.operationId,
      artifactId: input.prepared.artifactId,
      artifactRevision: input.prepared.nextArtifactRevision,
    });
    const snapshot: AuthenticatedHumanArtifactPublicationSnapshot = Object.freeze({
      prepared,
      expectedHumanId: input.expectedHumanId,
      authority: Object.freeze({
        ...currentAuthorityContext,
        entries: cloneEntries(currentAuthorityContext.entries),
      }),
      lifecycleAction: input.prepared.lifecycleAction,
      requestDigest: planDigest.slice(),
      allocationRequestDigest: allocationRequestDigest.slice(),
      revision,
      plan: Object.freeze({
        operationId: input.prepared.operationId,
        artifactRowId: input.prepared.artifactRowId,
        anchorNamespaceId: input.prepared.anchorNamespaceId,
        operationType: operation,
        expectedArtifactRevision: input.prepared.expectedArtifactRevision,
        expectedAccessRevision: input.prepared.expectedCryptoAccessRevision,
        expectedBlobGeneration: input.prepared.expectedBlobGeneration,
        expectedBlobId: input.prepared.expectedBlobId,
        expectedRequiredNamespaceFingerprint: operation === "create"
          ? null : requiredFingerprint.slice(),
        revision,
        blob: Object.freeze({
          artifactId: input.blob.artifactId,
          blobId: input.blob.blobId,
          blobGeneration: input.blob.blobGeneration,
          storageRef: artifactBlobStorageRefV1(input.blob.blobId),
          ciphertextLength: input.blob.ciphertextLength,
          ciphertextSha256: input.blob.ciphertextSha256.slice(),
        }),
        mimeClass: input.prepared.mimeClass,
        sizeBucket: input.prepared.sizeBucket,
        requestDigest: planDigest.slice(),
        allocationRequestDigest: allocationRequestDigest.slice(),
        requiredNamespaceFingerprint: requiredFingerprint.slice(),
      }),
      payloadBytes: payloadBytes.slice(),
      payloadHash: payloadHash.slice(),
      manifestBytes: manifestBytes.slice(),
      manifestHash: manifestHash.slice(),
      envelopes: Object.freeze(envelopeFacts.map((entry) => Object.freeze({
        namespaceId: entry.namespaceId,
        envelopeBytes: entry.envelopeBytes.slice(),
        envelopeHash: entry.envelopeHash.slice(),
      }))),
    });
    snapshots.set(prepared, snapshot);
    allocationRequestDigest.fill(0);
    requiredFingerprint.fill(0);
    return prepared;
  } finally {
    payloadBytes?.fill(0);
    manifestBytes?.fill(0);
    signedBytes?.fill(0);
    planDigest?.fill(0);
    publicKey?.fill(0);
    payloadHash?.fill(0);
    manifestHash?.fill(0);
    envelopeFacts.forEach((entry) => {
      entry.envelopeBytes.fill(0);
      entry.envelopeHash.fill(0);
    });
    wipeRequest(request);
    wipeRequest(decodedRequest);
    authorityContext?.entries.forEach((entry) => {
      entry.bindingHash.fill(0);
      entry.envelopeHash.fill(0);
    });
  }
}

export function readAuthenticatedHumanArtifactPublication(
  prepared: AuthenticatedHumanArtifactPublication,
): AuthenticatedHumanArtifactPublicationSnapshot {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) {
    throw new TypeError("Human Artifact publication is not bridge-authenticated");
  }
  return Object.freeze({
    ...snapshot,
    authority: Object.freeze({
      ...snapshot.authority,
      entries: cloneEntries(snapshot.authority.entries),
    }),
    requestDigest: snapshot.requestDigest.slice(),
    allocationRequestDigest: snapshot.allocationRequestDigest.slice(),
    revision: Object.freeze({
      ...snapshot.revision,
      ciphertextSha256: snapshot.revision.ciphertextSha256.slice(),
      requiredNamespaceIds: Object.freeze([...snapshot.revision.requiredNamespaceIds]),
    }),
    plan: Object.freeze({
      ...snapshot.plan,
      requestDigest: snapshot.plan.requestDigest.slice(),
      allocationRequestDigest: snapshot.plan.allocationRequestDigest.slice(),
      requiredNamespaceFingerprint: snapshot.plan.requiredNamespaceFingerprint.slice(),
      expectedRequiredNamespaceFingerprint:
        snapshot.plan.expectedRequiredNamespaceFingerprint?.slice() ?? null,
      revision: Object.freeze({
        ...snapshot.plan.revision,
        ciphertextSha256: snapshot.plan.revision.ciphertextSha256.slice(),
        requiredNamespaceIds: Object.freeze([...snapshot.plan.revision.requiredNamespaceIds]),
      }),
      blob: Object.freeze({
        ...snapshot.plan.blob,
        ciphertextSha256: snapshot.plan.blob.ciphertextSha256.slice(),
      }),
    }),
    payloadBytes: snapshot.payloadBytes.slice(),
    payloadHash: snapshot.payloadHash.slice(),
    manifestBytes: snapshot.manifestBytes.slice(),
    manifestHash: snapshot.manifestHash.slice(),
    envelopes: Object.freeze(snapshot.envelopes.map((entry) => Object.freeze({
      namespaceId: entry.namespaceId,
      envelopeBytes: entry.envelopeBytes.slice(),
      envelopeHash: entry.envelopeHash.slice(),
    }))),
  });
}
