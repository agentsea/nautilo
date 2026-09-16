import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export const HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1 =
  "artifact.exact_access_update" as const;
export const HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1 = 30_000;
export const MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1 = 4_096;

const DOMAIN = "nautilo/lattice-crypto/human-artifact-exact-access-request/v1";
const INVENTORY_DOMAIN = "nautilo/lattice-crypto/human-artifact-access-inventory/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_BYTES = 32;

export interface HumanArtifactAccessInventoryEntryV1 {
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly bindingHash: Uint8Array;
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface HumanArtifactExactAccessRequestV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly cryptoObjectId: ObjectId;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly payloadHash: Uint8Array;
  readonly expectedAccessRevision: number;
  readonly nextAccessRevision: number;
  readonly currentManifestHash: Uint8Array;
  readonly nextManifestHash: Uint8Array;
  readonly currentInventoryHash: Uint8Array;
  readonly targetInventoryHash: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly signature: Uint8Array;
}

export interface PrepareHumanArtifactExactAccessRequestInputV1 extends Omit<
  HumanArtifactExactAccessRequestV1,
  "formatVersion" | "purpose" | "signature"
> {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export type ResolveCurrentHumanArtifactExactAccessAuthorityV1 = (
  context: Readonly<{
    purpose: "human-artifact-exact-access-verify";
    subjectHumanId: HumanId;
    operationId: string;
    committerDeviceId: CryptoDeviceId;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

function exactBytes(label: string, value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must contain exactly ${length} bytes`);
  }
  return value.slice();
}

function artifactAccessSigningPublicKey(value: Uint8Array): Uint8Array {
  return exactBytes(
    "Human Artifact signing public key",
    value,
    V2_LIMITS.signingPublicKeyBytes,
  );
}

function artifactAccessSigningPrivateKey(value: Uint8Array): Uint8Array {
  return exactBytes(
    "Human Artifact signing private key",
    value,
    V2_LIMITS.signingPrivateKeyBytes,
  );
}

function counter(label: string, value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} is outside its supported range`);
  }
  return value;
}

function uuid(label: string, value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function normalizeEntry(
  entry: HumanArtifactAccessInventoryEntryV1,
): HumanArtifactAccessInventoryEntryV1 {
  return Object.freeze({
    namespaceId: namespaceId(entry.namespaceId),
    domainId: cryptoDomainId(entry.domainId),
    expectedNamespaceAccessRevision: counter(
      "Artifact Namespace access revision",
      entry.expectedNamespaceAccessRevision,
    ),
    expectedPolicyRevision: counter(
      "Artifact Namespace policy revision",
      entry.expectedPolicyRevision,
    ),
    bindingHash: exactBytes("Artifact Namespace binding hash", entry.bindingHash, 32),
    keyGeneration: counter("Artifact Namespace key generation", entry.keyGeneration),
    bindingRevisionAtWrap: counter(
      "Artifact envelope binding revision",
      entry.bindingRevisionAtWrap,
    ),
    envelopeHash: exactBytes("Artifact envelope hash", entry.envelopeHash, 32),
  });
}

function entryBytes(entry: HumanArtifactAccessInventoryEntryV1): Uint8Array {
  return concatV2(
    frameText(entry.namespaceId),
    frameText(entry.domainId),
    encodeU64(entry.expectedNamespaceAccessRevision),
    encodeU64(entry.expectedPolicyRevision),
    frame(entry.bindingHash),
    encodeU64(entry.keyGeneration),
    encodeU64(entry.bindingRevisionAtWrap),
    frame(entry.envelopeHash),
  );
}

export function fingerprintHumanArtifactAccessInventoryV1(
  entries: readonly HumanArtifactAccessInventoryEntryV1[],
): Uint8Array {
  if (!Array.isArray(entries) || entries.length > V2_LIMITS.namespaceEnvelopesPerManifest) {
    throw new RangeError("Artifact access inventory is unbounded");
  }
  const normalized = entries.map(normalizeEntry);
  if (normalized.some((entry, index) =>
    index > 0 && normalized[index - 1]!.namespaceId > entry.namespaceId
  )) throw new TypeError("Artifact access inventory must be sorted");
  if (normalized.some((entry, index) =>
    index > 0 && normalized[index - 1]!.namespaceId === entry.namespaceId
  )) throw new TypeError("Artifact access inventory contains duplicate Namespaces");
  const parts = normalized.map(entryBytes);
  try {
    return sha256(concatV2(
      frameText(INVENTORY_DOMAIN),
      encodeU32(normalized.length),
      ...parts,
    ));
  } finally {
    normalized.forEach((entry) => {
      entry.bindingHash.fill(0);
      entry.envelopeHash.fill(0);
    });
    parts.forEach((bytes) => bytes.fill(0));
  }
}

function normalize(
  value: Omit<HumanArtifactExactAccessRequestV1, "signature">,
): Omit<HumanArtifactExactAccessRequestV1, "signature"> {
  if (
    value.formatVersion !== 1
    || value.purpose !== HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1
  ) throw new TypeError("Human Artifact exact-access request kind is invalid");
  assertPortableId("Human Artifact exact-access operation id", value.operationId);
  const expectedAccessRevision = counter(
    "Human Artifact expected access revision",
    value.expectedAccessRevision,
  );
  const nextAccessRevision = counter(
    "Human Artifact next access revision",
    value.nextAccessRevision,
    1,
  );
  if (nextAccessRevision !== expectedAccessRevision + 1) {
    throw new TypeError("Human Artifact access revision must advance once");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1
  ) throw new RangeError("Human Artifact exact-access deadline is invalid");
  return Object.freeze({
    formatVersion: 1,
    purpose: HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1,
    subjectHumanId: humanId(value.subjectHumanId),
    operationId: value.operationId,
    artifactId: uuid("Human Artifact id", value.artifactId),
    artifactRevision: counter("Human Artifact revision", value.artifactRevision, 1),
    cryptoObjectId: objectId(value.cryptoObjectId),
    blobId: uuid("Human Artifact blob id", value.blobId),
    blobGeneration: counter("Human Artifact blob generation", value.blobGeneration, 1),
    payloadHash: exactBytes("Human Artifact payload hash", value.payloadHash, 32),
    expectedAccessRevision,
    nextAccessRevision,
    currentManifestHash: exactBytes("Current Artifact manifest hash", value.currentManifestHash, 32),
    nextManifestHash: exactBytes("Next Artifact manifest hash", value.nextManifestHash, 32),
    currentInventoryHash: exactBytes("Current Artifact inventory hash", value.currentInventoryHash, 32),
    targetInventoryHash: exactBytes("Target Artifact inventory hash", value.targetInventoryHash, 32),
    issuedAt,
    deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
  });
}

function signingBytes(
  value: Omit<HumanArtifactExactAccessRequestV1, "signature">,
): Uint8Array {
  return concatV2(
    frameText(DOMAIN),
    encodeU32(1),
    frameText(value.purpose),
    frameText(value.subjectHumanId),
    frameText(value.operationId),
    frameText(value.artifactId),
    encodeU64(value.artifactRevision),
    frameText(value.cryptoObjectId),
    frameText(value.blobId),
    encodeU64(value.blobGeneration),
    frame(value.payloadHash),
    encodeU64(value.expectedAccessRevision),
    encodeU64(value.nextAccessRevision),
    frame(value.currentManifestHash),
    frame(value.nextManifestHash),
    frame(value.currentInventoryHash),
    frame(value.targetInventoryHash),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.hostAuthorizationRevision),
  );
}

function destroy(value: Omit<HumanArtifactExactAccessRequestV1, "signature">): void {
  value.payloadHash.fill(0);
  value.currentManifestHash.fill(0);
  value.nextManifestHash.fill(0);
  value.currentInventoryHash.fill(0);
  value.targetInventoryHash.fill(0);
}

export function encodeHumanArtifactExactAccessRequestV1(
  request: HumanArtifactExactAccessRequestV1,
): Uint8Array {
  const { signature: rawSignature, ...rawUnsigned } = request;
  const unsigned = normalize(rawUnsigned);
  const signature = exactBytes("Human Artifact exact-access signature", rawSignature,
    V2_LIMITS.signatureBytes);
  try {
    const bytes = concatV2(signingBytes(unsigned), frame(signature));
    if (bytes.length > MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Human Artifact exact-access request is too large");
    }
    return bytes;
  } finally {
    destroy(unsigned);
    signature.fill(0);
  }
}

export function decodeHumanArtifactExactAccessRequestV1(
  bytes: Uint8Array,
): HumanArtifactExactAccessRequestV1 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1) {
    throw new TypeError("Human Artifact exact-access request bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): HumanArtifactExactAccessRequestV1 => {
    if (reader.readText(utf8V2(DOMAIN).length) !== DOMAIN) {
      throw new CanonicalDecodingError("Human Artifact exact-access domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(
        utf8V2(HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1).length,
      ) as typeof HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      artifactId: reader.readText(36),
      artifactRevision: reader.readU64(),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      blobId: reader.readText(36),
      blobGeneration: reader.readU64(),
      payloadHash: reader.readFrame(HASH_BYTES),
      expectedAccessRevision: reader.readU64(),
      nextAccessRevision: reader.readU64(),
      currentManifestHash: reader.readFrame(HASH_BYTES),
      nextManifestHash: reader.readFrame(HASH_BYTES),
      currentInventoryHash: reader.readFrame(HASH_BYTES),
      targetInventoryHash: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  const { signature: rawSignature, ...rawUnsigned } = raw;
  const unsigned = normalize(rawUnsigned);
  const signature = exactBytes("Human Artifact exact-access signature", rawSignature,
    V2_LIMITS.signatureBytes);
  const result = Object.freeze({ ...unsigned, signature });
  const canonical = encodeHumanArtifactExactAccessRequestV1(result);
  try {
    if (!equal(canonical, bytes)) {
      throw new CanonicalDecodingError("Human Artifact exact-access request is noncanonical");
    }
    return result;
  } catch (error) {
    destroy(result);
    result.signature.fill(0);
    throw error;
  } finally {
    destroy(raw);
    raw.signature.fill(0);
    canonical.fill(0);
  }
}

export function prepareHumanArtifactExactAccessRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanArtifactExactAccessRequestInputV1,
): Readonly<{ request: HumanArtifactExactAccessRequestV1; bytes: Uint8Array }> {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...raw } = input;
  const unsigned = normalize({ ...raw, formatVersion: 1,
    purpose: HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1 });
  const publicKey = artifactAccessSigningPublicKey(committerSigningPublicKey);
  const privateKey = artifactAccessSigningPrivateKey(committerSigningPrivateKey);
  let bytesToSign: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    bytesToSign = signingBytes(unsigned);
    signature = crypto.sign(privateKey, bytesToSign);
    if (!crypto.verify(publicKey, bytesToSign, signature)) {
      throw new TypeError("Human Artifact signing keys do not match");
    }
    const bytes = encodeHumanArtifactExactAccessRequestV1({ ...unsigned, signature });
    return Object.freeze({ request: decodeHumanArtifactExactAccessRequestV1(bytes), bytes });
  } finally {
    destroy(unsigned);
    publicKey.fill(0);
    privateKey.fill(0);
    bytesToSign?.fill(0);
    signature?.fill(0);
  }
}

export function verifyHumanArtifactExactAccessRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanArtifactExactAccessAuthorityV1;
  }>,
): HumanArtifactExactAccessRequestV1 {
  const request = decodeHumanArtifactExactAccessRequestV1(input.requestBytes);
  let publicKey: Uint8Array | undefined;
  let bytesToVerify: Uint8Array | undefined;
  let success = false;
  try {
    const resolved = input.resolveCurrentAuthority(Object.freeze({
      purpose: "human-artifact-exact-access-verify" as const,
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    }));
    if (resolved === null) throw new TypeError("Human Artifact authority is unavailable");
    publicKey = exactBytes("Human Artifact authority public key", resolved,
      V2_LIMITS.signingPublicKeyBytes);
    const { signature: _signature, ...unsigned } = request;
    bytesToVerify = signingBytes(unsigned);
    if (!crypto.verify(publicKey, bytesToVerify, request.signature)) {
      throw new TypeError("Human Artifact exact-access signature is invalid");
    }
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt) {
      throw new TypeError("Human Artifact exact-access request is not current");
    }
    success = true;
    return request;
  } finally {
    publicKey?.fill(0);
    bytesToVerify?.fill(0);
    if (!success) {
      destroy(request);
      request.signature.fill(0);
    }
  }
}
