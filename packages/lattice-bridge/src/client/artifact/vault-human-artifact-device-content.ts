import type {
  ProtectedArtifactCiphertextRangeV1,
  ProtectedArtifactAccessPlanResponseV1,
  ProtectedArtifactPreparedAccessRequestV1,
  ProtectedArtifactDtoV1,
  ProtectedArtifactPreparedPublicationRequestV1,
  ProtectedArtifactPublicationPlanResponseV1,
} from "@nautilo/api-client/browser";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  encryptObjectPayload,
  generateArtifactBlobDek,
  fingerprintHumanArtifactAccessInventory,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  openArtifactBlobChunk,
  openObjectDekForNamespace,
  prepareHumanArtifactExactAccessRequest,
  prepareHumanObjectAccessManifestUpdateSet,
  prepareHumanArtifactPublicationRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  sealArtifactBlobChunk,
  unixTimestamp,
  verifyCommonObjectAccessManifestChain,
  wrapObjectDekForNamespace,
  type ArtifactBlobHeader,
  type ArtifactControl,
  type LatticeCrypto,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeArtifactControlV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeArtifactBlobChunkFrameV1,
  encodeArtifactBlobHeaderV1,
  encodeArtifactControlV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  type OpenedClientDeviceProfileV2,
} from "../../client-vault/profile-v2.ts";
import {
  authenticateClientDeviceProfileV3,
  destroyOpenedClientDeviceProfileV3,
} from "../../client-vault/profile-v3.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
  type ClientObjectAccessSignerResolversV4,
  type OpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { ingestObjectAccessSignerEvidenceV4 } from
  "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import { withClientNamespaceKeyring } from "../../device/client-namespace-keyring.ts";
import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  artifactSizeBucketForPlaintextLength,
  deriveArtifactControlObjectIdV1,
} from "../../artifact/artifact-repository.ts";
import type {
  PreparedArtifactCiphertextStagingPort,
  StagedArtifactCiphertextSidecarReference,
} from "./prepared-artifact-ciphertext-sidecar.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

type PlannedArtifactPublication = Extract<
  ProtectedArtifactPublicationPlanResponseV1,
  { status: "planned" }
>;

export type AuthorizedHumanArtifactContentIntentV1 = Readonly<{
  logicalPath: string;
  mimeType: string;
  plaintextLength: number;
  plaintext: AsyncIterable<Uint8Array>;
}>;

export type PreparedHumanArtifactContentPublicationV1 = Readonly<{
  prepared: ProtectedArtifactPreparedPublicationRequestV1;
  stagedCiphertext: StagedArtifactCiphertextSidecarReference;
}>;

export interface VaultHumanArtifactDeviceContentInput {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly subjectHumanId: string;
  readonly now: () => number;
  readonly createProfileStageId: () => string;
  readonly ciphertextStaging: PreparedArtifactCiphertextStagingPort;
  readonly resolveTrustedDeviceSigningPublicKey: (input: Readonly<{
    deviceId: string;
    hostAuthorizationRevision: number;
    trustedDeviceRevision: number;
  }>) => Promise<Uint8Array | null>;
  readonly accessAnchors: HumanArtifactObjectAccessAnchorPort;
}

