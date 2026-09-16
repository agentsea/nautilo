import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
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
  assertU64Counter,
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
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ARTIFACT_BLOB_MAX_CHUNKS_V1,
  ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
} from "./blob-v1.ts";

export const HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_ARTIFACT_PUBLICATION_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-artifact-publication-request/v1";
export const HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1 =
  "artifact.publish" as const;
export const HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1 = 30_000;
export const HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1 =
  V2_LIMITS.namespaceEnvelopesPerManifest;
export const MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1 =
  256 * 1024;

const HASH_BYTES = 32;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HumanArtifactPublicationOperationV1 =
  | "create"
  | "replace_content"
  | "revise_control";
export type HumanArtifactPublicationLifecycleActionV1 = "activate" | "archive";
export type HumanArtifactMimeClassV1 =
  | "text" | "image" | "audio" | "video" | "document" | "archive" | "binary";
export type HumanArtifactSizeBucketV1 =
  | "empty" | "le_64_kib" | "le_1_mib" | "le_10_mib" | "le_100_mib";

export interface HumanArtifactPublicationRequestEntryV1 {
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly bindingHash: Uint8Array;
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface HumanArtifactPublicationRequestUnsignedV1 {
  readonly formatVersion:
    typeof HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1;
  readonly purpose: typeof HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1;
  readonly operation: HumanArtifactPublicationOperationV1;
  readonly lifecycleAction: HumanArtifactPublicationLifecycleActionV1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly planDigest: Uint8Array;
  readonly artifactRowId: string;
  readonly artifactId: string;
  readonly anchorNamespaceId: NamespaceId;
  readonly cryptoObjectId: ObjectId;
  readonly expectedArtifactRevision: number;
  readonly nextArtifactRevision: number;
  readonly expectedAccessRevision: number;
  readonly resultAccessRevision: 0;
  readonly expectedBlobGeneration: number;
  readonly resultBlobGeneration: number;
  readonly expectedBlobId: string | null;
  readonly resultBlobId: string;
  readonly controlPayloadHash: Uint8Array;
  readonly accessManifestHash: Uint8Array;
  readonly entries: readonly HumanArtifactPublicationRequestEntryV1[];
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
  readonly chunkPlaintextBytes:
    typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1;
  readonly chunkCount: number;
  readonly mimeClass: HumanArtifactMimeClassV1;
  readonly sizeBucket: HumanArtifactSizeBucketV1;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanArtifactPublicationRequestV1
  extends HumanArtifactPublicationRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanArtifactPublicationRequestInputV1
  extends Omit<
    HumanArtifactPublicationRequestUnsignedV1,
    "formatVersion" | "purpose"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanArtifactPublicationRequestV1 {
  readonly request: HumanArtifactPublicationRequestV1;
  readonly bytes: Uint8Array;
}

export interface HumanArtifactPublicationAuthorityContextV1 {
  readonly purpose: "human-artifact-publication-verify";
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export type ResolveCurrentHumanArtifactPublicationAuthorityV1 = (
  context: HumanArtifactPublicationAuthorityContextV1,
) => Uint8Array | null;

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "purpose",
  "operation",
  "lifecycleAction",
  "subjectHumanId",
  "operationId",
  "planDigest",
  "artifactRowId",
  "artifactId",
  "anchorNamespaceId",
  "cryptoObjectId",
  "expectedArtifactRevision",
  "nextArtifactRevision",
  "expectedAccessRevision",
  "resultAccessRevision",
  "expectedBlobGeneration",
  "resultBlobGeneration",
  "expectedBlobId",
  "resultBlobId",
  "controlPayloadHash",
  "accessManifestHash",
  "entries",
  "ciphertextLength",
  "ciphertextSha256",
  "chunkPlaintextBytes",
  "chunkCount",
  "mimeClass",
  "sizeBucket",
  "issuedAt",
  "deadlineAt",
  "committerDeviceId",
  "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const ENTRY_FIELDS = Object.freeze([
  "namespaceId",
  "domainId",
  "expectedNamespaceAccessRevision",
  "expectedPolicyRevision",
  "bindingHash",
  "keyGeneration",
  "bindingRevisionAtWrap",
  "envelopeHash",
] as const);

function assertObject(label: string, value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const wanted = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== wanted.length
    || actual.some((field, index) => field !== wanted[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function artifactSigningPublicKey(value: Uint8Array): Uint8Array {
  return exactBytes(
    "Human Artifact signing public key",
    value,
    V2_LIMITS.signingPublicKeyBytes,
  );
}

function artifactSigningPrivateKey(value: Uint8Array): Uint8Array {
  return exactBytes(
    "Human Artifact signing private key",
    value,
    V2_LIMITS.signingPrivateKeyBytes,
  );
}

function wipe(...values: readonly (Uint8Array | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function normalizeEntries(
  value: unknown,
): readonly HumanArtifactPublicationRequestEntryV1[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1
  ) throw new RangeError("Human Artifact publication entry inventory is not bounded");
  const entries: HumanArtifactPublicationRequestEntryV1[] = [];
  try {
    let previous: string | null = null;
    for (const raw of value) {
      assertObject("Human Artifact publication entry", raw);
      assertExactFields("Human Artifact publication entry", raw, ENTRY_FIELDS);
      const entry = raw as HumanArtifactPublicationRequestEntryV1;
      const id = namespaceId(entry.namespaceId);
      if (previous !== null && compareUnsignedUtf8(previous, id) >= 0) {
        throw new TypeError("Human Artifact publication entries must be unique and sorted");
      }
      previous = id;
      assertU64Counter("Human Artifact Namespace access revision", entry.expectedNamespaceAccessRevision);
      assertU64Counter("Human Artifact policy revision", entry.expectedPolicyRevision);
      assertU64Counter("Human Artifact key generation", entry.keyGeneration);
      assertU64Counter("Human Artifact binding revision at wrap", entry.bindingRevisionAtWrap);
      entries.push(Object.freeze({
        namespaceId: id,
        domainId: cryptoDomainId(entry.domainId),
        expectedNamespaceAccessRevision: entry.expectedNamespaceAccessRevision,
        expectedPolicyRevision: entry.expectedPolicyRevision,
        bindingHash: exactBytes("Human Artifact binding hash", entry.bindingHash, HASH_BYTES),
        keyGeneration: entry.keyGeneration,
        bindingRevisionAtWrap: entry.bindingRevisionAtWrap,
        envelopeHash: exactBytes("Human Artifact envelope hash", entry.envelopeHash, HASH_BYTES),
      }));
    }
    return Object.freeze(entries);
  } catch (error) {
    destroyEntries(entries);
    throw error;
  }
}

function destroyEntries(entries: readonly HumanArtifactPublicationRequestEntryV1[]): void {
  entries.forEach((entry) => wipe(entry.bindingHash, entry.envelopeHash));
}

function normalizeUnsigned(
  value: HumanArtifactPublicationRequestUnsignedV1,
): HumanArtifactPublicationRequestUnsignedV1 {
  assertObject("Human Artifact publication request", value);
  assertExactFields("Human Artifact publication request", value, UNSIGNED_FIELDS);
  if (
    value.formatVersion !== HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1
    || value.purpose !== HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1
    || !["create", "replace_content", "revise_control"].includes(value.operation)
  ) throw new TypeError("Human Artifact publication request kind is invalid");
  if (
    !["activate", "archive"].includes(value.lifecycleAction)
    || (value.operation !== "revise_control" && value.lifecycleAction !== "activate")
  ) throw new TypeError("Human Artifact publication lifecycle action is invalid");
  assertPortableId("Human Artifact publication operation id", value.operationId);
  assertU64Counter("Expected Artifact revision", value.expectedArtifactRevision);
  assertU64Counter("Next Artifact revision", value.nextArtifactRevision);
  assertU64Counter("Expected Artifact access revision", value.expectedAccessRevision);
  assertU64Counter("Expected Artifact blob generation", value.expectedBlobGeneration);
  assertU64Counter("Result Artifact blob generation", value.resultBlobGeneration);
  if (value.nextArtifactRevision !== value.expectedArtifactRevision + 1) {
    throw new RangeError("Artifact revision must advance exactly once");
  }
  if (value.resultAccessRevision !== 0) {
    throw new RangeError("A fresh Artifact control object starts at access revision zero");
  }
  const expectedBlobId = value.expectedBlobId === null
    ? null
    : uuid("Expected Artifact blob id", value.expectedBlobId);
  const resultBlobId = uuid("Result Artifact blob id", value.resultBlobId);
  if (value.operation === "create") {
    if (
      value.expectedArtifactRevision !== 0
      || value.expectedAccessRevision !== 0
      || value.expectedBlobGeneration !== 0
      || expectedBlobId !== null
      || value.resultBlobGeneration !== 1
    ) throw new TypeError("Artifact create coordinates are invalid");
  } else if (value.operation === "replace_content") {
    if (
      value.expectedArtifactRevision < 1
      || value.expectedBlobGeneration < 1
      || expectedBlobId === null
      || value.resultBlobGeneration !== value.expectedBlobGeneration + 1
      || expectedBlobId === resultBlobId
    ) throw new TypeError("Artifact content replacement coordinates are invalid");
  } else if (
    value.expectedArtifactRevision < 1
    || value.expectedBlobGeneration < 1
    || expectedBlobId === null
    || value.resultBlobGeneration !== value.expectedBlobGeneration
    || expectedBlobId !== resultBlobId
  ) throw new TypeError("Artifact control revision coordinates are invalid");
  if (
    !Number.isSafeInteger(value.ciphertextLength)
    || value.ciphertextLength < 1
    || value.ciphertextLength > ARTIFACT_BLOB_MAX_FILE_BYTES_V1
    || value.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1
    || !Number.isSafeInteger(value.chunkCount)
    || value.chunkCount < 1
    || value.chunkCount > ARTIFACT_BLOB_MAX_CHUNKS_V1
  ) throw new RangeError("Artifact ciphertext coordinates are invalid");
  if (![
    "text", "image", "audio", "video", "document", "archive", "binary",
  ].includes(value.mimeClass)) throw new TypeError("Artifact MIME class is invalid");
  if (![
    "empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib",
  ].includes(value.sizeBucket)) throw new TypeError("Artifact size bucket is invalid");
  let controlPayloadHash: Uint8Array | undefined;
  let accessManifestHash: Uint8Array | undefined;
  let ciphertextSha256: Uint8Array | undefined;
  let planDigest: Uint8Array | undefined;
  let entries: readonly HumanArtifactPublicationRequestEntryV1[] | undefined;
  try {
    planDigest = exactBytes(
      "Human Artifact publication plan digest",
      value.planDigest,
      HASH_BYTES,
    );
    controlPayloadHash = exactBytes("Artifact control payload hash", value.controlPayloadHash, HASH_BYTES);
    accessManifestHash = exactBytes("Artifact access manifest hash", value.accessManifestHash, HASH_BYTES);
    ciphertextSha256 = exactBytes("Artifact ciphertext hash", value.ciphertextSha256, HASH_BYTES);
    entries = normalizeEntries(value.entries);
    const issuedAt = unixTimestamp(value.issuedAt);
    const deadlineAt = unixTimestamp(value.deadlineAt);
    if (
      deadlineAt <= issuedAt
      || deadlineAt - issuedAt > HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1
    ) throw new RangeError("Human Artifact publication deadline is invalid");
    return Object.freeze({
      formatVersion: HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1,
      purpose: HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1,
      operation: value.operation,
      lifecycleAction: value.lifecycleAction,
      subjectHumanId: humanId(value.subjectHumanId),
      operationId: value.operationId,
      planDigest,
      artifactRowId: uuid("Artifact row id", value.artifactRowId),
      artifactId: uuid("Artifact id", value.artifactId),
      anchorNamespaceId: namespaceId(value.anchorNamespaceId),
      cryptoObjectId: objectId(value.cryptoObjectId),
      expectedArtifactRevision: value.expectedArtifactRevision,
      nextArtifactRevision: value.nextArtifactRevision,
      expectedAccessRevision: value.expectedAccessRevision,
      resultAccessRevision: 0,
      expectedBlobGeneration: value.expectedBlobGeneration,
      resultBlobGeneration: value.resultBlobGeneration,
      expectedBlobId,
      resultBlobId,
      controlPayloadHash,
      accessManifestHash,
      entries,
      ciphertextLength: value.ciphertextLength,
      ciphertextSha256,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount: value.chunkCount,
      mimeClass: value.mimeClass,
      sizeBucket: value.sizeBucket,
      issuedAt,
      deadlineAt,
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    });
  } catch (error) {
    wipe(planDigest, controlPayloadHash, accessManifestHash, ciphertextSha256);
    if (entries) destroyEntries(entries);
    throw error;
  }
}

function normalizeRequest(value: HumanArtifactPublicationRequestV1): HumanArtifactPublicationRequestV1 {
  assertObject("Human Artifact publication request", value);
  assertExactFields("Human Artifact publication request", value, SIGNED_FIELDS);
  const { signature, ...unsignedValue } = value;
  const unsigned = normalizeUnsigned(unsignedValue);
  try {
    return Object.freeze({ ...unsigned, signature: exactBytes("Human Artifact signature", signature, V2_LIMITS.signatureBytes) });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function destroyUnsigned(value: HumanArtifactPublicationRequestUnsignedV1): void {
  wipe(
    value.planDigest,
    value.controlPayloadHash,
    value.accessManifestHash,
    value.ciphertextSha256,
  );
  destroyEntries(value.entries);
}

function destroyRequest(value: HumanArtifactPublicationRequestV1): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function entryParts(entry: HumanArtifactPublicationRequestEntryV1): readonly Uint8Array[] {
  return [
    frameText(entry.namespaceId),
    frameText(entry.domainId),
    encodeU64(entry.expectedNamespaceAccessRevision),
    encodeU64(entry.expectedPolicyRevision),
    frame(entry.bindingHash),
    encodeU64(entry.keyGeneration),
    encodeU64(entry.bindingRevisionAtWrap),
    frame(entry.envelopeHash),
  ];
}

function signingBytes(value: HumanArtifactPublicationRequestUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_ARTIFACT_PUBLICATION_REQUEST_DOMAIN_V1),
    encodeU32(HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1),
    frameText(value.purpose),
    frameText(value.operation),
    frameText(value.lifecycleAction),
    frameText(value.subjectHumanId),
    frameText(value.operationId),
    frame(value.planDigest),
    frameText(value.artifactRowId),
    frameText(value.artifactId),
    frameText(value.anchorNamespaceId),
    frameText(value.cryptoObjectId),
    encodeU64(value.expectedArtifactRevision),
    encodeU64(value.nextArtifactRevision),
    encodeU64(value.expectedAccessRevision),
    encodeU64(value.resultAccessRevision),
    encodeU64(value.expectedBlobGeneration),
    encodeU64(value.resultBlobGeneration),
    frameText(value.expectedBlobId ?? ""),
    frameText(value.resultBlobId),
    frame(value.controlPayloadHash),
    frame(value.accessManifestHash),
    encodeU32(value.entries.length),
    ...value.entries.flatMap(entryParts),
    encodeU64(value.ciphertextLength),
    frame(value.ciphertextSha256),
    encodeU64(value.chunkPlaintextBytes),
    encodeU64(value.chunkCount),
    frameText(value.mimeClass),
    frameText(value.sizeBucket),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanArtifactPublicationRequestSigningBytesV1(
  value: HumanArtifactPublicationRequestUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytes(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeHumanArtifactPublicationRequestV1(
  value: HumanArtifactPublicationRequestV1,
): Uint8Array {
  const normalized = normalizeRequest(value);
  try {
    const bytes = concatV2(signingBytes(normalized), frame(normalized.signature));
    if (bytes.length > MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Human Artifact publication request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest(normalized);
  }
}

function readEntries(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): HumanArtifactPublicationRequestEntryV1[] {
  const count = reader.readCount(HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1);
  return Array.from({ length: count }, () => ({
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    expectedNamespaceAccessRevision: reader.readU64(),
    expectedPolicyRevision: reader.readU64(),
    bindingHash: reader.readFrame(HASH_BYTES),
    keyGeneration: reader.readU64(),
    bindingRevisionAtWrap: reader.readU64(),
    envelopeHash: reader.readFrame(HASH_BYTES),
  }));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function decodeHumanArtifactPublicationRequestV1(
  bytes: Uint8Array,
): HumanArtifactPublicationRequestV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Human Artifact publication bytes must be Uint8Array");
  if (bytes.length > MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1) {
    throw new RangeError("Human Artifact publication request exceeds its wire limit");
  }
  const raw = decodeExact(bytes, (reader): HumanArtifactPublicationRequestV1 => {
    const domain = reader.readText(utf8V2(HUMAN_ARTIFACT_PUBLICATION_REQUEST_DOMAIN_V1).length);
    if (domain !== HUMAN_ARTIFACT_PUBLICATION_REQUEST_DOMAIN_V1) {
      throw new CanonicalDecodingError("Human Artifact publication domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1) as 1,
      purpose: reader.readText(utf8V2(HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1).length) as typeof HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1,
      operation: reader.readText(32) as HumanArtifactPublicationOperationV1,
      lifecycleAction: reader.readText(16) as HumanArtifactPublicationLifecycleActionV1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      planDigest: reader.readFrame(HASH_BYTES),
      artifactRowId: reader.readText(36),
      artifactId: reader.readText(36),
      anchorNamespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      expectedArtifactRevision: reader.readU64(),
      nextArtifactRevision: reader.readU64(),
      expectedAccessRevision: reader.readU64(),
      resultAccessRevision: reader.readU64() as 0,
      expectedBlobGeneration: reader.readU64(),
      resultBlobGeneration: reader.readU64(),
      expectedBlobId: (() => { const value = reader.readText(36); return value === "" ? null : value; })(),
      resultBlobId: reader.readText(36),
      controlPayloadHash: reader.readFrame(HASH_BYTES),
      accessManifestHash: reader.readFrame(HASH_BYTES),
      entries: readEntries(reader),
      ciphertextLength: reader.readU64(),
      ciphertextSha256: reader.readFrame(HASH_BYTES),
      chunkPlaintextBytes: reader.readU64() as typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount: reader.readU64(),
      mimeClass: reader.readText(16) as HumanArtifactMimeClassV1,
      sizeBucket: reader.readText(16) as HumanArtifactSizeBucketV1,
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: HumanArtifactPublicationRequestV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeRequest(raw);
    canonical = encodeHumanArtifactPublicationRequestV1(normalized);
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Human Artifact publication request is noncanonical");
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyRequest(raw);
    if (normalized) destroyRequest(normalized);
    canonical?.fill(0);
  }
}

export function prepareHumanArtifactPublicationRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanArtifactPublicationRequestInputV1,
): CreatedHumanArtifactPublicationRequestV1 {
  const { committerSigningPublicKey: rawPublicKey, committerSigningPrivateKey: rawPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({
    ...rest,
    formatVersion: HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1,
    purpose: HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1,
  });
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let message: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    publicKey = artifactSigningPublicKey(rawPublicKey);
    privateKey = artifactSigningPrivateKey(rawPrivateKey);
    message = signingBytes(unsigned);
    signature = exactBytes("Human Artifact signature", crypto.sign(privateKey, message), V2_LIMITS.signatureBytes);
    if (!crypto.verify(publicKey, message, signature)) throw new TypeError("Human Artifact signing keys do not match");
    const bytes = encodeHumanArtifactPublicationRequestV1({ ...unsigned, signature });
    return Object.freeze({ request: decodeHumanArtifactPublicationRequestV1(bytes), bytes });
  } finally {
    destroyUnsigned(unsigned);
    wipe(publicKey, privateKey, message, signature);
  }
}

export function verifyHumanArtifactPublicationRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanArtifactPublicationAuthorityV1;
  }>,
): HumanArtifactPublicationRequestV1 {
  const request = decodeHumanArtifactPublicationRequestV1(input.requestBytes);
  let publicKey: Uint8Array | undefined;
  let message: Uint8Array | undefined;
  let verified = false;
  try {
    const resolved = input.resolveCurrentAuthority(Object.freeze({
      purpose: "human-artifact-publication-verify" as const,
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    }));
    if (resolved === null) throw new TypeError("Human Artifact publication authority is unavailable");
    publicKey = exactBytes("Human Artifact authority public key", resolved, V2_LIMITS.signingPublicKeyBytes);
    message = signingBytes(request);
    if (!crypto.verify(publicKey, message, request.signature)) throw new TypeError("Human Artifact publication signature is invalid");
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt) throw new TypeError("Human Artifact publication request is not currently valid");
    verified = true;
    return request;
  } finally {
    wipe(publicKey, message);
    if (!verified) destroyRequest(request);
  }
}
