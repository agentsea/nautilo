import type { LatticeCrypto } from "../crypto/index.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const ARTIFACT_BLOB_FORMAT_VERSION_V1 = 1 as const;
export const ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 = 1_048_576;
export const ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1 = 104_857_600;
export const ARTIFACT_BLOB_MAX_CHUNKS_V1 = 100;
export const ARTIFACT_BLOB_DEK_BYTES_V1 = 32;

const BLOB_DOMAIN = "nautilo/artifact-blob/v1";
const CHUNK_AAD_DOMAIN = "nautilo/artifact-blob-chunk/v1";
const XCHACHA_OVERHEAD_BYTES = 24 + 16;
const MAX_ID_BYTES = 128;
const MAX_HEADER_BYTES = 512;
export const ARTIFACT_BLOB_MAX_FILE_BYTES_V1 =
  ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1
  + ARTIFACT_BLOB_MAX_CHUNKS_V1 * (4 + XCHACHA_OVERHEAD_BYTES)
  + MAX_HEADER_BYTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ArtifactBlobHeaderV1 {
  readonly formatVersion: typeof ARTIFACT_BLOB_FORMAT_VERSION_V1;
  readonly artifactId: string;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly plaintextLength: number;
  readonly chunkPlaintextBytes:
    typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1;
  readonly chunkCount: number;
}

export interface SealArtifactBlobChunkInputV1 {
  readonly header: ArtifactBlobHeaderV1;
  readonly blobDek: Uint8Array;
  readonly chunkIndex: number;
  readonly plaintextChunk: Uint8Array;
}

export interface OpenArtifactBlobChunkInputV1 {
  readonly header: ArtifactBlobHeaderV1;
  readonly blobDek: Uint8Array;
  readonly chunkIndex: number;
  readonly sealedChunk: Uint8Array;
}

function exactFields(label: string, value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (
    actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])
  ) throw new TypeError(`${label} fields must be exact`);
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

export function deriveArtifactBlobChunkCountV1(plaintextLength: number): number {
  exactCounter(
    "Artifact blob plaintext length",
    plaintextLength,
    0,
    ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
  );
  return Math.max(
    1,
    Math.ceil(plaintextLength / ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1),
  );
}

export function artifactBlobSealedChunkBytesV1(
  plaintextChunkBytes: number,
): number {
  return exactCounter(
    "Artifact blob chunk plaintext length",
    plaintextChunkBytes,
    0,
    ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ) + XCHACHA_OVERHEAD_BYTES;
}

export function generateArtifactBlobDekV1(crypto: LatticeCrypto): Uint8Array {
  const dek = crypto.randomBytes(ARTIFACT_BLOB_DEK_BYTES_V1);
  if (dek.length !== ARTIFACT_BLOB_DEK_BYTES_V1) {
    dek.fill(0);
    throw new TypeError("Generated Artifact blob DEK has an invalid length");
  }
  return dek;
}

export function encodeArtifactBlobChunkFrameV1(
  sealedChunk: Uint8Array,
): Uint8Array {
  if (
    !(sealedChunk instanceof Uint8Array)
    || sealedChunk.length < XCHACHA_OVERHEAD_BYTES
    || sealedChunk.length
      > ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + XCHACHA_OVERHEAD_BYTES
  ) throw new TypeError("Artifact blob sealed chunk length is outside its bound");
  return concatV2(encodeU32(sealedChunk.length), sealedChunk);
}

function normalizeHeader(value: ArtifactBlobHeaderV1): ArtifactBlobHeaderV1 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Artifact blob header must be an object");
  }
  exactFields("Artifact blob header", value, [
    "artifactId",
    "blobGeneration",
    "blobId",
    "chunkCount",
    "chunkPlaintextBytes",
    "formatVersion",
    "plaintextLength",
  ]);
  if (value.formatVersion !== ARTIFACT_BLOB_FORMAT_VERSION_V1) {
    throw new TypeError("Artifact blob format version is unsupported");
  }
  if (value.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1) {
    throw new TypeError("Artifact blob chunk plaintext size is unsupported");
  }
  const plaintextLength = exactCounter(
    "Artifact blob plaintext length",
    value.plaintextLength,
    0,
    ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
  );
  const chunkCount = exactCounter(
    "Artifact blob chunk count",
    value.chunkCount,
    1,
    ARTIFACT_BLOB_MAX_CHUNKS_V1,
  );
  if (chunkCount !== deriveArtifactBlobChunkCountV1(plaintextLength)) {
    throw new TypeError("Artifact blob chunk count disagrees with plaintext length");
  }
  return Object.freeze({
    formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
    artifactId: exactUuid("Artifact id", value.artifactId),
    blobId: exactUuid("Artifact blob id", value.blobId),
    blobGeneration: exactCounter(
      "Artifact blob generation",
      value.blobGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    plaintextLength,
    chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    chunkCount,
  });
}

