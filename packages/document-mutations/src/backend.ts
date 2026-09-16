import type {
  DocumentCommitPlan,
  DocumentExpectedSnapshot,
  DocumentIdentity,
  DocumentMutationPath,
  DocumentPostImage,
  DocumentVersion,
  LocalDocumentIdentity,
  LocalDocumentVersion,
  WorkspaceDocumentIdentity,
  WorkspaceDocumentVersion,
} from "@nautilo/types";
import type {
  AtomicDocumentMutationCommitReceipt,
  AtomicDocumentMutationEventBatch,
} from "./committed-events";

export type DocumentMutationBackendKind = "workspace" | "desktop";

type IdentityFor<K extends DocumentMutationBackendKind> = K extends "workspace"
  ? WorkspaceDocumentIdentity
  : LocalDocumentIdentity;

type VersionFor<K extends DocumentMutationBackendKind> = K extends "workspace"
  ? WorkspaceDocumentVersion
  : LocalDocumentVersion;

type SnapshotFor<K extends DocumentMutationBackendKind> = Omit<
  DocumentExpectedSnapshot,
  "identity" | "expectedVersion"
> & {
  identity: IdentityFor<K>;
  expectedVersion: VersionFor<K>;
};

type PostImageFor<K extends DocumentMutationBackendKind> = Omit<
  DocumentPostImage,
  "identity"
> & {
  identity: IdentityFor<K>;
};

export type BackendCommitPlanEntry<K extends DocumentMutationBackendKind> =
  | { kind: "create"; after: PostImageFor<K> }
  | { kind: "update"; before: SnapshotFor<K>; after: PostImageFor<K> }
  | {
      kind: "move";
      source: SnapshotFor<K>;
      destinationBefore?: SnapshotFor<K>;
      after: PostImageFor<K>;
    }
  | { kind: "delete"; before: SnapshotFor<K> };

export type BackendCommitPlan<K extends DocumentMutationBackendKind> = Omit<
  DocumentCommitPlan,
  "entries"
> & {
  entries: readonly BackendCommitPlanEntry<K>[];
};

export interface BackendDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly entryIndex?: number;
}

export interface BackendConflictEvidence<K extends DocumentMutationBackendKind> {
  readonly path: DocumentMutationPath;
  readonly currentVersion: VersionFor<K>;
}

/**
 * Exact authoritative bytes observed with conflict evidence.
 *
 * This is backend-to-coordinator evidence only. It is deliberately excluded
 * from the public conflict result so current document bytes never leak through
 * diagnostics. The coordinator independently verifies the bytes against
 * `currentVersion` before considering a text rebase.
 */
export interface BackendConflictSnapshot<K extends DocumentMutationBackendKind> {
  readonly identity: IdentityFor<K>;
  readonly currentVersion: VersionFor<K>;
  readonly bytes: Uint8Array;
}

export type BackendPrepareOutcome<
  K extends DocumentMutationBackendKind,
  Prepared,
> =
  | {
      readonly kind: "prepared";
      readonly prepared: Prepared;
      /**
       * Trusted durable group recovered by the backend for an idempotent
       * replay. The coordinator uses this exact value rather than allocating
       * a second group for an already-persisted receipt.
       */
      readonly revisionGroupIdHint?: string;
    }
  | {
      readonly kind: "conflict";
      readonly code: "stale_version" | "human_edit_conflict" | "reapply_required";
      readonly evidence: readonly [
        BackendConflictEvidence<K>,
        ...BackendConflictEvidence<K>[],
      ];
      readonly currentSnapshots?: readonly [
        BackendConflictSnapshot<K>,
        ...BackendConflictSnapshot<K>[],
      ];
      readonly diagnostics: readonly BackendDiagnostic[];
    }
  | {
      readonly kind: "failed";
      readonly code: "backend_unavailable" | "backend_failure";
      readonly diagnostics: readonly BackendDiagnostic[];
    };

export type BackendCommitReceipt<K extends DocumentMutationBackendKind> =
  AtomicDocumentMutationCommitReceipt<K, VersionFor<K>>;

export type BackendCommittedEntryReceipt<K extends DocumentMutationBackendKind> =
  BackendCommitReceipt<K>["entries"][number];

export interface CommitPreparedInput<
  K extends DocumentMutationBackendKind,
  Prepared,
> {
  readonly plan: BackendCommitPlan<K>;
  readonly prepared: Prepared;
  /** Allocated by the coordinator before any authoritative write. */
  readonly revisionGroupId: string;
  /**
   * The sole event builder. A backend calls this with its exact prospective
   * receipt before authoritative commit, then enlists the returned batch in the
   * same durable transaction as bytes/revisions/history.
   */
  readonly buildCommittedEventBatch: (
    receipt: BackendCommitReceipt<K>,
  ) => AtomicDocumentMutationEventBatch;
}

