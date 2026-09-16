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
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ARTIFACT_BLOB_DEK_BYTES_V1,
  ARTIFACT_BLOB_MAX_CHUNKS_V1,
  ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
  ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
  deriveArtifactBlobChunkCountV1,
} from "./blob-v1.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const ARTIFACT_CONTROL_FORMAT_VERSION_V1 = 1 as const;
export const ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1 = 4_096;
export const ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1 = 256;

const CONTROL_DOMAIN = "nautilo/artifact-control/v1";
const HASH_BYTES = 32;
const MAX_ID_BYTES = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ArtifactControlV1 {
  readonly formatVersion: typeof ARTIFACT_CONTROL_FORMAT_VERSION_V1;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly blobGeneration: number;
  readonly blobDek: Uint8Array;
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly plaintextLength: number;
  readonly plaintextSha256: Uint8Array;
  readonly blobId: string;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
  readonly chunkPlaintextBytes:
    typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1;
  readonly chunkCount: number;
}

function exactUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function exactCounter(label: string, value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new RangeError(`${label} is outside its supported range`);
  return value;
}

function exactBytes(label: string, value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function normalizedText(label: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFC");
  const bytes = utf8V2(normalized);
  try {
    if (bytes.length < 1 || bytes.length > maximum) {
      throw new RangeError(`${label} exceeds its UTF-8 bytes bound`);
    }
  } finally {
    bytes.fill(0);
  }
  return normalized;
}

function normalizeLogicalPath(value: unknown): string {
  const text = normalizedText(
    "Artifact logical path",
    value,
    ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1,
  );
  if (text.startsWith("/") || text.includes("\\") || text.includes("\0")) {
    throw new TypeError("Artifact logical path must be a relative path");
  }
  const segments = text.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0
    || segments.some((segment) => segment === "." || segment === "..")
  ) throw new TypeError("Artifact logical path must be a relative path");
  const normalized = segments.join("/").normalize("NFC");
  const bytes = utf8V2(normalized);
  try {
    if (bytes.length > ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1) {
      throw new RangeError("Artifact logical path exceeds its UTF-8 bytes bound");
    }
  } finally {
    bytes.fill(0);
  }
  return normalized;
}

function normalizeMimeType(value: unknown): string {
  const mime = normalizedText(
    "Artifact MIME type",
    value,
    ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1,
  ).trim().toLowerCase();
  const containsControl = [...mime].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
  if (
    mime.length === 0
    || !mime.includes("/")
    || containsControl
  ) throw new TypeError("Artifact MIME type is invalid");
  return mime;
}

function normalizeControl(value: ArtifactControlV1): ArtifactControlV1 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Artifact control must be an object");
  }
  const expectedFields = [
    "artifactId",
    "artifactRevision",
    "blobDek",
    "blobGeneration",
    "blobId",
    "chunkCount",
    "chunkPlaintextBytes",
    "ciphertextLength",
    "ciphertextSha256",
    "formatVersion",
    "logicalPath",
    "mimeType",
    "plaintextLength",
    "plaintextSha256",
  ].sort();
  const actualFields = Object.keys(value).sort();
  if (
    actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])
  ) throw new TypeError("Artifact control fields must be exact");
  if (value.formatVersion !== ARTIFACT_CONTROL_FORMAT_VERSION_V1) {
    throw new TypeError("Artifact control format version is unsupported");
  }
  if (value.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1) {
    throw new TypeError("Artifact control chunk plaintext size is unsupported");
  }
  const plaintextLength = exactCounter(
    "Artifact control plaintext length",
    value.plaintextLength,
    0,
    ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
  );
  const chunkCount = exactCounter(
    "Artifact control chunk count",
    value.chunkCount,
    1,
    ARTIFACT_BLOB_MAX_CHUNKS_V1,
  );
  if (chunkCount !== deriveArtifactBlobChunkCountV1(plaintextLength)) {
    throw new TypeError("Artifact control chunk count disagrees with plaintext length");
  }
  let blobDek: Uint8Array | undefined;
  let plaintextSha256: Uint8Array | undefined;
  let ciphertextSha256: Uint8Array | undefined;
  try {
    blobDek = exactBytes("Artifact control blob DEK", value.blobDek, ARTIFACT_BLOB_DEK_BYTES_V1);
    plaintextSha256 = exactBytes("Artifact control plaintext SHA-256", value.plaintextSha256, HASH_BYTES);
    ciphertextSha256 = exactBytes("Artifact control ciphertext SHA-256", value.ciphertextSha256, HASH_BYTES);
    return Object.freeze({
      formatVersion: ARTIFACT_CONTROL_FORMAT_VERSION_V1,
      artifactId: exactUuid("Artifact id", value.artifactId),
      artifactRevision: exactCounter("Artifact revision", value.artifactRevision, 1, Number.MAX_SAFE_INTEGER),
      blobGeneration: exactCounter("Artifact blob generation", value.blobGeneration, 1, Number.MAX_SAFE_INTEGER),
      blobDek,
      logicalPath: normalizeLogicalPath(value.logicalPath),
      mimeType: normalizeMimeType(value.mimeType),
      plaintextLength,
      plaintextSha256,
      blobId: exactUuid("Artifact blob id", value.blobId),
      ciphertextLength: exactCounter(
        "Artifact ciphertext length",
        value.ciphertextLength,
        1,
        ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
      ),
      ciphertextSha256,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount,
    });
  } catch (cause) {
    blobDek?.fill(0);
    plaintextSha256?.fill(0);
    ciphertextSha256?.fill(0);
    throw cause;
  }
}

