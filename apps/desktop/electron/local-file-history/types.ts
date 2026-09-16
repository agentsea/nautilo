/**
 * ISSUE-M206 — local relay revision journal types.
 *
 * Electron-free: consumed by the journal and future local-file dispatcher.
 * Revision refs use `local:<relayId>:<uuid>`; payloads stay device-local plaintext.
 */

import type {
  DocumentMutationActor,
} from "@nautilo/types";
import type { AtomicDocumentMutationEventBatch } from "@nautilo/document-mutations";

/** Destructive local-file operations that produce revision rows. */
export const LOCAL_FILE_OPERATIONS = [
  "create",
  "write",
  "str_replace",
  "insert",
  "delete",
  "move",
  "copy",
  "convert",
  "undo",
  "redo",
] as const;

export type LocalFileOperation = (typeof LOCAL_FILE_OPERATIONS)[number];

/** Snapshot used when recording or restoring file bytes. */
export type FileStateSnapshot =
  | { kind: "missing" }
  | { kind: "bytes"; bytes: Uint8Array; sha256: string; size: number };

/** Metadata-only file state stored in the manifest (no inline bytes). */
export type FileStateMeta =
  | { kind: "missing" }
  | { kind: "bytes"; sha256: string; size: number };

/** Local zone that produced this revision row (for change events and undo_turn). */
export type LocalRevisionZone = "current" | "absolute";

export interface LocalRevisionEntry {
  id: string;
  ownerId: string;
  agentId: string;
  turnId: string;
  requestedPath: string;
  canonicalPath: string;
  /** Zone at mutation time — used when emitting undo_turn change events. */
  zone?: LocalRevisionZone;
  operation: LocalFileOperation;
  createdAt: string;
  /** Durable total order for post-cutover mixed V1/V2 history. */
  historySequence?: number;
  preState: FileStateMeta;
  postState: FileStateMeta;
  pinned: boolean;
  /** Set when this row was produced by undo/redo — enables redo traversal. */
  restoreFromRevisionId?: string;
  /** Companion path for move (destination) — removed on undo. */
  relatedCanonicalPath?: string;
  /** Move destination snapshots, present when the destination had state. */
  relatedPreState?: FileStateMeta;
  relatedPostState?: FileStateMeta;
  /** Sum of on-disk payload bytes for retention accounting. */
  payloadBytes: number;
}

export interface LocalFileHistoryManifest {
  v: 1;
  relayId: string;
  entries: LocalRevisionEntry[];
}

export type LocalMutationActor = DocumentMutationActor;

export type LocalMutationIntentState =
  | "pending"
  | "committed"
  | "aborted"
  | "recovery_required";

export interface LocalMutationPayloadRef {
  /** Relative to the journal root. */
  path: string;
  sha256: string;
  size: number;
}

export type LocalMutationDurableState =
  | { kind: "missing" }
  | { kind: "bytes"; sha256: string; size: number; payload: LocalMutationPayloadRef };

export interface LocalMutationIntentPath {
  kind: "create" | "update" | "move" | "delete";
  canonicalPath: string;
  sourceCanonicalPath?: string;
  revisionIds: string[];
  undoRecordIds: string[];
  pinned?: boolean;
  locations: Array<{
    canonicalPath: string;
    before: LocalMutationDurableState;
    after: LocalMutationDurableState;
  }>;
}

export type LocalCanonicalMutationOperation =
  | LocalFileOperation
  | "apply_patch"
  | "officecli"
  | "editor_save"
  | "document_write_commit";

export interface LocalMutationHistoryMetadata {
  readonly action: "undo" | "redo";
  readonly sourceRevisionIds: readonly string[];
  readonly targetTurnId?: string;
}

export interface LocalMutationStructuralMetadata {
  readonly command: "delete" | "move" | "copy";
  readonly sourceRequestPath: string;
  readonly sourceCanonicalPath: string;
  readonly destinationRequestPath?: string;
  readonly destinationCanonicalPath?: string;
}

/**
 * Required producer truth for every new V2 write. Persisted intents keep this
 * optional only so pre-cutover V2 journals remain readable.
 */
export interface LocalMutationProducerMetadata {
  readonly operation: LocalCanonicalMutationOperation;
  readonly turnId?: string;
  readonly history?: LocalMutationHistoryMetadata;
  readonly structural?: LocalMutationStructuralMetadata;
}

export interface LocalMutationIntentV2 {
  operationId: string;
  revisionGroupId: string;
  actor: LocalMutationActor;
  state: LocalMutationIntentState;
  createdAt: string;
  updatedAt: string;
  /** Durable total order; optional only for pre-cutover V2 manifests. */
  readonly historySequence?: number;
  readonly producer?: LocalMutationProducerMetadata;
  paths: LocalMutationIntentPath[];
  /** Stable diagnostic evidence when neither exact preimage nor postimage is on disk. */
  recoveryEvidence?: {
    checkedAt: string;
    actual: Array<{ canonicalPath: string; state: FileStateMeta }>;
  };
}

export type LocalMutationOutboxState =
  | "held"
  | "pending"
  | "claimed"
  | "delivered"
  | "cancelled";

