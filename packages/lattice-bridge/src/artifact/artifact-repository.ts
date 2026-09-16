import { sha256 } from "@noble/hashes/sha2.js";

export const ARTIFACT_CONTROL_OBJECT_TYPE_V1 =
  "nautilo-artifact-control-v1" as const;
export const ARTIFACT_CONTROL_VERSION_V1 = 1 as const;
export const ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 = 1_048_576 as const;
const ARTIFACT_PLAINTEXT_MAX_BYTES_V1 = 100 * 1_048_576;
const ARTIFACT_MAX_NAMESPACES_V1 = 256;

export const ARTIFACT_MIME_CLASSES = Object.freeze([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "archive",
  "binary",
] as const);
export type ArtifactMimeClass = typeof ARTIFACT_MIME_CLASSES[number];

export const ARTIFACT_SIZE_BUCKETS = Object.freeze([
  "empty",
  "le_64_kib",
  "le_1_mib",
  "le_10_mib",
  "le_100_mib",
] as const);
export type ArtifactSizeBucket = typeof ARTIFACT_SIZE_BUCKETS[number];

export function artifactSizeBucketForPlaintextLength(
  plaintextLength: number,
): ArtifactSizeBucket {
  if (
    !Number.isSafeInteger(plaintextLength)
    || plaintextLength < 0
    || plaintextLength > ARTIFACT_PLAINTEXT_MAX_BYTES_V1
  ) throw new RangeError("Artifact plaintext length is outside its bound");
  if (plaintextLength === 0) return "empty";
  if (plaintextLength <= 64 * 1_024) return "le_64_kib";
  if (plaintextLength <= 1_048_576) return "le_1_mib";
  if (plaintextLength <= 10 * 1_048_576) return "le_10_mib";
  return "le_100_mib";
}

export type ArtifactPublicationOperationType =
  | "create"
  | "content"
  | "control";

const ARTIFACT_OBJECT_ID_DOMAIN = "nautilo/artifact-control-object/v1";
const ARTIFACT_NAMESPACE_SET_DOMAIN =
  "nautilo/artifact-required-namespaces/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assertUuid(label: string, value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
}

function assertPositiveRevision(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${label} must be a positive safe revision`);
  }
}

function assertDigest(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

function assertPortableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || new TextEncoder().encode(value).length < 1
    || new TextEncoder().encode(value).length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) throw new TypeError(`${label} must be a bounded portable identifier`);
}

function assertNonnegativeRevision(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} must be a nonnegative safe revision`);
  }
}

function namespacePreimage(namespaceIds: readonly string[]): Uint8Array {
  if (
    namespaceIds.length < 1
    || namespaceIds.length > ARTIFACT_MAX_NAMESPACES_V1
  ) {
    throw new RangeError("Required Artifact Namespace set is not bounded");
  }
  let previous: string | null = null;
  for (const namespaceId of namespaceIds) {
    assertUuid("Required Artifact Namespace ID", namespaceId);
    if (previous !== null && namespaceId === previous) {
      throw new TypeError("Required Artifact Namespace IDs must be unique");
    }
    if (previous !== null && namespaceId < previous) {
      throw new TypeError("Required Artifact Namespace IDs must be sorted");
    }
    previous = namespaceId;
  }
  return encoder.encode(
    `${ARTIFACT_NAMESPACE_SET_DOMAIN}\n${namespaceIds.length}\n${
      namespaceIds.map((value) => `${encoder.encode(value).length}:${value}`)
        .join("\n")
    }`,
  );
}

export function fingerprintRequiredArtifactNamespaces(
  namespaceIds: readonly string[],
): Uint8Array {
  return sha256(namespacePreimage(namespaceIds));
}

export function deriveArtifactControlObjectIdV1(input: Readonly<{
  artifactId: string;
  artifactRevision: number;
}>): string {
  assertUuid("Artifact ID", input.artifactId);
  assertPositiveRevision("Artifact revision", input.artifactRevision);
  return `artifact:v1:${bytesToHex(sha256(encoder.encode(
    `${ARTIFACT_OBJECT_ID_DOMAIN}\n${input.artifactId}\n${input.artifactRevision}`,
  )))}`;
}

export function artifactBlobStorageRefV1(blobId: string): string {
  assertUuid("Artifact blob ID", blobId);
  return `${blobId}.artifact-blob-v1`;
}

