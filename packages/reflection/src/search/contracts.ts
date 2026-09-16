import type { RecordLifecycle, RecordRef } from "../contracts/hierarchy";
import type { RankedRecordCoordinate } from "./ranking";
import { RECORD_SEARCH_POLICY_V1 } from "./policy";
import {
  assertPortableRecordSearchIdentifier,
  strictUtf8ByteLength,
} from "./validation";

export type RecordSearchContinuationToken = string;
export type RecordEvidenceContinuationToken = string;

export interface RecordSearchRequest {
  readonly query: string;
  readonly limit: number;
  /** Opaque, already-authorized invocation binding; Reflection does not resolve it. */
  readonly searchBindingRef: string;
  readonly continuation?: RecordSearchContinuationToken;
  readonly signal?: AbortSignal;
}

export interface RecordSearchResultV1 {
  readonly recordRef: RecordRef;
  readonly statement: string;
  readonly score: number;
  readonly structuralHeight: number;
  readonly lifecycle: RecordLifecycle;
  readonly directParentRecordRefs: readonly RecordRef[];
  readonly backlinksTruncated: boolean;
}

export type RecordSearchUnavailableReason =
  | "embedding_unavailable"
  | "exact_scan_timeout"
  | "incompatible_projection"
  | "stale_restart"
  | "capacity_exceeded"
  | "integrity_failure";

export type RecordSearchResponse =
  | {
      readonly status: "available";
      readonly results: readonly RecordSearchResultV1[];
      readonly continuation?: RecordSearchContinuationToken;
    }
  | { readonly status: "unavailable"; readonly reason: RecordSearchUnavailableReason };

export interface RecordSearchRankPage {
  /** Complete exact eligible ranking page; never a partial exact scan. */
  readonly coordinates: readonly RankedRecordCoordinate[];
  readonly continuation?: RecordSearchContinuationToken;
}

export interface RecordSearchPort {
  search(input: RecordSearchRequest): Promise<RecordSearchResponse>;
  searchStructural?(input: RecordSearchRequest): Promise<Readonly<{
    status: "available";
    results: readonly Readonly<{
      recordRef: RecordRef;
      score: number;
      structuralHeight: number;
    }>[];
    continuation?: RecordSearchContinuationToken;
  }> | Readonly<{ status: "unavailable"; reason: RecordSearchUnavailableReason }>>;
}

export function assertRecordSearchRequest(input: RecordSearchRequest): void {
  const queryBytes = strictUtf8ByteLength(input.query);
  if (
    queryBytes < RECORD_SEARCH_POLICY_V1.queryMinimumUtf8Bytes
    || queryBytes > RECORD_SEARCH_POLICY_V1.queryMaximumUtf8Bytes
  ) throw new RangeError("Record search query is outside the V1 UTF-8 byte contract");
  if (
    !Number.isSafeInteger(input.limit)
    || input.limit < RECORD_SEARCH_POLICY_V1.resultPageMinimum
    || input.limit > RECORD_SEARCH_POLICY_V1.resultPageMaximum
  ) throw new RangeError("Record search result limit is outside the V1 policy");
  assertPortableRecordSearchIdentifier("Record search binding", input.searchBindingRef);
  if (input.continuation !== undefined) {
    const continuationBytes = strictUtf8ByteLength(input.continuation);
    if (
      continuationBytes < 1
      || continuationBytes > RECORD_SEARCH_POLICY_V1.searchContinuationBytesMaximum
    ) throw new RangeError("Record search continuation is outside the V1 byte contract");
  }
}

export type RecordSearchProjectionMutationResult =
  | { readonly status: "published" | "replaced" | "replayed"; readonly projectionGeneration: number }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid_projection"
        | "generation_conflict"
        | "conflict"
        | "record_unavailable";
    };

export interface RecordSearchProjectionPublishRequest {
  readonly recordRef: RecordRef;
  readonly recordProcessingGeneration: number;
  readonly projectionVersion: 1;
  readonly projectionGeneration: number;
  /** Opaque authorization coordinate. The durable projection row does not persist it. */
  readonly projectionBindingRef: string;
}

export interface RecordSearchProjectionReplaceRequest
  extends RecordSearchProjectionPublishRequest {
  readonly expectedProjectionGeneration: number;
}

export interface RecordSearchProjectionRemoveRequest {
  readonly recordRef: RecordRef;
  readonly expectedProjectionGeneration?: number;
  readonly projectionBindingRef: string;
}

export interface RecordSearchProjectionMutationPort {
  publish(
    input: RecordSearchProjectionPublishRequest,
  ): Promise<RecordSearchProjectionMutationResult>;
  replace(
    input: RecordSearchProjectionReplaceRequest,
  ): Promise<RecordSearchProjectionMutationResult>;
  remove(input: RecordSearchProjectionRemoveRequest): Promise<
    | { readonly status: "removed" | "absent" }
    | { readonly status: "rejected"; readonly reason: "generation_conflict" | "record_unavailable" }
  >;
}