function headerParts(header: ArtifactBlobHeaderV1): readonly Uint8Array[] {
  return [
    frameText(BLOB_DOMAIN),
    encodeU32(header.formatVersion),
    frameText(header.artifactId),
    frameText(header.blobId),
    encodeU64(header.blobGeneration),
    encodeU64(header.plaintextLength),
    encodeU32(header.chunkPlaintextBytes),
    encodeU32(header.chunkCount),
  ];
}

export function encodeArtifactBlobHeaderV1(value: ArtifactBlobHeaderV1): Uint8Array {
  const header = normalizeHeader(value);
  return concatV2(...headerParts(header));
}

function decodeHeader(reader: StrictDecoder): ArtifactBlobHeaderV1 {
  const domain = reader.readText(BLOB_DOMAIN.length);
  if (domain !== BLOB_DOMAIN) {
    throw new CanonicalDecodingError("Artifact blob domain is unsupported");
  }
  reader.readVersion(ARTIFACT_BLOB_FORMAT_VERSION_V1);
  const artifactId = reader.readText(MAX_ID_BYTES);
  const blobId = reader.readText(MAX_ID_BYTES);
  const blobGeneration = reader.readU64();
  const plaintextLength = reader.readU64();
  const chunkPlaintextBytes = reader.readU32();
  if (chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1) {
    throw new CanonicalDecodingError(
      "Artifact blob chunk plaintext size is unsupported",
    );
  }
  const chunkCount = reader.readCount(ARTIFACT_BLOB_MAX_CHUNKS_V1);
  try {
    return normalizeHeader({
      formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
      artifactId,
      blobId,
      blobGeneration,
      plaintextLength,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount,
    });
  } catch (cause) {
    throw new CanonicalDecodingError(
      cause instanceof Error ? cause.message : "Artifact blob header is invalid",
    );
  }
}

export function decodeArtifactBlobHeaderV1(bytes: Uint8Array): ArtifactBlobHeaderV1 {
  return decodeExact(bytes, decodeHeader);
}

function chunkPlaintextLength(header: ArtifactBlobHeaderV1, chunkIndex: number): number {
  exactCounter("Artifact blob chunk index", chunkIndex, 0, header.chunkCount - 1);
  if (header.plaintextLength === 0) return 0;
  const offset = chunkIndex * header.chunkPlaintextBytes;
  return Math.min(header.chunkPlaintextBytes, header.plaintextLength - offset);
}

function exactDek(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== ARTIFACT_BLOB_DEK_BYTES_V1) {
    throw new TypeError("Artifact blob DEK must be exactly 32 bytes");
  }
  return copyOwnedBytesV2(value);
}

function chunkAad(header: ArtifactBlobHeaderV1, chunkIndex: number): Uint8Array {
  const length = chunkPlaintextLength(header, chunkIndex);
  return concatV2(
    frameText(CHUNK_AAD_DOMAIN),
    frame(encodeArtifactBlobHeaderV1(header)),
    encodeU32(chunkIndex),
    encodeU64(chunkIndex * header.chunkPlaintextBytes),
    encodeU32(length),
  );
}

export function sealArtifactBlobChunkV1(
  crypto: LatticeCrypto,
  input: SealArtifactBlobChunkInputV1,
): Uint8Array {
  const header = normalizeHeader(input.header);
  const expectedLength = chunkPlaintextLength(header, input.chunkIndex);
  if (
    !(input.plaintextChunk instanceof Uint8Array)
    || input.plaintextChunk.length !== expectedLength
  ) throw new TypeError("Artifact blob chunk plaintext length is inexact");
  const key = exactDek(input.blobDek);
  const plaintext = copyOwnedBytesV2(input.plaintextChunk);
  const aad = chunkAad(header, input.chunkIndex);
  try {
    const sealed = crypto.aeadSeal(key, plaintext, aad);
    if (sealed.length !== artifactBlobSealedChunkBytesV1(expectedLength)) {
      sealed.fill(0);
      throw new TypeError("Artifact blob sealed chunk length is inexact");
    }
    return sealed;
  } finally {
    key.fill(0);
    plaintext.fill(0);
    aad.fill(0);
  }
}

export function openArtifactBlobChunkV1(
  crypto: LatticeCrypto,
  input: OpenArtifactBlobChunkInputV1,
): Uint8Array {
  const header = normalizeHeader(input.header);
  const expectedLength = chunkPlaintextLength(header, input.chunkIndex);
  if (
    !(input.sealedChunk instanceof Uint8Array)
    || input.sealedChunk.length !== artifactBlobSealedChunkBytesV1(expectedLength)
  ) throw new TypeError("Artifact blob sealed chunk length is inexact");
  const key = exactDek(input.blobDek);
  const sealed = copyOwnedBytesV2(input.sealedChunk);
  const aad = chunkAad(header, input.chunkIndex);
  try {
    const opened = crypto.aeadOpen(key, sealed, aad);
    if (opened === null || opened.length !== expectedLength) {
      opened?.fill(0);
      throw new Error("Artifact blob chunk authentication failed");
    }
    return opened;
  } finally {
    key.fill(0);
    sealed.fill(0);
    aad.fill(0);
  }
}