export type PreparedArtifactCryptoRevision = Readonly<{
  artifactId: string;
  artifactRevision: number;
  blobGeneration: number;
  objectId: string;
  objectType: typeof ARTIFACT_CONTROL_OBJECT_TYPE_V1;
  controlVersion: typeof ARTIFACT_CONTROL_VERSION_V1;
  blobId: string;
  plaintextLength: number;
  ciphertextLength: number;
  ciphertextSha256: Uint8Array;
  chunkPlaintextBytes: typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1;
  chunkCount: number;
  requiredNamespaceIds: readonly string[];
}>;

export type VerifiedArtifactCryptoRevision = Readonly<{
  artifactId: string;
  artifactRevision: number;
  objectId: string;
  accessRevision: number;
  requiredNamespaceIds: readonly string[];
  requiredNamespaceFingerprint: Uint8Array;
}>;

export type ArtifactCryptoRevisionReference = Readonly<{
  artifactId: string;
  artifactRevision: number;
  objectId: string;
  expectedAccessRevision: number;
  expectedRequiredNamespaceFingerprint: Uint8Array;
}>;

export type ArtifactBlobPublicationReference = Readonly<{
  artifactId: string;
  blobId: string;
  blobGeneration: number;
  storageRef: string;
  ciphertextLength: number;
  ciphertextSha256: Uint8Array;
}>;

export type ArtifactPublicationPlanInput = Readonly<{
  operationId: string;
  artifactRowId: string;
  anchorNamespaceId: string;
  operationType: ArtifactPublicationOperationType;
  expectedArtifactRevision: number;
  expectedAccessRevision: number;
  expectedBlobGeneration: number;
  expectedBlobId: string | null;
  expectedRequiredNamespaceFingerprint: Uint8Array | null;
  revision: PreparedArtifactCryptoRevision;
  blob: ArtifactBlobPublicationReference;
  mimeClass: ArtifactMimeClass;
  sizeBucket: ArtifactSizeBucket;
  /** Durable server-issued plan digest stored by the operation row. */
  requestDigest: Uint8Array;
  /** Complete client-signed publication digest stored by the revision row. */
  allocationRequestDigest: Uint8Array;
  requiredNamespaceFingerprint: Uint8Array;
}>;

export type ArtifactPublicationReservationInput = Readonly<{
  operationId: string;
  artifactRowId: string;
  artifactId: string;
  anchorNamespaceId: string;
  operationType: ArtifactPublicationOperationType;
  expectedArtifactRevision: number;
  resultArtifactRevision: number;
  expectedAccessRevision: number;
  resultAccessRevision: 0;
  expectedBlobGeneration: number;
  resultBlobGeneration: number;
  expectedBlobId: string | null;
  resultBlobId: string;
  expectedRequiredNamespaceFingerprint: Uint8Array | null;
  targetRequiredNamespaceFingerprint: Uint8Array;
  planDigest: Uint8Array;
}>;

export type ArtifactPublicationLifecycle = Readonly<{
  operationId: string;
  artifactRowId: string;
  artifactId: string;
  anchorNamespaceId: string;
  operationType: ArtifactPublicationOperationType;
  expectedArtifactRevision: number;
  resultArtifactRevision: number;
  expectedAccessRevision: number;
  resultAccessRevision: 0;
  expectedBlobGeneration: number;
  resultBlobGeneration: number;
  expectedBlobId: string | null;
  resultBlobId: string;
  expectedRequiredNamespaceFingerprint: Uint8Array | null;
  cryptoObjectId: string;
  blob: ArtifactBlobPublicationReference;
  mimeClass: ArtifactMimeClass;
  sizeBucket: ArtifactSizeBucket;
  requestDigest: Uint8Array;
  allocationRequestDigest: Uint8Array;
  requiredNamespaceFingerprint: Uint8Array;
  completion: "pending" | "complete";
  disposition: "active" | "complete" | "blocked" | "quarantined";
  attemptCount: number;
  failureCode: string | null;
}>;

export type ArtifactProductReserveResult =
  | Readonly<{ status: "allocated" | "replayed"; lifecycle: ArtifactPublicationLifecycle }>
  | Readonly<{ status: "conflict" }>;

export type ArtifactProductPublishResult =
  | "applied"
  | "duplicate"
  | "stale"
  | "conflict";