export interface HumanArtifactObjectAccessAnchorPort {
  load(objectId: string): Promise<TrustedMinimumObjectAccessHead | null>;
  advance(input: Readonly<{
    expected: TrustedMinimumObjectAccessHead | null;
    next: TrustedMinimumObjectAccessHead;
  }>): Promise<boolean>;
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipeControl(control: ArtifactControl): void {
  control.blobDek.fill(0);
  control.plaintextSha256.fill(0);
  control.ciphertextSha256.fill(0);
}

function exactEncryptedAccess(dto: ProtectedArtifactDtoV1): Readonly<{
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  proofBytes: readonly Uint8Array[];
  envelopes: readonly Readonly<{ namespaceId: string; bytes: Uint8Array }>[];
}> {
  return Object.freeze({
    payloadBytes: fromBase64url(
      "Protected Artifact control payload",
      dto.encryptedControlPayloadBytesBase64url,
    ),
    manifestBytes: fromBase64url(
      "Protected Artifact access manifest",
      dto.accessManifestBytesBase64url,
    ),
    proofBytes: Object.freeze(dto.accessManifestProofBytesBase64url.map(
      (value) => fromBase64url("Protected Artifact access proof", value),
    )),
    envelopes: Object.freeze(dto.namespaceEnvelopes.map((entry) => Object.freeze({
      namespaceId: entry.namespaceId,
      bytes: fromBase64url("Protected Artifact Namespace envelope", entry.envelopeBytesBase64url),
    }))),
  });
}

function wipeEncryptedAccess(value: ReturnType<typeof exactEncryptedAccess>): void {
  value.payloadBytes.fill(0);
  value.manifestBytes.fill(0);
  value.proofBytes.forEach((bytes) => bytes.fill(0));
  value.envelopes.forEach(({ bytes }) => bytes.fill(0));
}

async function withProfile<Value>(
  input: VaultHumanArtifactDeviceContentInput,
  operation: (
    profile: OpenedClientDeviceProfileV2,
    profileV4: OpenedClientDeviceProfileV4 | null,
  ) => Promise<Value>,
): Promise<Value> {
  return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
    let destroy: (() => void) | undefined;
    let profile: OpenedClientDeviceProfileV2;
    let profileV4: OpenedClientDeviceProfileV4 | null = null;
    try {
      try {
        const opened = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        profileV4 = opened;
        profile = opened.baseProfile.baseProfile;
        destroy = () => destroyOpenedClientDeviceProfileV4(opened);
      } catch {
        try {
        const opened = await authenticateClientDeviceProfile({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        if (opened.formatVersion !== 2) {
          destroyOpenedClientDeviceProfile(opened);
          throw new Error("Protected Human Artifact key delivery is unavailable");
        }
        profile = opened;
        destroy = () => destroyOpenedClientDeviceProfile(opened);
        } catch (error) {
        if (
          error instanceof Error
          && error.message === "Protected Human Artifact key delivery is unavailable"
        ) throw error;
        const opened = await authenticateClientDeviceProfileV3({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        profile = opened.baseProfile;
        destroy = () => destroyOpenedClientDeviceProfileV3(opened);
        }
      }
      return await operation(profile, profileV4);
    } finally {
      destroy?.();
    }
  });
}

async function authenticateAndOpenControl(input: Readonly<{
  dependencies: VaultHumanArtifactDeviceContentInput;
  profile: OpenedClientDeviceProfileV2;
  profileV4: OpenedClientDeviceProfileV4 | null;
  dto: ProtectedArtifactDtoV1;
  retained: TrustedMinimumObjectAccessHead | null;
}>): Promise<Readonly<{
  control: ArtifactControl;
  nextAnchor: TrustedMinimumObjectAccessHead;
  currentManifestBytes: Uint8Array;
  verifiedProofBytes: readonly Uint8Array[];
  currentEnvelopes: readonly Readonly<{ namespaceId: string; bytes: Uint8Array }>[];
}>> {
  const exact = exactEncryptedAccess(input.dto);
  let canonicalPayload: Uint8Array | undefined;
  let canonicalManifest: Uint8Array | undefined;
  let controlBytes: Uint8Array | undefined;
  let control: ArtifactControl | undefined;
  try {
    const payload = decodeEncryptedPayloadV2(exact.payloadBytes);
    const manifest = decodeObjectAccessManifestV5(exact.manifestBytes);
    canonicalPayload = encodeEncryptedPayloadV2(payload);
    canonicalManifest = encodeObjectAccessManifestV5(manifest);
    if (
      !equalBytes(canonicalPayload, exact.payloadBytes)
      || !equalBytes(canonicalManifest, exact.manifestBytes)
      || payload.context.objectId !== manifest.objectId
      || payload.context.objectId !== input.dto.cryptoObjectId
      || payload.context.keyClass !== "ai"
      || payload.context.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
      || manifest.accessRevision !== input.dto.cryptoAccessRevision
      || !equalBytes(
        manifest.payloadHash,
        input.dependencies.crypto.hash(exact.payloadBytes),
      )
      || input.dto.cryptoObjectId !== deriveArtifactControlObjectIdV1({
        artifactId: input.dto.artifactId,
        artifactRevision: input.dto.artifactRevision,
      })
    ) throw new Error("Protected Artifact control coordinates disagree");

    const proof = [...exact.proofBytes];
    let anchor: TrustedMinimumObjectAccessHead;
    if (input.retained === null) {
      const genesisBytes = manifest.accessRevision === 0
        ? exact.manifestBytes
        : proof.shift();
      if (genesisBytes === undefined) {
        throw new Error("Protected Artifact genesis proof is incomplete");
      }
      const genesis = decodeObjectAccessManifestV5(genesisBytes);
      if (
        genesis.accessRevision !== 0
        || genesis.previousManifestHash !== null
        || genesis.objectId !== manifest.objectId
        || !equalBytes(genesis.payloadHash, manifest.payloadHash)
      ) throw new Error("Protected Artifact genesis proof is invalid");
      anchor = Object.freeze({
        objectId: objectId(genesis.objectId),
        payloadHash: genesis.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: input.dependencies.crypto.hash(genesisBytes),
      });
    } else {
      anchor = input.retained;
      if (manifest.accessRevision < anchor.accessRevision) {
        throw new Error("Protected Artifact access head rolled back");
      }
      if (manifest.accessRevision > anchor.accessRevision) {
        const index = proof.findIndex((bytes) => {
          const candidate = decodeObjectAccessManifestV5(bytes);
          return candidate.accessRevision === anchor.accessRevision
            && equalBytes(input.dependencies.crypto.hash(bytes), anchor.manifestHash);
        });
        if (index < 0) {
          throw new Error("Protected Artifact proof omits its retained anchor");
        }
        proof.splice(0, index + 1);
      } else {
        if (!equalBytes(
          input.dependencies.crypto.hash(exact.manifestBytes),
          anchor.manifestHash,
        )) throw new Error("Protected Artifact retained head was substituted");
        proof.length = 0;
      }
    }

    const publicKeys = new Map<string, Uint8Array>();
    try {
      for (const bytes of [...proof, exact.manifestBytes]) {
        const entry = decodeObjectAccessManifestV5(bytes);
        if (
          entry.signer.kind === "human_device"
          && !publicKeys.has(entry.signer.committerDeviceId)
        ) {
          const key = await input.dependencies.resolveTrustedDeviceSigningPublicKey({
            deviceId: entry.signer.committerDeviceId,
            hostAuthorizationRevision: entry.hostAuthorizationRevision,
            trustedDeviceRevision: input.profile.trustedDeviceRevision,
          });
          if (key === null) throw new Error("Protected Artifact signer is unavailable");
          publicKeys.set(entry.signer.committerDeviceId, key);
        }
      }
      const verify = (resolvers: ClientObjectAccessSignerResolversV4) =>
        verifyCommonObjectAccessManifestChain(input.dependencies.crypto, {
          manifestBytes: exact.manifestBytes,
          proof,
          trustedMinimumHead: anchor,
          resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
            publicKeys.get(context.committerDeviceId) ?? null,
          resolveAgentRuntimeSignerPublicKey:
            resolvers.resolveAgentRuntimeSignerPublicKey,
          resolveProcessorSignerAuthorizationBytes:
            resolvers.resolveProcessorSignerAuthorizationBytes,
          resolveHistoricalProcessorIssuingDevicePublicKey:
            resolvers.resolveHistoricalProcessorIssuingDevicePublicKey,
        });
      const emptyResolvers: ClientObjectAccessSignerResolversV4 = Object.freeze({
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      });
      const verified = input.profileV4 === null
        ? verify(emptyResolvers)
        : withClientObjectAccessSignerResolversV4({
          crypto: input.dependencies.crypto,
          profile: input.profileV4,
          operation: verify,
        });
      for (const entry of exact.envelopes) {
        const envelope = decodeNamespaceObjectEnvelopeV2(entry.bytes);
        if (
          envelope.context.objectId !== payload.context.objectId
          || envelope.context.namespaceId !== entry.namespaceId
          || envelope.context.keyClass !== "ai"
        ) throw new Error("Protected Artifact envelope coordinates disagree");
        const hash = input.dependencies.crypto.hash(entry.bytes);
        const authorized = verified.manifest.envelopeHashes.some((candidate) =>
          equalBytes(candidate, hash)
        );
        hash.fill(0);
        if (!authorized) throw new Error(
          "Protected Artifact envelope is outside the manifest inventory",
        );
      }
    } finally {
      publicKeys.forEach((key) => key.fill(0));
    }

    for (const entry of exact.envelopes) {
      const envelope = decodeNamespaceObjectEnvelopeV2(entry.bytes);
      try {
        controlBytes = await withClientNamespaceKeyring({
          profile: input.profile,
          namespaceId: entry.namespaceId,
          keyClass: "ai",
          requiredAccessRevision: envelope.context.bindingRevisionAtWrap,
          requiredGeneration: envelope.context.keyGeneration,
          operation: (keyring) => {
            const generation = keyring.generations.find((candidate) =>
              candidate.generation === envelope.context.keyGeneration
            );
            if (generation === undefined) return null;
            return decryptObjectThroughNamespace(
              input.dependencies.crypto,
              generation.key,
              envelope,
              payload,
            );
          },
        }) ?? undefined;
      } catch (error) {
        if (!(error instanceof Error) || !/unavailable/u.test(error.message)) {
          throw error;
        }
      }
      if (controlBytes !== undefined) break;
    }
    if (controlBytes === undefined) {
      throw new Error("Protected Artifact has no readable exact envelope");
    }
    control = decodeArtifactControlV1(controlBytes);
    const dtoCiphertextHash = fromBase64url(
      "Protected Artifact ciphertext hash",
      input.dto.ciphertextSha256Base64url,
    );
    try {
      if (
        control.artifactId !== input.dto.artifactId
        || control.artifactRevision !== input.dto.artifactRevision
        || control.blobId !== input.dto.blobId
        || control.blobGeneration !== input.dto.blobGeneration
        || control.ciphertextLength !== input.dto.ciphertextLength
        || !equalBytes(control.ciphertextSha256, dtoCiphertextHash)
        || control.chunkPlaintextBytes !== input.dto.chunkPlaintextBytes
        || control.chunkCount !== input.dto.chunkCount
        || artifactSizeBucketForPlaintextLength(control.plaintextLength)
          !== input.dto.sizeBucket
      ) throw new Error("Protected Artifact confidential control was substituted");
    } finally {
      dtoCiphertextHash.fill(0);
    }
    return Object.freeze({
      control,
      currentManifestBytes: exact.manifestBytes.slice(),
      verifiedProofBytes: Object.freeze(proof.map((bytes) => bytes.slice())),
      currentEnvelopes: Object.freeze(exact.envelopes.map((entry) =>
        Object.freeze({ namespaceId: entry.namespaceId, bytes: entry.bytes.slice() })
      )),
      nextAnchor: Object.freeze({
        objectId: objectId(manifest.objectId),
        payloadHash: manifest.payloadHash,
        accessRevision: accessRevision(manifest.accessRevision),
        manifestHash: input.dependencies.crypto.hash(exact.manifestBytes),
      }),
    });
  } catch (error) {
    if (control !== undefined) wipeControl(control);
    throw error;
  } finally {
    canonicalPayload?.fill(0);
    canonicalManifest?.fill(0);
    controlBytes?.fill(0);
    wipeEncryptedAccess(exact);
  }
}

function exactPlan(plan: PlannedArtifactPublication): PlannedArtifactPublication {
  if (
    plan.requiredNamespaceIds.length < 1
    || plan.requiredNamespaceIds.length !== plan.bindings.length
    || plan.requiredNamespaceIds.some((id, index) =>
      id !== plan.bindings[index]!.namespaceId
      || (index > 0 && plan.requiredNamespaceIds[index - 1]! >= id)
    )
    || plan.nextArtifactRevision !== plan.expectedArtifactRevision + 1
    || plan.resultCryptoAccessRevision !== 0
    || !Number.isSafeInteger(plan.deadlineAt)
  ) throw new TypeError("Protected Artifact publication plan is inexact");
  if (
    (plan.operation === "create" && (
      plan.expectedArtifactRevision !== 0
      || plan.expectedBlobGeneration !== 0
      || plan.expectedBlobId !== null
      || plan.resultBlobGeneration !== 1
    ))
    || (plan.operation === "replace_content" && (
      plan.expectedArtifactRevision < 1
      || plan.expectedBlobId === null
      || plan.resultBlobGeneration !== plan.expectedBlobGeneration + 1
      || plan.resultBlobId === plan.expectedBlobId
    ))
    || (plan.operation === "revise_control" && (
      plan.expectedArtifactRevision < 1
      || plan.expectedBlobId === null
      || plan.resultBlobGeneration !== plan.expectedBlobGeneration
      || plan.resultBlobId !== plan.expectedBlobId
    ))
  ) throw new TypeError("Artifact content plan coordinates are invalid");
  return plan;
}

function accessBindings(
  bindings: readonly Readonly<{
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    bindingHashBase64url: string;
  }>[],
) {
  return Object.freeze(bindings.map((binding) => Object.freeze({
    namespaceId: binding.namespaceId,
    domainId: binding.domainId,
    expectedAccessRevision: binding.expectedAccessRevision,
    expectedPolicyRevision: binding.expectedPolicyRevision,
    bindingHash: fromBase64url(
      "Protected Artifact access binding hash",
      binding.bindingHashBase64url,
    ),
  })));
}

async function* encryptedBlobStream(input: Readonly<{
  crypto: LatticeCrypto;
  header: ArtifactBlobHeader;
  blobDek: Uint8Array;
  plaintext: AsyncIterable<Uint8Array>;
  plaintextHash: ReturnType<typeof sha256.create>;
}>): AsyncGenerator<Uint8Array> {
  const headerBytes = encodeArtifactBlobHeaderV1(input.header);
  yield headerBytes;
  const buffer = new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES);
  let buffered = 0;
  let observed = 0;
  let chunkIndex = 0;
  const seal = (chunk: Uint8Array) => {
    const sealed = sealArtifactBlobChunk(input.crypto, {
      header: input.header,
      blobDek: input.blobDek,
      chunkIndex,
      plaintextChunk: chunk,
    });
    try {
      return encodeArtifactBlobChunkFrameV1(sealed);
    } finally {
      sealed.fill(0);
      chunkIndex += 1;
    }
  };
  try {
    for await (const source of input.plaintext) {
      if (!(source instanceof Uint8Array) || source.length < 1) {
        throw new TypeError("Artifact plaintext stream yielded invalid bytes");
      }
      if (observed + source.length > input.header.plaintextLength) {
        throw new RangeError("Artifact plaintext stream exceeded its declared length");
      }
      input.plaintextHash.update(source);
      observed += source.length;
      let offset = 0;
      while (offset < source.length) {
        const count = Math.min(buffer.length - buffered, source.length - offset);
        buffer.set(source.subarray(offset, offset + count), buffered);
        buffered += count;
        offset += count;
        if (buffered === buffer.length) {
          const frame = seal(buffer);
          yield frame;
          frame.fill(0);
          buffer.fill(0);
          buffered = 0;
        }
      }
    }
    if (observed !== input.header.plaintextLength) {
      throw new RangeError("Artifact plaintext stream ended before its declared length");
    }
    if (buffered > 0 || input.header.plaintextLength === 0) {
      const frame = seal(buffer.subarray(0, buffered));
      yield frame;
      frame.fill(0);
    }
    if (chunkIndex !== input.header.chunkCount) {
      throw new Error("Artifact plaintext stream produced an inexact chunk count");
    }
  } finally {
    headerBytes.fill(0);
    buffer.fill(0);
  }
}

async function prepareEncryptedControl(input: Readonly<{
  dependencies: VaultHumanArtifactDeviceContentInput;
  profile: OpenedClientDeviceProfileV2;
  plan: PlannedArtifactPublication;
  now: number;
  controlBytes: Uint8Array;
  ciphertextLength: number;
  ciphertextSha256Base64url: string;
  chunkCount: number;
}>): Promise<ProtectedArtifactPreparedPublicationRequestV1> {
  const { dependencies, plan, profile } = input;
  const cryptoObjectId = deriveArtifactControlObjectIdV1({
    artifactId: plan.artifactId,
    artifactRevision: plan.nextArtifactRevision,
  });
  let controlDek: Uint8Array | undefined;
  let payloadBytes: Uint8Array | undefined;
  let manifestBytes: Uint8Array | undefined;
  let signedBytes: Uint8Array | undefined;
  let planDigest: Uint8Array | undefined;
  let ciphertextDigest: Uint8Array | undefined;
  const envelopeBytes: Uint8Array[] = [];
  const bindingHashes: Uint8Array[] = [];
  const envelopeHashes: Uint8Array[] = [];
  try {
    const encrypted = encryptObjectPayload(dependencies.crypto, {
      objectId: objectId(cryptoObjectId),
      keyClass: "ai",
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      createdAt: unixTimestamp(input.now),
    }, input.controlBytes);
    controlDek = encrypted.dek;
    payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const requestEntries: Array<{
      namespaceId: ReturnType<typeof namespaceId>;
      domainId: ReturnType<typeof cryptoDomainId>;
      expectedNamespaceAccessRevision: number;
      expectedPolicyRevision: number;
      bindingHash: Uint8Array;
      keyGeneration: number;
      bindingRevisionAtWrap: number;
      envelopeHash: Uint8Array;
    }> = [];
    for (const [index, targetNamespaceId] of plan.requiredNamespaceIds.entries()) {
      const binding = plan.bindings[index]!;
      const bindingHash = fromBase64url(
        "Artifact Namespace binding hash",
        binding.bindingHashBase64url,
      );
      bindingHashes.push(bindingHash);
      const prepared = await withClientNamespaceKeyring({
        profile,
        namespaceId: targetNamespaceId,
        keyClass: "ai",
        requiredAccessRevision: binding.expectedAccessRevision,
        operation: (keyring) => {
          if (
            keyring.domainId !== binding.domainId
            || keyring.accessRevision !== binding.expectedAccessRevision
            || !equalBytes(keyring.bindingHash, bindingHash)
          ) throw new Error("Current Artifact Namespace binding disagrees with plan");
          const generation = keyring.generations.find((entry) =>
            entry.generation === keyring.currentGeneration
          );
          if (generation === undefined) {
            throw new Error("Current Human Namespace key is unavailable");
          }
          const bytes = encodeNamespaceObjectEnvelopeV2(
            wrapObjectDekForNamespace(dependencies.crypto, generation.key, {
              objectId: objectId(cryptoObjectId),
              namespaceId: namespaceId(targetNamespaceId),
              keyClass: "ai",
              keyGeneration: namespaceGeneration(keyring.currentGeneration),
              bindingRevisionAtWrap: accessRevision(keyring.accessRevision),
            }, controlDek!),
          );
          return Object.freeze({
            bytes,
            domainId: keyring.domainId,
            keyGeneration: keyring.currentGeneration,
            bindingRevisionAtWrap: keyring.accessRevision,
          });
        },
      });
      envelopeBytes.push(prepared.bytes);
      const envelopeHash = dependencies.crypto.hash(prepared.bytes);
      envelopeHashes.push(envelopeHash);
      requestEntries.push({
        namespaceId: namespaceId(targetNamespaceId),
        domainId: cryptoDomainId(prepared.domainId),
        expectedNamespaceAccessRevision: binding.expectedAccessRevision,
        expectedPolicyRevision: binding.expectedPolicyRevision,
        bindingHash,
        keyGeneration: prepared.keyGeneration,
        bindingRevisionAtWrap: prepared.bindingRevisionAtWrap,
        envelopeHash,
      });
    }
    const access = prepareHumanObjectAccessManifestGenesisSet(dependencies.crypto, {
      objectId: objectId(cryptoObjectId),
      payloadHash: dependencies.crypto.hash(payloadBytes),
      envelopeBytes,
      sourceAuthorized: true,
      targetAuthorized: true,
      subjectHumanId: humanId(dependencies.subjectHumanId),
      committerDeviceId: cryptoDeviceId(profile.deviceId),
      hostAuthorizationRevision: authorizationRevision(
        profile.trustedHostAuthorizationRevision,
      ),
      committerSigningPublicKey: profile.signingPublicKey,
      committerSigningPrivateKey: profile.signingPrivateKey,
    });
    manifestBytes = access.manifestBytes;
    planDigest = fromBase64url("Artifact plan digest", plan.planDigestBase64url);
    ciphertextDigest = fromBase64url(
      "Artifact ciphertext hash",
      input.ciphertextSha256Base64url,
    );
    signedBytes = prepareHumanArtifactPublicationRequest(dependencies.crypto, {
      operation: plan.operation,
      lifecycleAction: plan.lifecycleAction,
      subjectHumanId: humanId(dependencies.subjectHumanId),
      operationId: plan.operationId,
      planDigest,
      artifactRowId: plan.artifactRowId,
      artifactId: plan.artifactId,
      anchorNamespaceId: namespaceId(plan.anchorNamespaceId),
      cryptoObjectId: objectId(cryptoObjectId),
      expectedArtifactRevision: plan.expectedArtifactRevision,
      nextArtifactRevision: plan.nextArtifactRevision,
      expectedAccessRevision: plan.expectedCryptoAccessRevision,
      resultAccessRevision: 0,
      expectedBlobGeneration: plan.expectedBlobGeneration,
      resultBlobGeneration: plan.resultBlobGeneration,
      expectedBlobId: plan.expectedBlobId,
      resultBlobId: plan.resultBlobId,
      controlPayloadHash: dependencies.crypto.hash(payloadBytes),
      accessManifestHash: dependencies.crypto.hash(manifestBytes),
      entries: requestEntries,
      ciphertextLength: input.ciphertextLength,
      ciphertextSha256: ciphertextDigest,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
      chunkCount: input.chunkCount,
      mimeClass: plan.mimeClass,
      sizeBucket: plan.sizeBucket,
      issuedAt: unixTimestamp(input.now),
      deadlineAt: unixTimestamp(plan.deadlineAt),
      committerDeviceId: cryptoDeviceId(profile.deviceId),
      hostAuthorizationRevision: authorizationRevision(
        profile.trustedHostAuthorizationRevision,
      ),
      committerSigningPublicKey: profile.signingPublicKey,
      committerSigningPrivateKey: profile.signingPrivateKey,
    }).bytes;
    return Object.freeze({
      requestVersion: 1,
      operationId: plan.operationId,
      planDigestBase64url: plan.planDigestBase64url,
      operation: plan.operation,
      lifecycleAction: plan.lifecycleAction,
      artifactRowId: plan.artifactRowId,
      artifactId: plan.artifactId,
      anchorNamespaceId: plan.anchorNamespaceId,
      cryptoObjectId,
      expectedArtifactRevision: plan.expectedArtifactRevision,
      nextArtifactRevision: plan.nextArtifactRevision,
      expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
      resultCryptoAccessRevision: 0,
      expectedBlobGeneration: plan.expectedBlobGeneration,
      resultBlobGeneration: plan.resultBlobGeneration,
      expectedBlobId: plan.expectedBlobId,
      resultBlobId: plan.resultBlobId,
      requiredNamespaceIds: [...plan.requiredNamespaceIds],
      encryptedControlPayloadBytesBase64url: toBase64url(payloadBytes),
      accessManifestBytesBase64url: toBase64url(manifestBytes),
      namespaceEnvelopes: plan.requiredNamespaceIds.map((id, index) => ({
        namespaceId: id,
        envelopeBytesBase64url: toBase64url(envelopeBytes[index]!),
      })),
      signedPublicationRequestBytesBase64url: toBase64url(signedBytes),
      ciphertextLength: input.ciphertextLength,
      ciphertextSha256Base64url: input.ciphertextSha256Base64url,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
      chunkCount: input.chunkCount,
      mimeClass: plan.mimeClass,
      sizeBucket: plan.sizeBucket,
    });
  } finally {
    controlDek?.fill(0);
    payloadBytes?.fill(0);
    manifestBytes?.fill(0);
    signedBytes?.fill(0);
    planDigest?.fill(0);
    ciphertextDigest?.fill(0);
    envelopeBytes.forEach((bytes) => bytes.fill(0));
    bindingHashes.forEach((bytes) => bytes.fill(0));
    envelopeHashes.forEach((bytes) => bytes.fill(0));
  }
}

/**
 * Device-local Artifact content preparation. The plaintext source is consumed
 * exactly once into the durable ciphertext sidecar before the signed request
 * is returned. No plaintext, blob DEK, or control DEK crosses this boundary.
 */
export function createVaultHumanArtifactDeviceContentPort(
  dependencies: VaultHumanArtifactDeviceContentInput,
) {
  const retainSignerEvidence = (dto: ProtectedArtifactDtoV1) =>
    ingestObjectAccessSignerEvidenceV4({
      crypto: dependencies.crypto,
      vault: dependencies.vault,
      coordinates: dependencies.coordinates,
      evidence: dto.accessSignerEvidence,
      resolveTrustedIssuingDevicePublicKey:
        dependencies.resolveTrustedDeviceSigningPublicKey,
      createStageId: dependencies.createProfileStageId,
    });
  return Object.freeze({
    async withOpenedControl<Value>(input: Readonly<{
      dto: ProtectedArtifactDtoV1;
      consume(control: ArtifactControl): Value | PromiseLike<Value>;
    }>): Promise<Value> {
      await retainSignerEvidence(input.dto);
      const retained = await dependencies.accessAnchors.load(
        input.dto.cryptoObjectId,
      );
      const opened = await withProfile(dependencies, (profile, profileV4) =>
        authenticateAndOpenControl({
          dependencies,
          profile,
          profileV4,
          dto: input.dto,
          retained,
        })
      );
      if (!await dependencies.accessAnchors.advance({
        expected: retained,
        next: opened.nextAnchor,
      })) {
        wipeControl(opened.control);
        opened.currentManifestBytes.fill(0);
        opened.verifiedProofBytes.forEach((bytes) => bytes.fill(0));
        opened.currentEnvelopes.forEach(({ bytes }) => bytes.fill(0));
        throw new Error("Protected Artifact rollback anchor changed concurrently");
      }
      try {
        return await input.consume(opened.control);
      } finally {
        wipeControl(opened.control);
        opened.currentManifestBytes.fill(0);
        opened.verifiedProofBytes.forEach((bytes) => bytes.fill(0));
        opened.currentEnvelopes.forEach(({ bytes }) => bytes.fill(0));
      }
    },
    async withOpenedRange<Value>(input: Readonly<{
      dto: ProtectedArtifactDtoV1;
      range: ProtectedArtifactCiphertextRangeV1;
      start: number;
      endExclusive: number;
      consume(plaintext: Uint8Array, control: ArtifactControl): Value | PromiseLike<Value>;
    }>): Promise<Value> {
      try {
        return await this.withOpenedControl({
          dto: input.dto,
          consume: async (control) => {
            const ciphertextHash = fromBase64url(
              "Protected Artifact range ciphertext hash",
              input.range.ciphertextSha256Base64url,
            );
            try {
              if (
                input.range.status !== "encrypted_chunks"
                || input.range.artifactId !== input.dto.artifactId
                || input.range.artifactRevision !== input.dto.artifactRevision
                || input.range.cryptoAccessRevision !== input.dto.cryptoAccessRevision
                || input.range.blobId !== control.blobId
                || input.range.blobGeneration !== control.blobGeneration
                || input.range.plaintextLength !== control.plaintextLength
                || input.range.ciphertextLength !== control.ciphertextLength
                || !equalBytes(ciphertextHash, control.ciphertextSha256)
                || input.range.chunkPlaintextBytes !== control.chunkPlaintextBytes
                || input.range.chunkCount !== control.chunkCount
                || !Number.isSafeInteger(input.start)
                || !Number.isSafeInteger(input.endExclusive)
                || input.start < 0
                || input.endExclusive < input.start
                || input.endExclusive > control.plaintextLength
                || input.endExclusive - input.start > ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES
              ) throw new Error("Protected Artifact encrypted range was substituted");
              const expectedFirst = Math.floor(
                input.start / ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
              );
              const expectedReturned = input.start === input.endExclusive
                ? 0
                : Math.floor(
                  (input.endExclusive - 1) / ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
                ) - expectedFirst + 1;
              if (
                input.range.firstChunkIndex !== expectedFirst
                || input.range.returnedChunkCount !== expectedReturned
              ) throw new Error("Protected Artifact encrypted chunk window is inexact");
              const header: ArtifactBlobHeader = Object.freeze({
                formatVersion: 1,
                artifactId: control.artifactId,
                blobId: control.blobId,
                blobGeneration: control.blobGeneration,
                plaintextLength: control.plaintextLength,
                chunkPlaintextBytes: control.chunkPlaintextBytes,
                chunkCount: control.chunkCount,
              });
              const output = new Uint8Array(input.endExclusive - input.start);
              let frameOffset = 0;
              try {
                for (let index = 0; index < expectedReturned; index += 1) {
                  if (frameOffset + 4 > input.range.body.length) {
                    throw new Error("Protected Artifact encrypted frame is truncated");
                  }
                  const sealedLength = new DataView(
                    input.range.body.buffer,
                    input.range.body.byteOffset + frameOffset,
                    4,
                  ).getUint32(0, false);
                  frameOffset += 4;
                  if (frameOffset + sealedLength > input.range.body.length) {
                    throw new Error("Protected Artifact encrypted chunk is truncated");
                  }
                  const chunkIndex = expectedFirst + index;
                  const plaintextChunk = openArtifactBlobChunk(dependencies.crypto, {
                    header,
                    blobDek: control.blobDek,
                    chunkIndex,
                    sealedChunk: input.range.body.subarray(
                      frameOffset,
                      frameOffset + sealedLength,
                    ),
                  });
                  frameOffset += sealedLength;
                  try {
                    const chunkStart = chunkIndex * ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES;
                    const copyStart = Math.max(input.start, chunkStart);
                    const copyEnd = Math.min(
                      input.endExclusive,
                      chunkStart + plaintextChunk.length,
                    );
                    output.set(
                      plaintextChunk.subarray(
                        copyStart - chunkStart,
                        copyEnd - chunkStart,
                      ),
                      copyStart - input.start,
                    );
                  } finally {
                    plaintextChunk.fill(0);
                  }
                }
                if (frameOffset !== input.range.body.length) {
                  throw new Error("Protected Artifact encrypted range has trailing bytes");
                }
                return await input.consume(output, control);
              } finally {
                output.fill(0);
              }
            } finally {
              ciphertextHash.fill(0);
            }
          },
        });
      } finally {
        input.range.body.fill(0);
      }
    },
    async prepareControl(input: Readonly<{
      current: ProtectedArtifactDtoV1;
      plan: PlannedArtifactPublication;
      logicalPath?: string;
      mimeType?: string;
    }>): Promise<ProtectedArtifactPreparedPublicationRequestV1> {
      const plan = exactPlan(input.plan);
      const now = dependencies.now();
      if (
        plan.operation !== "revise_control"
        || !Number.isSafeInteger(now)
        || now < 0
        || plan.deadlineAt <= now
        || plan.artifactId !== input.current.artifactId
        || plan.expectedArtifactRevision !== input.current.artifactRevision
        || plan.expectedCryptoAccessRevision !== input.current.cryptoAccessRevision
        || plan.expectedBlobId !== input.current.blobId
        || plan.expectedBlobGeneration !== input.current.blobGeneration
        || plan.requiredNamespaceIds.length !== input.current.requiredNamespaceIds.length
        || plan.requiredNamespaceIds.some((id, index) =>
          id !== input.current.requiredNamespaceIds[index]
        )
      ) throw new Error("Artifact control plan disagrees with current product state");
      return this.withOpenedControl({
        dto: input.current,
        consume: (current) => withProfile(dependencies, async (profile) => {
          const controlBytes = encodeArtifactControlV1({
            formatVersion: 1,
            artifactId: current.artifactId,
            artifactRevision: plan.nextArtifactRevision,
            blobGeneration: current.blobGeneration,
            blobDek: current.blobDek,
            logicalPath: input.logicalPath ?? current.logicalPath,
            mimeType: input.mimeType ?? current.mimeType,
            plaintextLength: current.plaintextLength,
            plaintextSha256: current.plaintextSha256,
            blobId: current.blobId,
            ciphertextLength: current.ciphertextLength,
            ciphertextSha256: current.ciphertextSha256,
            chunkPlaintextBytes: current.chunkPlaintextBytes,
            chunkCount: current.chunkCount,
          });
          try {
            return await prepareEncryptedControl({
              dependencies,
              profile,
              plan,
              now,
              controlBytes,
              ciphertextLength: current.ciphertextLength,
              ciphertextSha256Base64url: toBase64url(current.ciphertextSha256),
              chunkCount: current.chunkCount,
            });
          } finally {
            controlBytes.fill(0);
          }
        }),
      });
    },
    async prepareAccess(input: Readonly<{
      current: ProtectedArtifactDtoV1;
      plan: Extract<ProtectedArtifactAccessPlanResponseV1, { status: "planned" }>;
    }>): Promise<Readonly<{
      request: ProtectedArtifactPreparedAccessRequestV1;
    }>> {
      await retainSignerEvidence(input.current);
      const plan = input.plan;
      if (
        plan.artifactId !== input.current.artifactId
        || plan.artifactRevision !== input.current.artifactRevision
        || plan.cryptoObjectId !== input.current.cryptoObjectId
        || plan.blobId !== input.current.blobId
        || plan.blobGeneration !== input.current.blobGeneration
        || plan.expectedCryptoAccessRevision !== input.current.cryptoAccessRevision
        || plan.nextCryptoAccessRevision !== plan.expectedCryptoAccessRevision + 1
        || plan.currentNamespaceIds.length !== input.current.requiredNamespaceIds.length
        || plan.currentNamespaceIds.some((id, index) =>
          id !== input.current.requiredNamespaceIds[index]
        )
      ) throw new Error("Protected Artifact access plan disagrees with current state");
      const retained = await dependencies.accessAnchors.load(plan.cryptoObjectId);
      const result = await withProfile(dependencies, async (profile, profileV4) => {
        const opened = await authenticateAndOpenControl({
          dependencies,
          profile,
          profileV4,
          dto: input.current,
          retained,
        });
        const currentBindings = accessBindings(plan.currentBindings);
        const targetBindings = accessBindings(plan.targetBindings);
        const currentByNamespace = new Map(opened.currentEnvelopes.map((entry) =>
          [entry.namespaceId, entry.bytes] as const
        ));
        const added = new Set(plan.addedNamespaceIds);
        const targetEnvelopeBytes: Uint8Array[] = [];
        const publicKeys = new Map<string, Uint8Array>();
        let controlDek: Uint8Array | undefined;
        let currentInventoryHash: Uint8Array | undefined;
        let targetInventoryHash: Uint8Array | undefined;
        try {
          if (added.size > 0) {
            for (const entry of opened.currentEnvelopes) {
              const envelope = decodeNamespaceObjectEnvelopeV2(entry.bytes);
              try {
                controlDek = await withClientNamespaceKeyring({
                  profile,
                  namespaceId: entry.namespaceId,
                  keyClass: "ai",
                  requiredAccessRevision: envelope.context.bindingRevisionAtWrap,
                  requiredGeneration: envelope.context.keyGeneration,
                  operation: (keyring) => {
                    const generation = keyring.generations.find((candidate) =>
                      candidate.generation === envelope.context.keyGeneration
                    );
                    return generation === undefined ? null : openObjectDekForNamespace(
                      dependencies.crypto,
                      generation.key,
                      envelope,
                    );
                  },
                }) ?? undefined;
              } catch (error) {
                if (!(error instanceof Error) || !/unavailable/u.test(error.message)) {
                  throw error;
                }
              }
              if (controlDek !== undefined) break;
            }
            if (controlDek === undefined) {
              throw new Error("Protected Artifact control DEK is unavailable");
            }
          }
          for (const binding of targetBindings) {
            const retainedEnvelope = currentByNamespace.get(binding.namespaceId);
            if (retainedEnvelope !== undefined) {
              targetEnvelopeBytes.push(retainedEnvelope.slice());
              continue;
            }
            if (!added.has(binding.namespaceId) || controlDek === undefined) {
              throw new Error("Protected Artifact target envelope set is inexact");
            }
            targetEnvelopeBytes.push(await withClientNamespaceKeyring({
              profile,
              namespaceId: binding.namespaceId,
              keyClass: "ai",
              requiredAccessRevision: binding.expectedAccessRevision,
              operation: (keyring) => {
                if (
                  keyring.domainId !== binding.domainId
                  || !equalBytes(keyring.bindingHash, binding.bindingHash)
                ) throw new Error("Protected Artifact target binding is stale");
                const generation = keyring.generations.find((candidate) =>
                  candidate.generation === keyring.currentGeneration
                );
                if (generation === undefined) {
                  throw new Error("Protected Artifact target generation is unavailable");
                }
                return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
                  dependencies.crypto,
                  generation.key,
                  {
                    objectId: objectId(plan.cryptoObjectId),
                    namespaceId: namespaceId(binding.namespaceId),
                    keyClass: "ai",
                    keyGeneration: namespaceGeneration(keyring.currentGeneration),
                    bindingRevisionAtWrap: accessRevision(binding.expectedAccessRevision),
                  },
                  controlDek!,
                ));
              },
            }));
          }
          for (const bytes of [
            ...opened.verifiedProofBytes,
            opened.currentManifestBytes,
          ]) {
            const manifest = decodeObjectAccessManifestV5(bytes);
            if (
              manifest.signer.kind === "human_device"
              && !publicKeys.has(manifest.signer.committerDeviceId)
            ) {
              const key = await dependencies.resolveTrustedDeviceSigningPublicKey({
                deviceId: manifest.signer.committerDeviceId,
                hostAuthorizationRevision: manifest.hostAuthorizationRevision,
                trustedDeviceRevision: profile.trustedDeviceRevision,
              });
              if (key === null) throw new Error("Protected Artifact signer is unavailable");
              publicKeys.set(manifest.signer.committerDeviceId, key);
            }
          }
          const prepare = (resolvers: ClientObjectAccessSignerResolversV4) =>
            prepareHumanObjectAccessManifestUpdateSet(dependencies.crypto, {
              operationId: plan.operationId,
              expectedContentRevision: plan.artifactRevision,
              currentManifestBytes: opened.currentManifestBytes,
              currentEnvelopeBytes: opened.currentEnvelopes.map(({ bytes }) => bytes),
              targetEnvelopeBytes,
              trustedMinimumHead: retained ?? opened.nextAnchor,
              proof: opened.verifiedProofBytes,
              resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
                publicKeys.get(context.committerDeviceId) ?? null,
              resolveAgentRuntimeSignerPublicKey:
                resolvers.resolveAgentRuntimeSignerPublicKey,
              resolveProcessorSignerAuthorizationBytes:
                resolvers.resolveProcessorSignerAuthorizationBytes,
              resolveHistoricalProcessorIssuingDevicePublicKey:
                resolvers.resolveHistoricalProcessorIssuingDevicePublicKey,
              currentNamespaceBindings: currentBindings,
              targetNamespaceBindings: targetBindings,
              sourceAuthorized: plan.sourceAuthorized,
              targetAuthorized: plan.targetAuthorized,
              subjectHumanId: humanId(dependencies.subjectHumanId),
              committerDeviceId: cryptoDeviceId(profile.deviceId),
              hostAuthorizationRevision: authorizationRevision(
                profile.trustedHostAuthorizationRevision,
              ),
              committerSigningPublicKey: profile.signingPublicKey,
              committerSigningPrivateKey: profile.signingPrivateKey,
            });
          const emptyResolvers: ClientObjectAccessSignerResolversV4 = Object.freeze({
            resolveAgentRuntimeSignerPublicKey: () => null,
            resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
          });
          const prepared = profileV4 === null
            ? prepare(emptyResolvers)
            : withClientObjectAccessSignerResolversV4({
              crypto: dependencies.crypto,
              profile: profileV4,
              operation: prepare,
            });
          const signedEntry = (
            binding: (typeof currentBindings)[number],
            envelopeBytes: Uint8Array,
          ) => {
            const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
            return Object.freeze({
              namespaceId: namespaceId(binding.namespaceId),
              domainId: cryptoDomainId(binding.domainId),
              expectedNamespaceAccessRevision: binding.expectedAccessRevision,
              expectedPolicyRevision: binding.expectedPolicyRevision,
              bindingHash: binding.bindingHash,
              keyGeneration: envelope.context.keyGeneration,
              bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
              envelopeHash: dependencies.crypto.hash(envelopeBytes),
            });
          };
          currentInventoryHash = fingerprintHumanArtifactAccessInventory(
            currentBindings.map((binding) => {
              const envelope = opened.currentEnvelopes.find((entry) =>
                entry.namespaceId === binding.namespaceId
              );
              if (envelope === undefined) throw new Error(
                "Protected Artifact current access inventory is incomplete",
              );
              return signedEntry(binding, envelope.bytes);
            }),
          );
          targetInventoryHash = fingerprintHumanArtifactAccessInventory(
            targetBindings.map((binding, index) =>
              signedEntry(binding, prepared.envelopeBytes[index]!)
            ),
          );
          const now = dependencies.now();
          const signed = prepareHumanArtifactExactAccessRequest(
            dependencies.crypto,
            {
              subjectHumanId: humanId(dependencies.subjectHumanId),
              operationId: plan.operationId,
              artifactId: plan.artifactId,
              artifactRevision: plan.artifactRevision,
              cryptoObjectId: objectId(plan.cryptoObjectId),
              blobId: plan.blobId,
              blobGeneration: plan.blobGeneration,
              payloadHash: opened.nextAnchor.payloadHash,
              expectedAccessRevision: plan.expectedCryptoAccessRevision,
              nextAccessRevision: plan.nextCryptoAccessRevision,
              currentManifestHash: dependencies.crypto.hash(
                opened.currentManifestBytes,
              ),
              nextManifestHash: prepared.manifestHash,
              currentInventoryHash,
              targetInventoryHash,
              issuedAt: unixTimestamp(now),
              deadlineAt: unixTimestamp(Math.min(plan.deadlineAt, now + 30_000)),
              committerDeviceId: cryptoDeviceId(profile.deviceId),
              hostAuthorizationRevision: authorizationRevision(
                profile.trustedHostAuthorizationRevision,
              ),
              committerSigningPublicKey: profile.signingPublicKey,
              committerSigningPrivateKey: profile.signingPrivateKey,
            },
          );
          const request = Object.freeze({
            requestVersion: 1 as const,
            operationId: plan.operationId,
            artifactId: plan.artifactId,
            artifactRevision: plan.artifactRevision,
            expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
            nextCryptoAccessRevision: plan.nextCryptoAccessRevision,
            cryptoObjectId: plan.cryptoObjectId,
            blobId: plan.blobId,
            blobGeneration: plan.blobGeneration,
            currentNamespaceIds: [...plan.currentNamespaceIds],
            targetNamespaceIds: [...plan.targetNamespaceIds],
            accessManifestBytesBase64url: toBase64url(prepared.manifestBytes),
            signedAccessRequestBytesBase64url: toBase64url(signed.bytes),
            namespaceEnvelopes: plan.targetNamespaceIds.map((id, index) => ({
              namespaceId: id,
              envelopeBytesBase64url: toBase64url(prepared.envelopeBytes[index]!),
            })),
          });
          signed.bytes.fill(0);
          return Object.freeze({ request, currentAnchor: opened.nextAnchor });
        } finally {
          wipeControl(opened.control);
          opened.currentManifestBytes.fill(0);
          opened.verifiedProofBytes.forEach((bytes) => bytes.fill(0));
          opened.currentEnvelopes.forEach(({ bytes }) => bytes.fill(0));
          controlDek?.fill(0);
          targetEnvelopeBytes.forEach((bytes) => bytes.fill(0));
          currentBindings.forEach(({ bindingHash }) => bindingHash.fill(0));
          targetBindings.forEach(({ bindingHash }) => bindingHash.fill(0));
          publicKeys.forEach((key) => key.fill(0));
          currentInventoryHash?.fill(0);
          targetInventoryHash?.fill(0);
        }
      });
      if (!await dependencies.accessAnchors.advance({
        expected: retained,
        next: result.currentAnchor,
      })) {
        throw new Error("Protected Artifact rollback anchor changed concurrently");
      }
      return Object.freeze({ request: result.request });
    },
    async prepareContent(input: Readonly<{
      plan: PlannedArtifactPublication;
      intent: AuthorizedHumanArtifactContentIntentV1;
    }>): Promise<PreparedHumanArtifactContentPublicationV1> {
      const plan = exactPlan(input.plan);
      if (plan.operation === "revise_control") {
        throw new TypeError("Artifact control revision cannot stage ciphertext");
      }
      const now = dependencies.now();
      if (
        !Number.isSafeInteger(now)
        || now < 0
        || plan.deadlineAt <= now
        || !Number.isSafeInteger(input.intent.plaintextLength)
        || input.intent.plaintextLength < 0
        || input.intent.plaintextLength > plan.maxPlaintextBytes
      ) throw new RangeError("Artifact plaintext/deadline is outside its plan");
      return withProfile(dependencies, async (profile) => {
        const header: ArtifactBlobHeader = Object.freeze({
          formatVersion: 1,
          artifactId: plan.artifactId,
          blobId: plan.resultBlobId,
          blobGeneration: plan.resultBlobGeneration,
          plaintextLength: input.intent.plaintextLength,
          chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
          chunkCount: Math.max(1, Math.ceil(
            input.intent.plaintextLength / ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
          )),
        });
        const blobDek = generateArtifactBlobDek(dependencies.crypto);
        const plaintextHash = sha256.create();
        let staged: StagedArtifactCiphertextSidecarReference | undefined;
        let plaintextSha256: Uint8Array | undefined;
        let controlBytes: Uint8Array | undefined;
        let controlDek: Uint8Array | undefined;
        let payloadBytes: Uint8Array | undefined;
        let manifestBytes: Uint8Array | undefined;
        let signedBytes: Uint8Array | undefined;
        let signedPlanDigest: Uint8Array | undefined;
        let signedCiphertextDigest: Uint8Array | undefined;
        const envelopeBytes: Uint8Array[] = [];
        const bindingHashes: Uint8Array[] = [];
        const envelopeHashes: Uint8Array[] = [];
        try {
          staged = await dependencies.ciphertextStaging.stage({
            operationId: plan.operationId,
            artifactId: plan.artifactId,
            blobId: plan.resultBlobId,
            blobGeneration: plan.resultBlobGeneration,
            ciphertext: encryptedBlobStream({
              crypto: dependencies.crypto,
              header,
              blobDek,
              plaintext: input.intent.plaintext,
              plaintextHash,
            }),
          });
          if (
            staged.ciphertextLength > plan.maxCiphertextBytes
            || staged.artifactId !== plan.artifactId
            || staged.operationId !== plan.operationId
            || staged.blobId !== plan.resultBlobId
            || staged.blobGeneration !== plan.resultBlobGeneration
          ) throw new Error("Artifact ciphertext sidecar disagrees with its plan");
          plaintextSha256 = plaintextHash.digest();
          const ciphertextSha256 = fromBase64url(
            "Artifact ciphertext hash",
            staged.ciphertextSha256Base64url,
          );
          try {
            controlBytes = encodeArtifactControlV1({
              formatVersion: 1,
              artifactId: plan.artifactId,
              artifactRevision: plan.nextArtifactRevision,
              blobGeneration: plan.resultBlobGeneration,
              blobDek,
              logicalPath: input.intent.logicalPath,
              mimeType: input.intent.mimeType,
              plaintextLength: input.intent.plaintextLength,
              plaintextSha256,
              blobId: plan.resultBlobId,
              ciphertextLength: staged.ciphertextLength,
              ciphertextSha256,
              chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
              chunkCount: header.chunkCount,
            });
          } finally {
            ciphertextSha256.fill(0);
          }
          const cryptoObjectId = deriveArtifactControlObjectIdV1({
            artifactId: plan.artifactId,
            artifactRevision: plan.nextArtifactRevision,
          });
          const encrypted = encryptObjectPayload(dependencies.crypto, {
            objectId: objectId(cryptoObjectId),
            keyClass: "ai",
            objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
            createdAt: unixTimestamp(now),
          }, controlBytes);
          controlDek = encrypted.dek;
          payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
          const requestEntries: Array<{
            namespaceId: ReturnType<typeof namespaceId>;
            domainId: ReturnType<typeof cryptoDomainId>;
            expectedNamespaceAccessRevision: number;
            expectedPolicyRevision: number;
            bindingHash: Uint8Array;
            keyGeneration: number;
            bindingRevisionAtWrap: number;
            envelopeHash: Uint8Array;
          }> = [];
          for (const [index, targetNamespaceId] of plan.requiredNamespaceIds.entries()) {
            const binding = plan.bindings[index]!;
            const bindingHash = fromBase64url(
              "Artifact Namespace binding hash",
              binding.bindingHashBase64url,
            );
            bindingHashes.push(bindingHash);
            const prepared = await withClientNamespaceKeyring({
              profile,
              namespaceId: targetNamespaceId,
              keyClass: "ai",
              requiredAccessRevision: binding.expectedAccessRevision,
              operation: (keyring) => {
                if (
                  keyring.domainId !== binding.domainId
                  || keyring.accessRevision !== binding.expectedAccessRevision
                  || !equalBytes(keyring.bindingHash, bindingHash)
                ) throw new Error("Current Artifact Namespace binding disagrees with plan");
                const generation = keyring.generations.find((entry) =>
                  entry.generation === keyring.currentGeneration
                );
                if (generation === undefined) {
                  throw new Error("Current Human Namespace key is unavailable");
                }
                const bytes = encodeNamespaceObjectEnvelopeV2(
                  wrapObjectDekForNamespace(dependencies.crypto, generation.key, {
                    objectId: objectId(cryptoObjectId),
                    namespaceId: namespaceId(targetNamespaceId),
                    keyClass: "ai",
                    keyGeneration: namespaceGeneration(keyring.currentGeneration),
                    bindingRevisionAtWrap: accessRevision(keyring.accessRevision),
                  }, controlDek!),
                );
                return Object.freeze({
                  bytes,
                  domainId: keyring.domainId,
                  keyGeneration: keyring.currentGeneration,
                  bindingRevisionAtWrap: keyring.accessRevision,
                });
              },
            });
            envelopeBytes.push(prepared.bytes);
            const envelopeHash = dependencies.crypto.hash(prepared.bytes);
            envelopeHashes.push(envelopeHash);
            requestEntries.push({
              namespaceId: namespaceId(targetNamespaceId),
              domainId: cryptoDomainId(binding.domainId),
              expectedNamespaceAccessRevision: binding.expectedAccessRevision,
              expectedPolicyRevision: binding.expectedPolicyRevision,
              bindingHash,
              keyGeneration: prepared.keyGeneration,
              bindingRevisionAtWrap: prepared.bindingRevisionAtWrap,
              envelopeHash,
            });
          }
          const access = prepareHumanObjectAccessManifestGenesisSet(dependencies.crypto, {
            objectId: objectId(cryptoObjectId),
            payloadHash: dependencies.crypto.hash(payloadBytes),
            envelopeBytes,
            sourceAuthorized: true,
            targetAuthorized: true,
            subjectHumanId: humanId(dependencies.subjectHumanId),
            committerDeviceId: cryptoDeviceId(profile.deviceId),
            hostAuthorizationRevision: authorizationRevision(
              profile.trustedHostAuthorizationRevision,
            ),
            committerSigningPublicKey: profile.signingPublicKey,
            committerSigningPrivateKey: profile.signingPrivateKey,
          });
          manifestBytes = access.manifestBytes;
          signedPlanDigest = fromBase64url(
            "Artifact plan digest",
            plan.planDigestBase64url,
          );
          signedCiphertextDigest = fromBase64url(
            "Artifact ciphertext hash",
            staged.ciphertextSha256Base64url,
          );
          const signed = prepareHumanArtifactPublicationRequest(
            dependencies.crypto,
            {
              operation: plan.operation,
              lifecycleAction: plan.lifecycleAction,
              subjectHumanId: humanId(dependencies.subjectHumanId),
              operationId: plan.operationId,
              planDigest: signedPlanDigest,
              artifactRowId: plan.artifactRowId,
              artifactId: plan.artifactId,
              anchorNamespaceId: namespaceId(plan.anchorNamespaceId),
              cryptoObjectId: objectId(cryptoObjectId),
              expectedArtifactRevision: plan.expectedArtifactRevision,
              nextArtifactRevision: plan.nextArtifactRevision,
              expectedAccessRevision: plan.expectedCryptoAccessRevision,
              resultAccessRevision: 0,
              expectedBlobGeneration: plan.expectedBlobGeneration,
              resultBlobGeneration: plan.resultBlobGeneration,
              expectedBlobId: plan.expectedBlobId,
              resultBlobId: plan.resultBlobId,
              controlPayloadHash: dependencies.crypto.hash(payloadBytes),
              accessManifestHash: dependencies.crypto.hash(manifestBytes),
              entries: requestEntries,
              ciphertextLength: staged.ciphertextLength,
              ciphertextSha256: signedCiphertextDigest,
              chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
              chunkCount: header.chunkCount,
              mimeClass: plan.mimeClass,
              sizeBucket: plan.sizeBucket,
              issuedAt: unixTimestamp(now),
              deadlineAt: unixTimestamp(plan.deadlineAt),
              committerDeviceId: cryptoDeviceId(profile.deviceId),
              hostAuthorizationRevision: authorizationRevision(
                profile.trustedHostAuthorizationRevision,
              ),
              committerSigningPublicKey: profile.signingPublicKey,
              committerSigningPrivateKey: profile.signingPrivateKey,
            },
          );
          signedBytes = signed.bytes;
          return Object.freeze({
            stagedCiphertext: staged,
            prepared: Object.freeze({
              requestVersion: 1,
              operationId: plan.operationId,
              planDigestBase64url: plan.planDigestBase64url,
              operation: plan.operation,
              lifecycleAction: plan.lifecycleAction,
              artifactRowId: plan.artifactRowId,
              artifactId: plan.artifactId,
              anchorNamespaceId: plan.anchorNamespaceId,
              cryptoObjectId,
              expectedArtifactRevision: plan.expectedArtifactRevision,
              nextArtifactRevision: plan.nextArtifactRevision,
              expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
              resultCryptoAccessRevision: 0,
              expectedBlobGeneration: plan.expectedBlobGeneration,
              resultBlobGeneration: plan.resultBlobGeneration,
              expectedBlobId: plan.expectedBlobId,
              resultBlobId: plan.resultBlobId,
              requiredNamespaceIds: [...plan.requiredNamespaceIds],
              encryptedControlPayloadBytesBase64url: toBase64url(payloadBytes),
              accessManifestBytesBase64url: toBase64url(manifestBytes),
              namespaceEnvelopes: plan.requiredNamespaceIds.map((id, index) => ({
                namespaceId: id,
                envelopeBytesBase64url: toBase64url(envelopeBytes[index]!),
              })),
              signedPublicationRequestBytesBase64url: toBase64url(signedBytes),
              ciphertextLength: staged.ciphertextLength,
              ciphertextSha256Base64url: staged.ciphertextSha256Base64url,
              chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
              chunkCount: header.chunkCount,
              mimeClass: plan.mimeClass,
              sizeBucket: plan.sizeBucket,
            }),
          });
        } catch (error) {
          if (staged !== undefined) {
            await dependencies.ciphertextStaging.removeStagedExact(staged)
              .catch(() => false);
          }
          throw error;
        } finally {
          blobDek.fill(0);
          plaintextSha256?.fill(0);
          controlBytes?.fill(0);
          controlDek?.fill(0);
          payloadBytes?.fill(0);
          manifestBytes?.fill(0);
          signedBytes?.fill(0);
          signedPlanDigest?.fill(0);
          signedCiphertextDigest?.fill(0);
          envelopeBytes.forEach((bytes) => bytes.fill(0));
          bindingHashes.forEach((bytes) => bytes.fill(0));
          envelopeHashes.forEach((bytes) => bytes.fill(0));
        }
      });
    },
  });
}
