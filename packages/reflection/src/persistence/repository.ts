import type {
  RecordLifecycle,
  RecordPosture,
  RecordRef,
  RecordSnapshot,
  SuccessorEdge,
  SuccessorRelation,
} from "../contracts/hierarchy";

export const DURABLE_RECORD_PAGE_LIMIT_MAX = 256;

/** Semantic anchor identity stays inside the selected payload representation. */
export interface DurableRecordAnchor {
  readonly anchorRef: string;
  readonly kind: "room" | "task" | "artifact" | "subject";
  /** Opaque, versioned producer role; Reflection does not infer it. */
  readonly role: string;
}

/** Exact source provenance retained inside the selected payload representation. */
export interface DurableSourceDependency {
  /** Versioned adapter kind (for example message, journal_event, or memory). */
  readonly sourceKind: string;
  readonly logicalSourceRef: string;
  readonly observedRevision?: string;
  readonly observedContentFingerprint?: string;
  readonly terminalAuthorityLeafHandle: string;
  readonly authorityBearing: boolean;
}

export interface DurableProducerProvenance {
  readonly producerRef: string;
  readonly policyVersion: string;
}

/**
 * One immutable input disclosed to the model. This is authority provenance,
 * separate from semantic citations and hierarchy edges.
 */
export type DurableModelExposureDependency =
  | Readonly<{
      readonly kind: "record";
      readonly recordRef: RecordRef;
      readonly observedProcessingGeneration: number;
      readonly terminalAuthorityLeafHandles: readonly string[];
    }>
  | Readonly<{
      readonly kind: "source";
      readonly sourceKind: string;
      readonly logicalSourceRef: string;
      readonly observedRevision?: string;
      readonly observedContentFingerprint?: string;
      readonly terminalAuthorityLeafHandle: string;
    }>;

/**
 * All immutable semantic fields required by the versioned payload codec.
 * This is logical input only: it specifies neither ordinary bytes nor a crypto
 * object and deliberately contains no mode-selection or storage concern.
 */
export interface DurableRecordSemanticFields {
  readonly observedContentFingerprint: string;
  readonly posture: RecordPosture;
  readonly statement: string;
  readonly sourceDependencies: readonly DurableSourceDependency[];
  readonly anchors: readonly DurableRecordAnchor[];
  readonly childRecordRefs: readonly RecordRef[];
  readonly producer: DurableProducerProvenance;
  readonly terminalAuthorityLeafHandles: readonly string[];
  /** Undefined only for legacy payloads that predate complete exposure capture. */
  readonly modelExposureDependencies?: readonly DurableModelExposureDependency[];
  readonly sourceOwnedKind?: string;
  readonly observedLogicalObjectRef?: string;
  readonly observedRevision?: string;
}

/** One logical durable Record, independent of its selected representation. */
export interface DurableRecordEnvelope {
  readonly recordRef: RecordRef;
  readonly semantic: DurableRecordSemanticFields;
  readonly lifecycle: RecordLifecycle;
  readonly structuralHeight: number;
  readonly processingGeneration: number;
}

export interface DurableRecordPredecessor {
  readonly recordRef: RecordRef;
  readonly relation: SuccessorRelation;
}

export interface DurableRecordPublication {
  readonly record: DurableRecordEnvelope;
  readonly predecessor?: DurableRecordPredecessor;
  readonly idempotencyKey: string;
  /** Opaque proof/coordinate supplied by the pre-authorized product bridge. */
  readonly publicationBindingRef: string;
  /** Immutable semantic cohort origin when current payload access differs. */
  readonly originPublicationBindingRef?: string;
}

export type DurableRecordPublicationRejection =
  | "invalid_publication"
  | "publication_binding_invalid"
  | "idempotency_conflict"
  | "structural_conflict"
  | "blocked"
  | "purged";

/**
 * Content-free reason for a structurally rejected immutable publication.
 * Callers use this only to distinguish a stale prepared view from a malformed
 * proposal; it never carries Record identifiers or semantic payload data.
 */
export type DurableRecordStructuralRejection =
  | "record_already_exists"
  | "invalid_record_shape"
  | "child_unavailable"
  | "child_parent_changed"
  | "height_mismatch"
  | "ancestor_cycle"
  | "predecessor_changed"
  | "successor_changed"
  | "publication_incomplete";

export type DurableRecordPublicationResult =
  | {
      readonly status: "published" | "replayed";
      readonly record: DurableRecordEnvelope;
    }
  | {
      readonly status: "rejected";
      readonly recordRef: RecordRef;
      readonly reason: DurableRecordPublicationRejection;
      readonly structuralReason?: DurableRecordStructuralRejection;
    };

export interface DirectRecordDispositionMutation {
  readonly recordRef: RecordRef;
}

export type DirectRecordDispositionResult =
  | {
      readonly status: "blocked" | "purged";
      readonly recordRef: RecordRef;
      readonly replayed: boolean;
    }
  | {
      readonly status: "not_found" | "conflict";
      readonly recordRef: RecordRef;
      readonly replayed: false;
    };