export interface ArtifactProductPublicationPort {
  reserve(input: ArtifactPublicationPlanInput): Promise<ArtifactProductReserveResult>;
  publish(input: Readonly<{
    lifecycle: ArtifactPublicationLifecycle;
    verified: VerifiedArtifactCryptoRevision;
    targetLifecycleState: "active" | "archived";
  }>): Promise<ArtifactProductPublishResult>;
  read(operationId: string): Promise<ArtifactPublicationLifecycle | null>;
  recordFailure(input: Readonly<{
    operationId: string;
    requestDigest: Uint8Array;
    disposition: "blocked" | "quarantined";
    failureCode: "blob_unavailable" | "blob_mismatch" | "crypto_incomplete" | "crypto_mismatch";
  }>): Promise<void>;
}

export interface AtomicArtifactCryptoCompletionPort {
  complete(
    revision: PreparedArtifactCryptoRevision,
  ): Promise<"created" | "duplicate">;
  verify(
    reference: ArtifactCryptoRevisionReference,
  ): Promise<VerifiedArtifactCryptoRevision | null>;
}

export interface ArtifactBlobVerificationPort {
  inspectStored(
    reference: Pick<
      ArtifactBlobPublicationReference,
      | "artifactId"
      | "blobId"
      | "blobGeneration"
      | "ciphertextLength"
      | "ciphertextSha256"
    >,
  ): Promise<
    | Readonly<{
      status: "exact";
      reference: Readonly<{
        plaintextLength: number;
        chunkCount: number;
      }>;
    }>
    | Readonly<{ status: "missing" | "mismatch" }>
  >;
}

export function assertPreparedArtifactCryptoRevision(
  value: PreparedArtifactCryptoRevision,
): void {
  assertUuid("Artifact ID", value.artifactId);
  assertUuid("Artifact blob ID", value.blobId);
  assertPositiveRevision("Artifact revision", value.artifactRevision);
  assertPositiveRevision("Artifact blob generation", value.blobGeneration);
  if (
    value.objectId !== deriveArtifactControlObjectIdV1(value)
    || value.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
    || value.controlVersion !== ARTIFACT_CONTROL_VERSION_V1
    || value.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1
  ) {
    throw new Error("Prepared Artifact crypto coordinates are not canonical");
  }
  if (
    !Number.isSafeInteger(value.plaintextLength)
    || value.plaintextLength < 0
    || value.plaintextLength > ARTIFACT_PLAINTEXT_MAX_BYTES_V1
    || !Number.isSafeInteger(value.ciphertextLength)
    || value.ciphertextLength < 1
  ) throw new RangeError("Prepared Artifact blob lengths are invalid");
  const expectedChunkCount = Math.max(
    1,
    Math.ceil(value.plaintextLength / value.chunkPlaintextBytes),
  );
  if (value.chunkCount !== expectedChunkCount) {
    throw new Error("Prepared Artifact chunk count is invalid");
  }
  assertDigest("Artifact ciphertext SHA-256", value.ciphertextSha256);
  fingerprintRequiredArtifactNamespaces(value.requiredNamespaceIds);
}

export function artifactPublicationRequestDigest(
  input: Omit<
    ArtifactPublicationPlanInput,
    "requestDigest" | "allocationRequestDigest"
  >,
): Uint8Array {
  assertArtifactPublicationPlan({
    ...input,
    requestDigest: new Uint8Array(32),
    allocationRequestDigest: new Uint8Array(32),
  });
  const namespaceFingerprint = bytesToHex(input.requiredNamespaceFingerprint);
  const ciphertextHash = bytesToHex(input.blob.ciphertextSha256);
  return sha256(encoder.encode([
    "nautilo/artifact-publication-request/v1",
    input.operationId,
    input.artifactRowId,
    input.anchorNamespaceId,
    input.operationType,
    input.expectedArtifactRevision,
    input.expectedAccessRevision,
    input.expectedBlobGeneration,
    input.expectedBlobId ?? "",
    input.expectedRequiredNamespaceFingerprint === null
      ? ""
      : bytesToHex(input.expectedRequiredNamespaceFingerprint),
    input.revision.artifactId,
    input.revision.artifactRevision,
    input.revision.objectId,
    input.revision.blobId,
    input.revision.blobGeneration,
    input.revision.plaintextLength,
    input.revision.chunkCount,
    input.revision.ciphertextLength,
    bytesToHex(input.revision.ciphertextSha256),
    input.blob.storageRef,
    input.blob.ciphertextLength,
    ciphertextHash,
    input.mimeClass,
    input.sizeBucket,
    namespaceFingerprint,
  ].join("\n")));
}