export function encodeArtifactControlV1(value: ArtifactControlV1): Uint8Array {
  const control = normalizeControl(value);
  try {
    return concatV2(
      frameText(CONTROL_DOMAIN),
      encodeU32(control.formatVersion),
      frameText(control.artifactId),
      encodeU64(control.artifactRevision),
      encodeU64(control.blobGeneration),
      frame(control.blobDek),
      frameText(control.logicalPath),
      frameText(control.mimeType),
      encodeU64(control.plaintextLength),
      frame(control.plaintextSha256),
      frameText(control.blobId),
      encodeU64(control.ciphertextLength),
      frame(control.ciphertextSha256),
      encodeU32(control.chunkPlaintextBytes),
      encodeU32(control.chunkCount),
    );
  } finally {
    control.blobDek.fill(0);
    control.plaintextSha256.fill(0);
    control.ciphertextSha256.fill(0);
  }
}

export function decodeArtifactControlV1(bytes: Uint8Array): ArtifactControlV1 {
  return decodeExact(bytes, (reader) => {
    if (reader.readText(CONTROL_DOMAIN.length) !== CONTROL_DOMAIN) {
      throw new CanonicalDecodingError("Artifact control domain is unsupported");
    }
    reader.readVersion(ARTIFACT_CONTROL_FORMAT_VERSION_V1);
    const artifactId = reader.readText(MAX_ID_BYTES);
    const artifactRevision = reader.readU64();
    const blobGeneration = reader.readU64();
    const blobDek = reader.readFrame(ARTIFACT_BLOB_DEK_BYTES_V1);
    const logicalPath = reader.readText(
      ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1,
    );
    const mimeType = reader.readText(ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1);
    const plaintextLength = reader.readU64();
    const plaintextSha256 = reader.readFrame(HASH_BYTES);
    const blobId = reader.readText(MAX_ID_BYTES);
    const ciphertextLength = reader.readU64();
    const ciphertextSha256 = reader.readFrame(HASH_BYTES);
    const chunkPlaintextBytes = reader.readU32();
    const chunkCount = reader.readCount(ARTIFACT_BLOB_MAX_CHUNKS_V1);
    if (chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1) {
      throw new CanonicalDecodingError(
        "Artifact control chunk plaintext size is unsupported",
      );
    }
    const value: ArtifactControlV1 = {
      formatVersion: ARTIFACT_CONTROL_FORMAT_VERSION_V1,
      artifactId,
      artifactRevision,
      blobGeneration,
      blobDek,
      logicalPath,
      mimeType,
      plaintextLength,
      plaintextSha256,
      blobId,
      ciphertextLength,
      ciphertextSha256,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount,
    };
    let control: ArtifactControlV1;
    try {
      control = normalizeControl(value);
    } catch (cause) {
      throw new CanonicalDecodingError(
        cause instanceof Error ? cause.message : "Artifact control is invalid",
      );
    } finally {
      value.blobDek.fill(0);
      value.plaintextSha256.fill(0);
      value.ciphertextSha256.fill(0);
    }
    reader.assertFinished();
    const canonical = encodeArtifactControlV1(control);
    try {
      if (
        canonical.length !== bytes.length
        || canonical.some((byte, index) => byte !== bytes[index])
      ) {
        control.blobDek.fill(0);
        control.plaintextSha256.fill(0);
        control.ciphertextSha256.fill(0);
        throw new CanonicalDecodingError("Artifact control bytes are noncanonical");
      }
    } finally {
      canonical.fill(0);
    }
    return control;
  });
}

export function wipeArtifactControlV1(value: ArtifactControlV1): void {
  value.blobDek.fill(0);
  value.plaintextSha256.fill(0);
  value.ciphertextSha256.fill(0);
}