export interface LocalMutationOutboxBatch {
  id: string;
  operationId: string;
  revisionGroupId: string;
  batch: AtomicDocumentMutationEventBatch;
  state: LocalMutationOutboxState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimedAt?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface LocalFileHistoryManifestV2 {
  v: 2;
  relayId: string;
  /** Historical v1 rows remain readable and undoable after the atomic upgrade. */
  legacyEntries: LocalRevisionEntry[];
  mutations: LocalMutationIntentV2[];
  outbox: LocalMutationOutboxBatch[];
}

/** Bounded proof retained after an old terminal transport envelope is reaped. */
export interface LocalMutationTerminalReceipt {
  id: string;
  operationId: string;
  revisionGroupId: string;
  state: "delivered" | "cancelled";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface LocalFileHistoryManifestV3 {
  v: 3;
  relayId: string;
  legacyEntries: LocalRevisionEntry[];
  mutations: LocalMutationIntentV2[];
  /** Full envelopes exist only while actionable or inside the replay grace. */
  outbox: LocalMutationOutboxBatch[];
  /** Compact, age/count-bounded terminal idempotency proof. */
  receipts: LocalMutationTerminalReceipt[];
}

export type AnyLocalFileHistoryManifest =
  | LocalFileHistoryManifest
  | LocalFileHistoryManifestV2
  | LocalFileHistoryManifestV3;

export interface BeginLocalMutationIntentInput {
  operationId: string;
  revisionGroupId: string;
  actor: LocalMutationActor;
  producer: LocalMutationProducerMetadata;
  batch: AtomicDocumentMutationEventBatch;
  paths: Array<{
    kind: "create" | "update" | "move" | "delete";
    canonicalPath: string;
    sourceCanonicalPath?: string;
    revisionIds: string[];
    undoRecordIds: string[];
    locations: Array<{
      canonicalPath: string;
      before: FileStateSnapshot;
      after: FileStateSnapshot;
    }>;
  }>;
}

export interface CanonicalLocalHistoryRecord {
  readonly source: "v1" | "v2";
  readonly revisionRef: string;
  readonly revisionId: string;
  readonly operationId: string;
  readonly revisionGroupId: string;
  readonly actor: LocalMutationActor;
  readonly turnId?: string;
  readonly operation: LocalCanonicalMutationOperation;
  readonly createdAt: string;
  readonly historySequence: number;
  readonly history?: LocalMutationHistoryMetadata;
  readonly locations: readonly {
    readonly canonicalPath: string;
    readonly before: FileStateSnapshot;
    readonly after: FileStateSnapshot;
  }[];
}

export interface FinalizeLocalMutationInput {
  operationId: string;
}

export interface LocalMutationRecoveryResult {
  operationId: string;
  state: "committed" | "aborted" | "recovery_required";
}

export interface ClaimLocalMutationOutboxInput {
  claimantId: string;
  now?: string;
  staleClaimBefore?: string;
}

export interface RetentionConfig {
  /** Per-canonical-path revision count cap (default 50). */
  maxEntriesPerPath: number;
  /** Drop unpinned entries older than this many milliseconds (default 30 days). */
  maxAgeMs: number;
  /** Soft cleanup target across the journal (default 500 MB); protected truth may exceed it. */
  maxTotalBytes: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  maxEntriesPerPath: 50,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 500 * 1024 * 1024,
};

export type LocalFileHistoryErrorCode =
  | "drift"
  | "history_pruned"
  | "history_unavailable_on_this_relay"
  | "revision_not_found"
  | "no_revisions"
  | "no_revisions_for_turn"
  | "nothing_to_redo"
  | "already_at_target_state"
  | "relay_ownership_mismatch"
  | "file_missing"
  | "invalid_revision_ref"
  | "path_guard_rejected";

export type LocalFileHistoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: LocalFileHistoryErrorCode; message: string; details?: Record<string, unknown> };

export interface RecordSuccessfulMutationInput {
  ownerId: string;
  agentId: string;
  turnId: string;
  requestedPath: string;
  zone: LocalRevisionZone;
  operation: LocalFileOperation;
  preState: FileStateSnapshot;
  postState: FileStateSnapshot;
  /** Move destination canonical path — restored source and removed on undo. */
  relatedCanonicalPath?: string;
  /** Exact destination state before/after an overwrite-capable move. */
  relatedPreState?: FileStateSnapshot;
  relatedPostState?: FileStateSnapshot;
}

export interface RecordSuccessfulMutationOutput {
  revisionRef: string;
  revisionId: string;
  canonicalPath: string;
  pruned?: { count: number; revisionIds: string[] };
}

export interface ListRevisionsInput {
  agentId: string;
  canonicalPath?: string;
  turnId?: string;
  since?: string;
  until?: string;
  limit?: number;
  includePinnedOnly?: boolean;
}

export interface ListRevisionsOutput {
  revisions: LocalRevisionSummary[];
  truncated: boolean;
}

export interface LocalRevisionSummary {
  revisionRef: string;
  revisionId: string;
  ownerId: string;
  agentId: string;
  turnId: string;
  requestedPath: string;
  canonicalPath: string;
  zone: LocalRevisionZone;
  operation: LocalCanonicalMutationOperation;
  createdAt: string;
  preState: FileStateMeta;
  postState: FileStateMeta;
  pinned: boolean;
  restoreFromRevisionId?: string;
  relatedCanonicalPath?: string;
}

export interface PinRevisionInput {
  agentId: string;
  revisionRef: string;
}

export interface PinRevisionOutput {
  revisionRef: string;
  pinned: boolean;
}