export function artifactPublicationReservationDigest(
  input: Omit<ArtifactPublicationReservationInput, "planDigest">,
): Uint8Array {
  return sha256(encoder.encode([
    "nautilo/artifact-publication-plan/v1",
    input.operationId,
    input.artifactRowId,
    input.artifactId,
    input.anchorNamespaceId,
    input.operationType,
    input.expectedArtifactRevision,
    input.resultArtifactRevision,
    input.expectedAccessRevision,
    input.resultAccessRevision,
    input.expectedBlobGeneration,
    input.resultBlobGeneration,
    input.expectedBlobId ?? "",
    input.resultBlobId,
    input.expectedRequiredNamespaceFingerprint === null
      ? ""
      : bytesToHex(input.expectedRequiredNamespaceFingerprint),
    bytesToHex(input.targetRequiredNamespaceFingerprint),
  ].join("\n")));
}

export function assertArtifactPublicationPlan(
  input: ArtifactPublicationPlanInput,
): void {
  assertPortableId("Artifact publication operation ID", input.operationId);
  assertUuid("Artifact internal row ID", input.artifactRowId);
  assertUuid("Artifact anchor Namespace ID", input.anchorNamespaceId);
  assertPreparedArtifactCryptoRevision(input.revision);
  assertNonnegativeRevision(
    "Expected Artifact revision",
    input.expectedArtifactRevision,
  );
  if (input.expectedBlobId !== null) {
    assertUuid("Expected Artifact blob ID", input.expectedBlobId);
  }
  if (input.expectedRequiredNamespaceFingerprint !== null) {
    assertDigest(
      "Expected Artifact required Namespace fingerprint",
      input.expectedRequiredNamespaceFingerprint,
    );
  }
  assertNonnegativeRevision(
    "Expected Artifact access revision",
    input.expectedAccessRevision,
  );
  assertNonnegativeRevision(
    "Expected Artifact blob generation",
    input.expectedBlobGeneration,
  );
  if (!ARTIFACT_MIME_CLASSES.includes(input.mimeClass)) {
    throw new TypeError("Artifact MIME class is invalid");
  }
  if (!ARTIFACT_SIZE_BUCKETS.includes(input.sizeBucket)) {
    throw new TypeError("Artifact size bucket is invalid");
  }
  if (
    artifactSizeBucketForPlaintextLength(input.revision.plaintextLength)
      !== input.sizeBucket
  ) throw new Error("Artifact size bucket disagrees with plaintext length");
  if (
    input.blob.artifactId !== input.revision.artifactId
    || input.blob.blobId !== input.revision.blobId
    || input.blob.blobGeneration !== input.revision.blobGeneration
    || input.blob.ciphertextLength !== input.revision.ciphertextLength
    || bytesToHex(input.blob.ciphertextSha256)
      !== bytesToHex(input.revision.ciphertextSha256)
  ) throw new Error("Artifact blob and control coordinates disagree");
  if (input.blob.storageRef !== artifactBlobStorageRefV1(input.blob.blobId)) {
    throw new Error("Artifact blob storage reference is not canonical");
  }
  assertDigest("Artifact request digest", input.requestDigest);
  assertDigest(
    "Artifact allocation request digest",
    input.allocationRequestDigest,
  );
  assertDigest(
    "Artifact required Namespace fingerprint",
    input.requiredNamespaceFingerprint,
  );
  if (
    bytesToHex(fingerprintRequiredArtifactNamespaces(
      input.revision.requiredNamespaceIds,
    )) !== bytesToHex(input.requiredNamespaceFingerprint)
  ) throw new Error("Artifact required Namespace fingerprint disagrees");
  if (!input.revision.requiredNamespaceIds.includes(input.anchorNamespaceId)) {
    throw new Error("Artifact anchor Namespace is outside the required set");
  }
  const revision = input.revision.artifactRevision;
  const generation = input.revision.blobGeneration;
  const shapeValid = input.operationType === "create"
    ? input.expectedArtifactRevision === 0
      && revision === 1
      && input.expectedAccessRevision === 0
      && input.expectedBlobGeneration === 0
      && input.expectedBlobId === null
      && input.expectedRequiredNamespaceFingerprint === null
      && generation === 1
    : input.operationType === "content"
    ? input.expectedArtifactRevision > 0
      && revision === input.expectedArtifactRevision + 1
      && input.expectedBlobGeneration > 0
      && input.expectedBlobId !== null
      && input.expectedRequiredNamespaceFingerprint !== null
      && bytesToHex(input.expectedRequiredNamespaceFingerprint)
        === bytesToHex(input.requiredNamespaceFingerprint)
      && input.expectedBlobId !== input.revision.blobId
      && generation === input.expectedBlobGeneration + 1
    : input.expectedArtifactRevision > 0
      && revision === input.expectedArtifactRevision + 1
      && input.expectedBlobGeneration > 0
      && input.expectedBlobId === input.revision.blobId
      && input.expectedRequiredNamespaceFingerprint !== null
      && bytesToHex(input.expectedRequiredNamespaceFingerprint)
        === bytesToHex(input.requiredNamespaceFingerprint)
      && generation === input.expectedBlobGeneration;
  if (!shapeValid) throw new Error("Artifact publication revision shape is invalid");
}

