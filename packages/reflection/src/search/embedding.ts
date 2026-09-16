import type { RecordRef } from "../contracts/hierarchy";
import { RECORD_SEARCH_POLICY_V1 } from "./policy";
import {
  assertPortableRecordSearchIdentifier,
  assertPortableRecordSearchText,
  assertPositiveSafeInteger,
  strictUtf8ByteLength,
} from "./validation";

export interface RecordEmbeddingProvenanceV1 {
  readonly provider: string;
  readonly canonicalModel: string;
  readonly dimensions: typeof RECORD_SEARCH_POLICY_V1.embeddingDimensions;
  readonly contractVersion: typeof RECORD_SEARCH_POLICY_V1.embeddingContractVersion;
}

export interface RecordEmbeddingV1 {
  readonly provenance: RecordEmbeddingProvenanceV1;
  /** Canonical float32 values represented as immutable JavaScript numbers. */
  readonly vector: readonly number[];
}

export type RecordEmbeddingPurpose =
  | "record.statement_embedding"
  | "record.query_embedding";

export interface RecordEmbeddingRequest {
  readonly purpose: RecordEmbeddingPurpose;
  readonly plaintext: string;
  readonly signal?: AbortSignal;
}

export type RecordEmbeddingUnavailableReason =
  | "provider_unavailable"
  | "invalid_response"
  | "cancelled";

export type RecordEmbeddingResult =
  | { readonly status: "available"; readonly embedding: RecordEmbeddingV1 }
  | { readonly status: "unavailable"; readonly reason: RecordEmbeddingUnavailableReason };

export interface RecordEmbeddingPort {
  embed(input: RecordEmbeddingRequest): Promise<RecordEmbeddingResult>;
}

export interface RecordSearchProjectionV1 {
  readonly recordRef: RecordRef;
  readonly recordProcessingGeneration: number;
  readonly projectionVersion: typeof RECORD_SEARCH_POLICY_V1.projectionVersion;
  readonly projectionGeneration: number;
  readonly embedding: RecordEmbeddingV1;
}

export function assertRecordEmbeddingRequest(input: RecordEmbeddingRequest): void {
  if (
    input.purpose !== "record.statement_embedding"
    && input.purpose !== "record.query_embedding"
  ) {
    throw new TypeError("unknown Record embedding purpose");
  }
  const bytes = strictUtf8ByteLength(input.plaintext);
  const maximumBytes = input.purpose === "record.query_embedding"
    ? RECORD_SEARCH_POLICY_V1.queryMaximumUtf8Bytes
    : RECORD_SEARCH_POLICY_V1.recordStatementMaximumUtf8Bytes;
  if (
    bytes < RECORD_SEARCH_POLICY_V1.queryMinimumUtf8Bytes
    || bytes > maximumBytes
  ) {
    throw new RangeError("Record embedding plaintext exceeds the V1 UTF-8 byte contract");
  }
}

export function assertRecordEmbeddingProvenanceV1(
  provenance: RecordEmbeddingProvenanceV1,
): void {
  assertPortableRecordSearchText(
    "embedding provider",
    provenance.provider,
    RECORD_SEARCH_POLICY_V1.providerIdentifierMinimumUtf8Bytes,
    RECORD_SEARCH_POLICY_V1.providerIdentifierMaximumUtf8Bytes,
  );
  assertPortableRecordSearchText(
    "canonical embedding model",
    provenance.canonicalModel,
    RECORD_SEARCH_POLICY_V1.canonicalModelIdentifierMinimumUtf8Bytes,
    RECORD_SEARCH_POLICY_V1.canonicalModelIdentifierMaximumUtf8Bytes,
  );
  if (
    provenance.dimensions !== RECORD_SEARCH_POLICY_V1.embeddingDimensions
    || provenance.contractVersion !== RECORD_SEARCH_POLICY_V1.embeddingContractVersion
  ) {
    throw new TypeError("Record embedding provenance is incompatible with V1");
  }
}

export function canonicalizeRecordEmbeddingV1(
  vector: ArrayLike<number>,
): readonly number[] {
  if (vector.length !== RECORD_SEARCH_POLICY_V1.embeddingDimensions) {
    throw new RangeError(
      `Record embedding must contain exactly ${RECORD_SEARCH_POLICY_V1.embeddingDimensions} elements`,
    );
  }
  const canonical = new Array<number>(RECORD_SEARCH_POLICY_V1.embeddingDimensions);
  let nonZero = false;
  for (let index = 0; index < vector.length; index += 1) {
    const input = vector[index];
    if (input === undefined || !Number.isFinite(input)) {
      throw new TypeError("Record embedding elements must be finite numbers");
    }
    const value = Math.fround(input);
    if (!Number.isFinite(value)) {
      throw new TypeError("Record embedding overflows float32");
    }
    canonical[index] = value;
    if (value !== 0) nonZero = true;
  }
  if (!nonZero) throw new RangeError("Record embedding must have non-zero norm");
  return Object.freeze(canonical);
}

export function assertCanonicalRecordEmbeddingV1(embedding: RecordEmbeddingV1): void {
  assertRecordEmbeddingProvenanceV1(embedding.provenance);
  const canonical = canonicalizeRecordEmbeddingV1(embedding.vector);
  for (let index = 0; index < canonical.length; index += 1) {
    if (!Object.is(canonical[index], embedding.vector[index])) {
      throw new TypeError("Record embedding vector is not canonical float32");
    }
  }
}

export function validateRecordSearchProjectionV1(
  projection: RecordSearchProjectionV1,
): void {
  assertPortableRecordSearchIdentifier("Record reference", projection.recordRef);
  assertPositiveSafeInteger(
    "Record processing generation",
    projection.recordProcessingGeneration,
  );
  assertPositiveSafeInteger("projection generation", projection.projectionGeneration);
  if (projection.projectionVersion !== RECORD_SEARCH_POLICY_V1.projectionVersion) {
    throw new TypeError("Record search projection version is incompatible with V1");
  }
  assertCanonicalRecordEmbeddingV1(projection.embedding);
}

export function recordEmbeddingProvenanceMatches(
  left: RecordEmbeddingProvenanceV1,
  right: RecordEmbeddingProvenanceV1,
): boolean {
  return left.provider === right.provider
    && left.canonicalModel === right.canonicalModel
    && left.dimensions === right.dimensions
    && left.contractVersion === right.contractVersion;
}
