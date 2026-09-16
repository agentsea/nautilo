import type { RecordLifecycle, RecordRef } from "../contracts/hierarchy";
import type { DurableSourceDependency } from "../persistence/repository";
import type { RecordEvidenceContinuationToken } from "./contracts";
import { assertRecordEvidenceContinuationToken } from "./continuation";
import { RECORD_SEARCH_POLICY_V1 } from "./policy";
import {
  assertPortableRecordSearchIdentifier,
  assertPositiveSafeInteger,
} from "./validation";

export interface RecordEvidenceRequest {
  readonly rootRecordRef: RecordRef;
  readonly evidenceBindingRef: string;
  readonly traversalWorkLimit: number;
  readonly openedPayloadBytesLimit: number;
  readonly returnedBytesLimit: number;
  readonly continuation?: RecordEvidenceContinuationToken;
  readonly signal?: AbortSignal;
}

export interface RecordEvidenceNodeV1 {
  readonly recordRef: RecordRef;
  readonly statement: string;
  readonly structuralHeight: number;
  readonly lifecycle: RecordLifecycle;
  /** V1 emits the selected Record and at most one further dependency level. */
  readonly depth: 0 | 1;
}

export interface RecordEvidenceEdgeV1 {
  readonly parentRecordRef: RecordRef;
  readonly childRecordRef: RecordRef;
  readonly childPosition: number;
}

export interface SyntheticSourceEvidenceV1 {
  readonly evidenceRef: string;
  readonly kind: string;
  readonly content: string;
  readonly returnedUtf8Bytes: number;
}

export type RecordEvidenceUnavailableReason =
  | "unauthorized"
  | "blocked"
  | "purged"
  | "stale_restart"
  | "source_changed"
  | "source_unavailable"
  | "capacity_exceeded"
  | "integrity_failure";

export type SyntheticSourceEvidenceResult =
  | { readonly status: "available"; readonly evidence: SyntheticSourceEvidenceV1 }
  | { readonly status: "unavailable"; readonly reason: RecordEvidenceUnavailableReason };

export interface SyntheticRecordEvidenceReaderPort {
  read(input: {
    /**
     * Exact immutable provenance observed by the parent Record. The bridge
     * reopens this logical source under current authority and compares its
     * revision/fingerprint before returning any body. None of these fields are
     * copied into model-facing evidence output.
     */
    readonly sourceDependency: DurableSourceDependency;
    readonly evidenceBindingRef: string;
    readonly returnedBytesRemaining: number;
    readonly signal?: AbortSignal;
  }): Promise<SyntheticSourceEvidenceResult>;
}

export type RecordEvidenceResponse =
  | {
      readonly status: "available";
      readonly nodes: readonly RecordEvidenceNodeV1[];
      readonly edges: readonly RecordEvidenceEdgeV1[];
      readonly sources: readonly SyntheticSourceEvidenceV1[];
      readonly continuation?: RecordEvidenceContinuationToken;
    }
  | { readonly status: "unavailable"; readonly reason: RecordEvidenceUnavailableReason };

export interface RecordEvidencePort {
  expand(input: RecordEvidenceRequest): Promise<RecordEvidenceResponse>;
}

export function assertRecordEvidenceRequest(input: RecordEvidenceRequest): void {
  assertPortableRecordSearchIdentifier("evidence root Record", input.rootRecordRef);
  assertPortableRecordSearchIdentifier("evidence binding", input.evidenceBindingRef);
  for (const [label, value, maximum] of [
    ["evidence traversal work", input.traversalWorkLimit, RECORD_SEARCH_POLICY_V1.traversalWorkMaximum],
    ["opened Record payload bytes", input.openedPayloadBytesLimit, RECORD_SEARCH_POLICY_V1.openedRecordPayloadBytesMaximum],
    ["returned evidence bytes", input.returnedBytesLimit, RECORD_SEARCH_POLICY_V1.returnedBytesMaximum],
  ] as const) {
    assertPositiveSafeInteger(label, value);
    if (value > maximum) throw new RangeError(`${label} exceeds the V1 policy`);
  }
  if (input.continuation !== undefined) {
    assertRecordEvidenceContinuationToken(input.continuation);
  }
}

/** Stable redaction: only edges whose two endpoints are eligible survive. */
export function redactHiddenEvidenceEdges(
  edges: readonly RecordEvidenceEdgeV1[],
  eligibleRecordRefs: ReadonlySet<RecordRef>,
): readonly RecordEvidenceEdgeV1[] {
  const visible: RecordEvidenceEdgeV1[] = [];
  for (const edge of edges) {
    if (
      !eligibleRecordRefs.has(edge.parentRecordRef)
      || !eligibleRecordRefs.has(edge.childRecordRef)
    ) continue;
    if (!Number.isSafeInteger(edge.childPosition) || edge.childPosition < 0) {
      throw new RangeError("evidence child position must be a non-negative safe integer");
    }
    visible.push(Object.freeze({ ...edge }));
  }
  return Object.freeze(visible);
}