export function assertArtifactPublicationReservation(
  input: ArtifactPublicationReservationInput,
): void {
  assertPortableId("Artifact publication operation ID", input.operationId);
  assertUuid("Artifact internal row ID", input.artifactRowId);
  assertUuid("Artifact ID", input.artifactId);
  assertUuid("Artifact anchor Namespace ID", input.anchorNamespaceId);
  assertNonnegativeRevision("Expected Artifact revision", input.expectedArtifactRevision);
  assertPositiveRevision("Result Artifact revision", input.resultArtifactRevision);
  assertNonnegativeRevision("Expected Artifact access revision", input.expectedAccessRevision);
  if (input.resultAccessRevision !== 0) {
    throw new TypeError("Artifact reservation result access revision must be zero");
  }
  assertNonnegativeRevision("Expected Artifact blob generation", input.expectedBlobGeneration);
  assertPositiveRevision("Result Artifact blob generation", input.resultBlobGeneration);
  if (input.expectedBlobId !== null) assertUuid("Expected Artifact blob ID", input.expectedBlobId);
  assertUuid("Result Artifact blob ID", input.resultBlobId);
  if (input.expectedRequiredNamespaceFingerprint !== null) {
    assertDigest(
      "Expected Artifact Namespace fingerprint",
      input.expectedRequiredNamespaceFingerprint,
    );
  }
  assertDigest(
    "Target Artifact Namespace fingerprint",
    input.targetRequiredNamespaceFingerprint,
  );
  assertDigest("Artifact plan digest", input.planDigest);
  if (
    input.resultArtifactRevision !== input.expectedArtifactRevision + 1
    || (input.operationType === "create" && (
      input.expectedArtifactRevision !== 0
      || input.expectedAccessRevision !== 0
      || input.expectedBlobGeneration !== 0
      || input.resultBlobGeneration !== 1
      || input.expectedBlobId !== null
      || input.expectedRequiredNamespaceFingerprint !== null
    ))
    || (input.operationType === "content" && (
      input.expectedArtifactRevision < 1
      || input.expectedBlobGeneration < 1
      || input.expectedBlobId === null
      || input.resultBlobGeneration !== input.expectedBlobGeneration + 1
      || input.resultBlobId === input.expectedBlobId
      || input.expectedRequiredNamespaceFingerprint === null
    ))
    || (input.operationType === "control" && (
      input.expectedArtifactRevision < 1
      || input.expectedBlobGeneration < 1
      || input.expectedBlobId === null
      || input.resultBlobGeneration !== input.expectedBlobGeneration
      || input.resultBlobId !== input.expectedBlobId
      || input.expectedRequiredNamespaceFingerprint === null
    ))
  ) throw new TypeError("Artifact publication reservation coordinates disagree");
}

export function artifactCryptoRevisionReference(
  lifecycle: Pick<
    ArtifactPublicationLifecycle,
    | "artifactId"
    | "resultArtifactRevision"
    | "cryptoObjectId"
    | "resultAccessRevision"
    | "requiredNamespaceFingerprint"
  >,
): ArtifactCryptoRevisionReference {
  return Object.freeze({
    artifactId: lifecycle.artifactId,
    artifactRevision: lifecycle.resultArtifactRevision,
    objectId: lifecycle.cryptoObjectId,
    expectedAccessRevision: lifecycle.resultAccessRevision,
    expectedRequiredNamespaceFingerprint:
      lifecycle.requiredNamespaceFingerprint.slice(),
  });
}
