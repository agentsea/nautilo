import type { RecordRef } from "../contracts/hierarchy";
import type {
  RecordEvidenceContinuationToken,
  RecordSearchContinuationToken,
} from "./contracts";
import { RECORD_SEARCH_POLICY_V1 } from "./policy";
import { canonicalizeCosineScore } from "./ranking";
import {
  assertOpaqueCommitment,
  assertPortableRecordSearchIdentifier,
  strictUtf8ByteLength,
} from "./validation";

export interface RecordSearchRankPositionV1 {
  /** The last emitted eligible Record only; hidden Record IDs are forbidden. */
  readonly recordRef: RecordRef;
  readonly score: number;
  readonly structuralHeight: number;
}
export interface RecordSearchContinuationStateV1 {
  readonly version: 1;
  readonly policyVersion: typeof RECORD_SEARCH_POLICY_V1.policyVersion;
  readonly queryCommitment: string;
  readonly invocationAudienceCommitment: string;
  readonly repositorySelectionCommitment: string;
  /** Binds processing, projection, payload representation, and authority generations. */
  readonly corpusStateCommitment: string;
  readonly lastEligiblePosition: RecordSearchRankPositionV1;
}

export interface RecordEvidenceContinuationStateV1 {
  readonly version: 1;
  readonly policyVersion: typeof RECORD_SEARCH_POLICY_V1.policyVersion;
  readonly rootCommitment: string;
  readonly invocationAudienceCommitment: string;
  readonly repositorySelectionCommitment: string;
  /** Binds Record, payload representation, and authority generations. */
  readonly graphStateCommitment: string;
  /** Opaque sealed traversal state coordinate; never a Record/source handle. */
  readonly traversalCheckpointRef: string;
}

function assertToken(label: string, token: string, maximumBytes: number): void {
  const bytes = strictUtf8ByteLength(token);
  if (bytes < 1 || bytes > maximumBytes) {
    throw new RangeError(`${label} is outside the V1 byte contract`);
  }
}

export function assertRecordSearchContinuationToken(
  token: RecordSearchContinuationToken,
): void {
  assertToken(
    "Record search continuation",
    token,
    RECORD_SEARCH_POLICY_V1.searchContinuationBytesMaximum,
  );
}

export function assertRecordEvidenceContinuationToken(
  token: RecordEvidenceContinuationToken,
): void {
  assertToken(
    "Record evidence continuation",
    token,
    RECORD_SEARCH_POLICY_V1.evidenceContinuationBytesMaximum,
  );
}

export function assertRecordSearchContinuationStateV1(
  state: RecordSearchContinuationStateV1,
): void {
  if (state.version !== 1 || state.policyVersion !== RECORD_SEARCH_POLICY_V1.policyVersion) {
    throw new TypeError("Record search continuation version is incompatible");
  }
  for (const [label, value] of [
    ["query commitment", state.queryCommitment],
    ["invocation audience commitment", state.invocationAudienceCommitment],
    ["repository selection commitment", state.repositorySelectionCommitment],
    ["corpus state commitment", state.corpusStateCommitment],
  ] as const) assertOpaqueCommitment(label, value);
  assertPortableRecordSearchIdentifier(
    "last eligible Record reference",
    state.lastEligiblePosition.recordRef,
  );
  canonicalizeCosineScore(state.lastEligiblePosition.score);
  if (
    !Number.isSafeInteger(state.lastEligiblePosition.structuralHeight)
    || state.lastEligiblePosition.structuralHeight < 0
  ) throw new RangeError("last eligible structural height is invalid");
}

export function assertRecordEvidenceContinuationStateV1(
  state: RecordEvidenceContinuationStateV1,
): void {
  if (state.version !== 1 || state.policyVersion !== RECORD_SEARCH_POLICY_V1.policyVersion) {
    throw new TypeError("Record evidence continuation version is incompatible");
  }
  for (const [label, value] of [
    ["root commitment", state.rootCommitment],
    ["invocation audience commitment", state.invocationAudienceCommitment],
    ["repository selection commitment", state.repositorySelectionCommitment],
    ["graph state commitment", state.graphStateCommitment],
    ["traversal checkpoint reference", state.traversalCheckpointRef],
  ] as const) assertOpaqueCommitment(label, value);
}
