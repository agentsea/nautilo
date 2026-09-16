import { DURABLE_RECORD_PAGE_LIMIT_MAX } from "../persistence/repository";

/**
 * Complete Wave-6 V1 per-call contract. These limits bound work and disclosure,
 * never retained graph depth, Record count, hierarchy height, or history.
 */
export const RECORD_SEARCH_POLICY_V1 = Object.freeze({
  policyVersion: 1 as const,
  projectionVersion: 1 as const,
  embeddingContractVersion: 1 as const,
  referenceIdentifierMinimumUtf8Bytes: 1,
  referenceIdentifierMaximumUtf8Bytes: 128,
  providerIdentifierMinimumUtf8Bytes: 1,
  providerIdentifierMaximumUtf8Bytes: 256,
  canonicalModelIdentifierMinimumUtf8Bytes: 1,
  canonicalModelIdentifierMaximumUtf8Bytes: 256,
  embeddingDimensions: 1_536 as const,
  /** In-memory varlena datum: 4-byte header + dim/unused + float32 values. */
  pgvectorPayloadBytes: 6_152,
  /** TOAST external payload / vector_send: dim/unused + float32 values. */
  pgvectorExternalPayloadBytes: 6_148,
  queryMinimumUtf8Bytes: 1,
  queryMaximumUtf8Bytes: 4 * 1_024,
  /** Existing Wave-15 content-embedding input bound used for Record statements. */
  recordStatementMaximumUtf8Bytes: 64 * 1_024,
  resultPageMinimum: 1,
  resultPageMaximum: 64,
  exactScanStatementTimeoutMilliseconds: 5_000,
  traversalWorkMaximum: 4_096,
  evidenceAdditionalDepthMaximum: 1,
  openedRecordPayloadBytesMaximum: 4 * 1_024 * 1_024,
  returnedBytesMaximum: 256 * 1_024,
  searchContinuationBytesMaximum: 4 * 1_024,
  evidenceContinuationBytesMaximum: 64 * 1_024,
  graphPageMaximum: DURABLE_RECORD_PAGE_LIMIT_MAX,
  /** Acceptance tolerance around the mathematical cosine range after float32 conversion. */
  cosineScoreTolerance: 1e-6,
});

export type RecordSearchPolicyV1 = typeof RECORD_SEARCH_POLICY_V1;