export function sealArtifactBlobV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly header: ArtifactBlobHeaderV1;
    readonly blobDek: Uint8Array;
    readonly plaintext: Uint8Array;
  }>,
): Uint8Array {
  const header = normalizeHeader(input.header);
  if (
    !(input.plaintext instanceof Uint8Array)
    || input.plaintext.length !== header.plaintextLength
  ) throw new TypeError("Artifact blob plaintext length disagrees with header");
  const parts: Uint8Array[] = [encodeArtifactBlobHeaderV1(header)];
  try {
    for (let chunkIndex = 0; chunkIndex < header.chunkCount; chunkIndex++) {
      const offset = chunkIndex * header.chunkPlaintextBytes;
      const length = chunkPlaintextLength(header, chunkIndex);
      const sealed = sealArtifactBlobChunkV1(crypto, {
        header,
        blobDek: input.blobDek,
        chunkIndex,
        plaintextChunk: input.plaintext.subarray(offset, offset + length),
      });
      try {
        parts.push(encodeArtifactBlobChunkFrameV1(sealed));
      } finally {
        sealed.fill(0);
      }
    }
    return concatV2(...parts);
  } finally {
    parts.forEach((part) => part.fill(0));
  }
}

function equalHeader(left: ArtifactBlobHeaderV1, right: ArtifactBlobHeaderV1): boolean {
  return left.formatVersion === right.formatVersion
    && left.artifactId === right.artifactId
    && left.blobId === right.blobId
    && left.blobGeneration === right.blobGeneration
    && left.plaintextLength === right.plaintextLength
    && left.chunkPlaintextBytes === right.chunkPlaintextBytes
    && left.chunkCount === right.chunkCount;
}

export function openArtifactBlobRangeV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly fileBytes: Uint8Array;
    readonly blobDek: Uint8Array;
    readonly expected: ArtifactBlobHeaderV1;
    readonly start: number;
    readonly endExclusive: number;
  }>,
): Uint8Array {
  if (
    !(input.fileBytes instanceof Uint8Array)
    || input.fileBytes.length > ARTIFACT_BLOB_MAX_FILE_BYTES_V1
  ) throw new RangeError("Artifact blob file exceeds its supported bound");
  const expected = normalizeHeader(input.expected);
  const start = exactCounter(
    "Artifact blob range start",
    input.start,
    0,
    expected.plaintextLength,
  );
  const endExclusive = exactCounter(
    "Artifact blob range end",
    input.endExclusive,
    start,
    expected.plaintextLength,
  );
  const reader = new StrictDecoder(input.fileBytes);
  const openedChunks: Uint8Array[] = [];
  let succeeded = false;
  try {
    const actual = decodeHeader(reader);
    if (!equalHeader(actual, expected)) {
      throw new TypeError("Artifact blob coordinates disagree with expectation");
    }
    for (let chunkIndex = 0; chunkIndex < actual.chunkCount; chunkIndex++) {
      const plaintextBytes = chunkPlaintextLength(actual, chunkIndex);
      const sealedBytes = reader.readFrame(
        ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + XCHACHA_OVERHEAD_BYTES,
      );
      if (sealedBytes.length !== artifactBlobSealedChunkBytesV1(plaintextBytes)) {
        throw new CanonicalDecodingError("Artifact blob sealed chunk length is inexact");
      }
      const chunkStart = chunkIndex * actual.chunkPlaintextBytes;
      const chunkEnd = chunkStart + plaintextBytes;
      if (
        (actual.plaintextLength === 0 && chunkIndex === 0)
        || (start < chunkEnd && endExclusive > chunkStart)
      ) {
        const opened = openArtifactBlobChunkV1(crypto, {
          header: actual,
          blobDek: input.blobDek,
          chunkIndex,
          sealedChunk: sealedBytes,
        });
        openedChunks.push(opened);
      }
      sealedBytes.fill(0);
    }
    reader.assertFinished();
    const output = new Uint8Array(endExclusive - start);
    let outputOffset = 0;
    const firstChunk = start === endExclusive
      ? 0
      : Math.floor(start / actual.chunkPlaintextBytes);
    openedChunks.forEach((opened, openedIndex) => {
      const chunkIndex = firstChunk + openedIndex;
      const chunkStart = chunkIndex * actual.chunkPlaintextBytes;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(endExclusive, chunkStart + opened.length) - chunkStart;
      output.set(opened.subarray(from, to), outputOffset);
      outputOffset += to - from;
    });
    succeeded = true;
    return output;
  } finally {
    openedChunks.forEach((chunk) => chunk.fill(0));
    reader.destroy(!succeeded);
  }
}
