export type RecordRef = string;
export type SourceRef = string;
export type AnchorRef = string;
export type HumanRef = string;

export type RecordPosture = "authored" | "derived";

export type RecordLifecycle =
  | "current"
  | "stale"
  | "superseded"
  | "resolved"
  | "sunset";

/**
 * A transport-neutral observation of one authored or derived Record.
 *
 * References are opaque, call-local handles. Product IDs, authority material,
 * ciphertext metadata, and source bodies do not belong in this contract.
 */
export interface RecordSnapshot {
  readonly recordRef: RecordRef;
  readonly observedContentFingerprint: string;
  readonly posture: RecordPosture;
  readonly anchors: readonly AnchorRef[];
  readonly statement: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly childRecordRefs: readonly RecordRef[];
  readonly structuralHeight: number;
  readonly lifecycle: RecordLifecycle;
  readonly sourceOwnedKind?: string;
  /** Stable logical source identity retained by fixture adapters when known. */
  readonly observedLogicalObjectRef?: string;
  /** Exact source revision/version retained by fixture adapters when known. */
  readonly observedRevision?: string;
}

export type OrganizeProposal =
  | { readonly operation: "no_change" }
  | {
      readonly operation: "create_parent";
      readonly statement: string;
      readonly childRecordRefs: readonly RecordRef[];
    }
  | {
      /**
       * Extend one current immutable parent with newly selected evidence.
       * The model names additions only; deterministic application preserves
       * the predecessor's complete still-valid direct support.
       */
      readonly operation: "extend_parent";
      readonly parentRecordRef: RecordRef;
      readonly statement: string;
      readonly additionRefs: readonly RecordRef[];
    }
  | {
      /**
       * Place one current parent below a new broader parent while retaining
       * the lower parent as the current head of its existing cluster.
       */
      readonly operation: "wrap_parent";
      readonly parentRecordRef: RecordRef;
      readonly statement: string;
      readonly additionRefs: readonly RecordRef[];
    }
  | {
      readonly operation: "supersede_parent";
      readonly parentRecordRef: RecordRef;
      readonly statement: string;
      readonly childRecordRefs: readonly RecordRef[];
    }
  | {
      readonly operation: "resolve_parent";
      readonly parentRecordRef: RecordRef;
      readonly statement: string;
      readonly childRecordRefs: readonly RecordRef[];
    }
  | {
      readonly operation: "dissolve_parent";
      readonly parentRecordRef: RecordRef;
    };

/** Per-call limits. These bound work, never the eventual graph shape. */
export interface HierarchyBudget {
  readonly maxModelCalls: number;
  readonly maxVisitedRecords: number;
  readonly maxCreatedRecords: number;
  readonly maxTraversalWork: number;
  readonly maxStatementCharacters: number;
}

export interface HierarchyBudgetUsage {
  readonly modelCalls: number;
  readonly visitedRecords: number;
  readonly createdRecords: number;
  readonly traversalWork: number;
}

export type HierarchyErrorCode =
  | "invalid_record"
  | "unknown_reference"
  | "duplicate_reference"
  | "ineligible_reference"
  | "self_dependency"
  | "dependency_cycle"
  | "successor_cycle"
  | "ancestor_descendant_duplication"
  | "multiple_current_parents"
  | "invalid_lifecycle_transition"
  | "unchanged_successor"
  | "audience_mismatch"
  | "budget_exceeded"
  | "idempotency_conflict";

export class HierarchyError extends Error {
  readonly code: HierarchyErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HierarchyErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HierarchyError";
    this.code = code;
    this.details = details;
  }
}

/** Test-only exact audience descriptor. Product authority is bridge-owned. */
export interface SyntheticAccessAudience {
  readonly kind: "access";
  readonly humanRefs: readonly HumanRef[];
}

export interface SyntheticEligibleRecord {
  readonly snapshot: RecordSnapshot;
  readonly audience: SyntheticAccessAudience;
  readonly initialPublicationScope: SyntheticAccessAudience;
}

export type SuccessorRelation = "supersedes" | "resolves";

export interface SuccessorEdge {
  readonly predecessorRecordRef: RecordRef;
  readonly successorRecordRef: RecordRef;
  readonly relation: SuccessorRelation;
}

export interface SyntheticStoredRecord extends SyntheticEligibleRecord {
  readonly createdByIdempotencyKey?: string;
}

export interface HierarchyIdContext {
  readonly operation:
    | "create_parent"
    | "extend_parent"
    | "wrap_parent"
    | "supersede_parent"
    | "resolve_parent";
  readonly idempotencyKey: string;
  readonly predecessorRecordRef?: RecordRef;
}

/** Explicitly non-durable in Wave 3; callers inject fixture identity. */
export type HierarchyIdGenerator = (context: HierarchyIdContext) => RecordRef;

export interface ApplyProposalInput {
  readonly proposal: OrganizeProposal;
  readonly eligibleRecordRefs: readonly RecordRef[];
  readonly initialPublicationScope: SyntheticAccessAudience;
  readonly idempotencyKey: string;
  readonly budget: HierarchyBudget;
}

export type ApplyProposalResult =
  | {
      readonly operation: "no_change";
      readonly replayed: false;
      readonly usage: HierarchyBudgetUsage;
    }
  | {
      readonly operation:
        | "create_parent"
        | "extend_parent"
        | "wrap_parent"
        | "supersede_parent"
        | "resolve_parent";
      readonly record: SyntheticStoredRecord;
      readonly predecessorRecordRef?: RecordRef;
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
    }
  | {
      readonly operation: "dissolve_parent";
      readonly record: SyntheticStoredRecord;
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
    };

export interface DependencyLossInput {
  readonly parentRecordRef: RecordRef;
  readonly unavailableChildRecordRefs: readonly RecordRef[];
  /** Required only when some support remains. */
  readonly replacementStatement?: string;
  readonly eligibleRecordRefs: readonly RecordRef[];
  readonly initialPublicationScope: SyntheticAccessAudience;
  readonly idempotencyKey: string;
  readonly budget: HierarchyBudget;
}

export type DependencyLossResult =
  | {
      readonly kind: "partial_replacement";
      readonly predecessor: SyntheticStoredRecord;
      readonly successor: SyntheticStoredRecord;
      readonly remainingChildRecordRefs: readonly RecordRef[];
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
    }
  | {
      readonly kind: "total_sunset";
      readonly record: SyntheticStoredRecord;
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
    };