export interface DurableRecordLifecycleMutation {
  readonly recordRef: RecordRef;
  readonly expectedProcessingGeneration: number;
  readonly from: "current" | "stale";
  readonly to: "current" | "stale" | "sunset";
}

export type DurableRecordLifecycleMutationResult =
  | {
      readonly status: "transitioned";
      readonly recordRef: RecordRef;
      readonly lifecycle: DurableRecordLifecycleMutation["to"];
      readonly replayed: boolean;
    }
  | {
      readonly status: "not_found" | "conflict" | "blocked" | "purged";
      readonly recordRef: RecordRef;
      readonly replayed: false;
    };

export type DurableRecordUnavailableReason =
  | "not_found"
  | "selected_representation_missing"
  | "integrity_failure"
  | "unauthorized"
  | "blocked"
  | "purged";

export interface DurableRecordReadRequest {
  readonly recordRef: RecordRef;
  /** Opaque current read authority supplied by the caller; Wave 5 resolves it. */
  readonly readBindingRef: string;
}

export type DurableRecordReadResult =
  | { readonly status: "available"; readonly record: DurableRecordEnvelope }
  | {
      readonly status: "unavailable";
      readonly recordRef: RecordRef;
      readonly reason: DurableRecordUnavailableReason;
    };

export interface DurableRecordPageRequest extends DurableRecordReadRequest {
  readonly limit: number;
  readonly continuation?: string;
}

export interface DurableRecordPage<T> {
  readonly items: readonly T[];
  readonly continuation?: string;
}

export type DurableRecordPageResult<T> =
  | { readonly status: "available"; readonly page: DurableRecordPage<T> }
  | {
      readonly status: "unavailable";
      readonly recordRef: RecordRef;
      readonly reason: DurableRecordUnavailableReason;
    };

export interface DurableRecordMutationPort {
  publish(input: DurableRecordPublication): Promise<DurableRecordPublicationResult>;
  transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult>;
  /** Direct-record admission only; transitive invalidation belongs to Wave 5. */
  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult>;
  /** Direct-record mutation only; asynchronous representation cleanup is adapter-owned. */
  purge(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult>;
}

export interface DurableRecordReadPort {
  read(input: DurableRecordReadRequest): Promise<DurableRecordReadResult>;
  readDependencies(
    input: DurableRecordPageRequest,
  ): Promise<DurableRecordPageResult<RecordRef>>;
  readParents(input: DurableRecordPageRequest): Promise<DurableRecordPageResult<RecordRef>>;
  readSuccessors(
    input: DurableRecordPageRequest,
  ): Promise<DurableRecordPageResult<SuccessorEdge>>;
  readPredecessors(
    input: DurableRecordPageRequest,
  ): Promise<DurableRecordPageResult<SuccessorEdge>>;
}

/** Shared synchronous guard for every bounded durable repository traversal. */
export function assertDurableRecordPageRequest(
  input: DurableRecordPageRequest,
): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > DURABLE_RECORD_PAGE_LIMIT_MAX) {
    throw new RangeError(
      `durable Record page limit must be between 1 and ${DURABLE_RECORD_PAGE_LIMIT_MAX}`,
    );
  }
  if (input.recordRef.trim().length === 0 || input.readBindingRef.trim().length === 0) {
    throw new TypeError("durable Record page request requires opaque Record and read bindings");
  }
  if (input.continuation !== undefined && input.continuation.length === 0) {
    throw new TypeError("durable Record continuation must be non-empty when supplied");
  }
}

/** Reconstruct the existing transport-neutral snapshot without losing codec fields. */
export function durableEnvelopeToRecordSnapshot(
  envelope: DurableRecordEnvelope,
): RecordSnapshot {
  return {
    recordRef: envelope.recordRef,
    observedContentFingerprint: envelope.semantic.observedContentFingerprint,
    posture: envelope.semantic.posture,
    anchors: envelope.semantic.anchors.map((anchor) => anchor.anchorRef),
    statement: envelope.semantic.statement,
    sourceRefs: envelope.semantic.sourceDependencies.map(
      (dependency) => dependency.logicalSourceRef,
    ),
    childRecordRefs: [...envelope.semantic.childRecordRefs],
    structuralHeight: envelope.structuralHeight,
    lifecycle: envelope.lifecycle,
    ...(envelope.semantic.sourceOwnedKind === undefined
      ? {}
      : { sourceOwnedKind: envelope.semantic.sourceOwnedKind }),
    ...(envelope.semantic.observedLogicalObjectRef === undefined
      ? {}
      : { observedLogicalObjectRef: envelope.semantic.observedLogicalObjectRef }),
    ...(envelope.semantic.observedRevision === undefined
      ? {}
      : { observedRevision: envelope.semantic.observedRevision }),
  };
}