export interface CompensateCommitInput<
  K extends DocumentMutationBackendKind,
  Prepared,
  Receipt extends BackendCommitReceipt<K>,
> {
  readonly plan: BackendCommitPlan<K>;
  readonly prepared: Prepared;
  readonly revisionGroupId: string;
  /**
   * Present after a successful backend commit; absent when commit started but
   * no exact receipt was returned.
   */
  readonly receipt?: Receipt;
}

export type BackendCommitOutcome<
  K extends DocumentMutationBackendKind,
  Receipt extends BackendCommitReceipt<K>,
> =
  | {
      readonly kind: "committed";
      readonly receipt: Receipt;
      /** Explicit fresh business commit, never a recovered/replayed receipt. */
      readonly freshlyCommitted?: boolean;
      /** Proof of the exact batch enlisted before the authoritative commit. */
      readonly enlistedEventBatch: AtomicDocumentMutationEventBatch;
    }
  | {
      readonly kind: "conflict";
      readonly code: "stale_version" | "human_edit_conflict" | "reapply_required";
      readonly evidence: readonly [
        BackendConflictEvidence<K>,
        ...BackendConflictEvidence<K>[],
      ];
      readonly currentSnapshots?: readonly [
        BackendConflictSnapshot<K>,
        ...BackendConflictSnapshot<K>[],
      ];
      readonly diagnostics: readonly BackendDiagnostic[];
    }
  | {
      readonly kind: "failed";
      readonly code: "backend_failure";
      /** True only when an authoritative mutation may need recovery. */
      readonly requiresCompensation: boolean;
      readonly diagnostics: readonly BackendDiagnostic[];
    }
  | {
      readonly kind: "failed";
      readonly code: "inconsistent_outcome";
      /** An inconsistent outcome is never safe to report without recovery. */
      readonly requiresCompensation: true;
      readonly diagnostics: readonly BackendDiagnostic[];
    };

export type BackendCompensationOutcome =
  | {
      readonly kind: "compensated";
      readonly operationId: string;
      readonly revisionGroupId: string;
      readonly disposition: "rolled_back";
      readonly entries: readonly BackendRestoredEntryReceipt[];
    }
  | {
      readonly kind: "failed";
      readonly code: "backend_failure" | "inconsistent_outcome";
      readonly diagnostics: readonly BackendDiagnostic[];
    };

export type BackendRestoredEntryReceipt =
  | {
      readonly kind: "create";
      readonly entryIndex: number;
      readonly identity: DocumentIdentity;
      readonly absent: true;
    }
  | {
      readonly kind: "update";
      readonly entryIndex: number;
      readonly restored: DocumentVersion;
    }
  | {
      readonly kind: "move";
      readonly entryIndex: number;
      readonly sourceRestored: DocumentVersion;
      readonly destination:
        | {
            readonly kind: "absent";
            /** Exact move destination proven absent after rollback. */
            readonly identity: DocumentIdentity;
          }
        | { readonly kind: "restored"; readonly version: DocumentVersion };
    }
  | {
      readonly kind: "delete";
      readonly entryIndex: number;
      readonly restored: DocumentVersion;
    };

/**
 * Backend boundary for authoritative persistence.
 *
 * `prepare` is read-only: implementations may read and stage, but cannot
 * change authoritative bytes, revisions, history, or events. The coordinator
 * admits writes only through `commitPrepared`. `compensate` is the explicit
 * recovery operation for a receipt returned by a completed commit.
 */
export interface DocumentMutationBackend<
  K extends DocumentMutationBackendKind,
  Prepared,
  Receipt extends BackendCommitReceipt<K> = BackendCommitReceipt<K>,
> {
  readonly kind: K;
  prepare(plan: BackendCommitPlan<K>): Promise<BackendPrepareOutcome<K, Prepared>>;
  commitPrepared(
    input: CommitPreparedInput<K, Prepared>,
  ): Promise<BackendCommitOutcome<K, Receipt>>;
  compensate(
    input: CompensateCommitInput<K, Prepared, Receipt>,
  ): Promise<BackendCompensationOutcome>;
  /** Idempotently releases private staging/resources created by prepare. */
  disposePrepared(prepared: Prepared): void | Promise<void>;
}

export type WorkspaceArtifactMutationBackend<
  Prepared,
  Receipt extends BackendCommitReceipt<"workspace"> = BackendCommitReceipt<"workspace">,
> = DocumentMutationBackend<"workspace", Prepared, Receipt>;

export type DesktopFileMutationBackend<
  Prepared,
  Receipt extends BackendCommitReceipt<"desktop"> = BackendCommitReceipt<"desktop">,
> = DocumentMutationBackend<"desktop", Prepared, Receipt>;

export type AnyBackendCommitPlan =
  | BackendCommitPlan<"workspace">
  | BackendCommitPlan<"desktop">;
