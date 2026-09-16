import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync, createWriteStream, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { error as logError } from "@nautilo/logger";
import { getProfileAvatarsRoot, getArtifactsRoot, parseNautiloInstanceId } from "@nautilo/config";
import {
  agentScopes,
  eq,
  exists,
  inArray,
  isNull,
  memoryNamespaces,
  memoryScopes,
  nautiloInstanceIdentity,
  or,
  profiles,
  rooms,
  sql,
} from "@nautilo/db";
import { agents as agentsTable } from "@nautilo/db";
import { db } from "@nautilo/db";
import { actors as actorsTable, and, memories } from "@nautilo/db";
import { artifacts as artifactsTable, artifactNamespaces } from "@nautilo/db";
import {
  applyProfileIdentityInTx,
  applyWave1AProfileAllowlist,
  applyWave1AProfileFieldsInTx,
  computeTargetStateDigestInTx,
  encodePortableArtifact,
  encodePrivateMemoryRecord,
  fingerprintPrivateMemoryRecord,
  HandleCollisionError,
  insertPrivateArtifactInTx,
  isArtifactEligibleForPrivateExportInTx,
  isMemoryEligibleForPrivateExportInTx,
  isValidPortableArtifactPath,
  replayPrivateMemoriesInTx,
  type HandleIntent,
  type PrivateMemoryRecord,
  type PrivateMemoryReplayResult,
  type ProfileMigrationTx,
  type Wave1AProfilePayload,
} from "@nautilo/db";
import { embedTextWithProvenance, getProfileByAgentId, type NautiloProfile } from "@nautilo/agent";
import { findPersonalAgentsForUser, findDefaultRoomForActor, getRoomWithAccess } from "@nautilo/trust";
import { type AvatarRef, type EmbeddingWithProvenanceV1, type ProfileVoices } from "@nautilo/types";
import {
  SEMANTIC_VERSION,
  canonicalJson,
  computeRecordHash,
  computeSemanticRoot,
  semantic,
} from "@nautilo/profile-portability";
import { getServerDirectDb } from "../lib/server-direct-db";
import { AgentPhotoLibraryCreateCoordinator } from "../lib/agent-photo-library-create-coordinator";
import { createProductionAgentPhotoLibraryService } from "../lib/agent-photo-library-production";
import {
  requireArtifactWrite,
  type AssertCanWriteArtifacts,
} from "../lib/artifact-write-admission";
import type {
  AgentPhotoLibraryAuthority,
  AgentPhotoSelectionTransactionResult,
} from "../lib/agent-photo-library-service";
import { readPresetAvatarPng } from "./_helpers/avatar";

// The semantic codec types/values live under the `semantic` namespace export
// (see packages/profile-portability/src/index.ts). Aliased here so the rest of
// the module reads as the contract names from the spec.
const ALL_PORTABLE_SCOPES = semantic.ALL_PORTABLE_SCOPES;
const ARTIFACT_MAX_BYTES = semantic.ARTIFACT_MAX_BYTES;
const ARTIFACT_OPAQUE_ID_RE = semantic.ARTIFACT_OPAQUE_ID_RE;
type GenieLiveV1 = semantic.GenieLiveV1;
type PortableScope = semantic.PortableScope;
type SemanticRecord = semantic.SemanticRecord;
type ProfileConflictGroup = semantic.ProfileConflictGroup;

/**
 * D425 Wave 1A — self-service portable Genie profile bundle HTTP contract.
 *
 * Surface (all session-authenticated, caller's OWN personal Agent only — no
 * admin/cross-agent target surface in Wave 1A):
 *   GET  /api/profile/bundle/export                 → ID-free semantic payload
 *   GET  /api/profile/bundle/export/media/:mediaEntry → raw avatar byte stream
 *   POST /api/profile/bundle/import/plan            → read-only dry-run plan
 *   POST /api/profile/bundle/import/stage            → raw avatar byte upload
 *   POST /api/profile/bundle/import/commit          → freshness+idempotency gate
 *
 * Security boundaries (D425 §"Portable package contract" + §"Architecture
 * requirements"):
 *   - No endpoint accepts a plaintext passphrase or decrypts bundle data
 *     server-side. The CLI owns local protection; the server only emits/
 *     consumes semantic records + raw media bytes.
 *   - Export never emits source DB IDs, auth/credential data, Logto identity,
 *     timestamps, or lifecycle state (onboarding/welcome/publicProfile).
 *   - Raw streaming is used for media bytes (download + upload); bundle bytes
 *     are NEVER base64-encoded into JSON.
 *   - Import is dry-run by construction (plan is read-only); commit verifies
 *     plan freshness (target-state digest) and idempotency before any
 *     mutation is permitted.
 *
 * The destructive commit mutation for `wholeProfileChoice: "source"` IS
 * performed here: a caller-owned DB transaction applies the frozen Wave 1A
 * profile fields + the portable identity (name + actor cache + handle) via
 * the `@nautilo/db` transaction-aware primitives, and the staged avatar is
 * finalized to the target's media root with compensating cleanup so no
 * committed ref ever points at missing bytes. `wholeProfileChoice: "target"`
 * is a verified no-op.
 */

const AVATAR_MEDIA_ENTRY = "avatar.bin";
const ALLOWED_MEDIA_ENTRIES: ReadonlySet<string> = new Set([AVATAR_MEDIA_ENTRY]);
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** Internal product-row sentinel; never a portable logical Memory type. */
const PROTECTED_MEMORY_PLACEHOLDER_TYPE = "__nautilo_encrypted_memory_v1__";
// D425 Wave 3 — artifact selection preview pagination defaults. Pagination
// slices the RESPONSE only; the bound snapshot holds every eligible item
// regardless of size (large items are never silently omitted).
const ARTIFACT_PREVIEW_DEFAULT_PAGE = 100;
const ARTIFACT_PREVIEW_MAX_PAGE = 500;

export type WholeProfileChoice = "source" | "target";

/** ID-free semantic export payload returned by `GET .../export`. */
export interface ProfileBundleExportResponse {
  readonly semanticVersion: { readonly major: number; readonly minor: number };
  readonly bundleId: string;
  readonly scopes: readonly PortableScope[];
  readonly records: readonly SemanticRecord[];
  readonly avatarMedia: {
    readonly mediaEntry: string;
    readonly sha256: string;
    readonly mimeType: string;
    readonly size: number;
  } | null;
}

/** One conflict group the dry-run plan detected (source differs from target). */
export interface ProfileBundleConflict {
  readonly group: ProfileConflictGroup;
  readonly choice: WholeProfileChoice;
}

export interface ProfileBundlePlan {
  readonly planToken: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly targetAgentId: string;
  readonly destinationInstanceId: string;
  readonly scopes: readonly PortableScope[];
  readonly wholeProfileChoice: WholeProfileChoice;
  readonly conflicts: readonly ProfileBundleConflict[];
  readonly avatarMedia: {
    readonly mediaEntry: string;
    readonly sha256: string;
    readonly mimeType: string;
  } | null;
  /**
   * D425 Wave 1B — count of `privateMemories` records the bundle carries and
   * the plan will replay on commit. A COUNT ONLY: no memory content, no
   * embeddings, no IDs, no diagnostics ever surface here. Zero when the
   * bundle omits `privateMemories` (Wave 1A behavior) or the caller did not
   * request the scope.
   */
  readonly privateMemoryCount: number;
  /**
   * Exact-record replay estimate at plan time. This is a snapshot only: the
   * authoritative commit rechecks under the target namespace transaction
   * lock and returns its actual count below.
   */
  readonly privateMemoryAddedCount: number;
  /** Exact-record matches already present in the target at plan time. */
  readonly privateMemoryAlreadyPresentCount: number;
  /**
   * D425 Wave 3 — count of `privateArtifacts` records the bundle carries and
   * the plan will replay on commit. A COUNT ONLY: no artifact content, no
   * storage URIs, no source DB IDs, no paths ever surface here. Zero when
   * the bundle omits `privateArtifacts` (Wave 1A/1B behavior) or the caller
   * did not request the scope.
   */
  readonly privateArtifactCount: number;
  /**
   * D425 Wave 3 — total logical byte size of the plan's `privateArtifacts`
   * (sum of `size` across entries). A TOTAL ONLY, so the CLI can warn about
   * large transfers without the server omitting any item. Zero when the
   * bundle omits `privateArtifacts` or the scope was not requested.
   */
  readonly privateArtifactBytes: number;
  readonly refused: readonly string[];
  readonly unknown: readonly string[];
  readonly expiresAt: string;
}

export interface ProfileBundlePlanResponse {
  readonly planToken: string;
  readonly plan: ProfileBundlePlan;
}

export interface ProfileBundleStageResponse {
  readonly planToken: string;
  readonly mediaEntry: string;
  readonly sha256: string;
  readonly size: number;
  readonly staged: true;
}

/** `wholeProfileChoice: "target"` commit — a verified no-op (no mutation). */
export interface ProfileBundleCommitTargetResponse {
  readonly planToken: string;
  readonly idempotencyKey: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly fresh: true;
  readonly committed: true;
  readonly choice: "target";
  readonly privateMemoryAddedCount: 0;
  readonly privateMemoryAlreadyPresentCount: 0;
}

/**
 * `wholeProfileChoice: "source"` commit — the destructive apply succeeded
 * inside one caller-owned DB transaction. The staged avatar was finalized to
 * the target media root. When the bundle carries no custom avatar bytes, the
 * existing target avatar is preserved because the portable `avatar: null`
 * value is ambiguous (preset, omitted, and explicit clear are not distinct).
 * The applied identity + avatar are echoed so clients can surface exactly
 * what landed. A replay with the same idempotency key returns this same result.
 */
export interface ProfileBundleCommitSourceResponse {
  readonly planToken: string;
  readonly idempotencyKey: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly fresh: true;
  readonly committed: true;
  readonly choice: "source";
  /** Authoritative target-namespace replay count from the commit transaction. */
  readonly privateMemoryAddedCount: number;
  /** Authoritative exact matches skipped by the commit transaction. */
  readonly privateMemoryAlreadyPresentCount: number;
  readonly applied: {
    readonly name: string;
    readonly handle: string;
    readonly handleCustomized: boolean;
    readonly avatar: AvatarRef | null;
  };
}
interface StoredPlan {
  readonly planToken: string;
  readonly semanticRoot: string;
  /** Per-record hashes the plan was bound to, so commit can recheck the semantic root. */
  readonly recordHashes: readonly string[];
  readonly targetStateDigest: string;
  readonly sessionUserId: string;
  readonly destinationInstanceId: string;
  readonly targetAgentId: string;
  readonly scopes: readonly PortableScope[];
  readonly wholeProfileChoice: WholeProfileChoice;
  readonly avatarMedia: {
    readonly mediaEntry: string;
    readonly sha256: string;
    readonly mimeType: string;
  } | null;
  /** Decoded source identity name, applied via `applyProfileIdentityInTx`. */
  readonly sourceName: string;
  /** Source handle intent (customized → fail-closed on collision; auto → regenerate). */
  readonly handleIntent: HandleIntent;
  /** Frozen Wave 1A portable profile fields to apply (excludes name + avatarRef). */
  readonly sourceProfile: Wave1AProfilePayload;
  /** Excluded lifecycle/identity keys present in the source (fail closed at commit). */
  readonly refused: readonly string[];
  /** Source keys neither allowed nor known-excluded (fail closed at commit). */
  readonly unknown: readonly string[];
  /**
   * D425 Wave 1B — the source `privateMemories` records the plan will replay
   * on a `source` commit. Stored server-side ONLY (never echoed in the plan
   * response, which carries a count); content is needed at commit to
   * re-embed + insert via `insertPrivateMemoryInTx`. Empty when the bundle
   * omits `privateMemories` or the caller did not request the scope (Wave 1A).
   */
  readonly privateMemories: readonly PrivateMemoryRecord[];
  /**
   * D425 Wave 3 — the source `privateArtifacts` records the plan will replay
   * on a `source` commit, keyed by their opaque `bytesEntry` selection token.
   * Stored server-side ONLY (never echoed verbatim in the plan response,
   * which carries a count + totals); the path/mime/size/sha are needed at
   * stage time (checksum/size gate) and at commit (canonical path validation
   * + target insert via `insertPrivateArtifactInTx`). Empty when the bundle
   * omits `privateArtifacts` or the caller did not request the scope, so a
   * bundle without `privateArtifacts` is byte-identical to Wave 1B.
   */
  readonly privateArtifacts: readonly PrivateArtifactPlanEntry[];
  /**
   * D425 Wave 3 — mutable per-plan record of artifact bytes staged to the
   * target spool (target-local fresh file identity), keyed by `bytesEntry`.
   * Populated by `POST /import/stage-artifact/:bytesEntry`; consumed at
   * commit. A duplicate stage for an already-staged `bytesEntry` is rejected
   * fail-closed. Cleared (spool files deleted) on commit success / failure /
   * expiry. This is the STAGED (temporary spool) side; durable target bytes
   * finalized by `writeArtifactBlob` are tracked separately and compensated
   * by `deleteArtifactBlob` on DB-tx failure.
   */
  stagedArtifacts: Map<string, StagedArtifact>;
  readonly expiresAt: number;
  consumed: boolean;
  committedIdempotencyKey: string | null;
  committedAt: number | null;
  /** Replayed verbatim on an idempotent source replay so retries return the same result. */
  committedResult: {
    readonly name: string;
    readonly handle: string;
    readonly handleCustomized: boolean;
    readonly avatar: AvatarRef | null;
    readonly privateMemoryAddedCount: number;
    readonly privateMemoryAlreadyPresentCount: number;
  } | null;
}

export interface ProfileBundlePlanStore {
  put(plan: StoredPlan): void;
  get(planToken: string): StoredPlan | null;
  delete(planToken: string): void;
  clear(): void;
}

export function createProfileBundlePlanStore(): ProfileBundlePlanStore {
  const plans = new Map<string, StoredPlan>();
  return {
    put: (plan) => plans.set(plan.planToken, plan),
    get: (planToken) => plans.get(planToken) ?? null,
    delete: (planToken) => plans.delete(planToken),
    clear: () => plans.clear(),
  };
}

// Module-level default store so production routes share one plan cache.
const defaultPlanStore = createProfileBundlePlanStore();

// ---------------------------------------------------------------------------
// D425 Wave 3 — private-artifact selection preview + target staging contract
// ---------------------------------------------------------------------------
//
// Server-only slice. The CLI / API client are NOT wired here (a subsequent
// slice owns the client transport). This module adds:
//
//   - A SOURCE preview endpoint that returns a paginated, COMPLETE snapshot
//     of the caller's eligible private artifacts as opaque plan-local
//     selection tokens + logical path/type/size only (no source DB id, no
//     storage URI, no sha in the response). The full snapshot — including
//     every large item — is bound server-side to a `selectionPlanToken`;
//     pagination only slices the response, it never omits items.
//   - A SOURCE stream endpoint that opens an artifact by selection token
//     (NOT by path), revalidates private eligibility + observed metadata
//     (path/mime/size/sha) against the bound snapshot, and streams raw bytes.
//   - A TARGET stage endpoint that accepts artifact bytes by `bytesEntry`
//     (the opaque selection token that travels in the bundle), verifies
//     checksum + size against the plan-bound manifest, and writes them to a
//     target-local fresh file identity (spool).
//   - TARGET finalization wired into the existing commit transaction: each
//     staged artifact is inserted via `insertPrivateArtifactInTx` inside the
//     SAME caller-owned profile/memory tx, with compensation deletion of the
//     finalized durable bytes on DB-tx failure. Target path uses canonical
//     validation from the committed artifact primitive; a target private-
//     namespace path collision fails closed.
//
// Cleanup responsibility is split and documented in types/comments:
//   - STAGED cleanup  → spool files under the stage dir (temporary; always
//                      deleted on commit outcome / expiry).
//   - DURABLE cleanup → finalized target bytes written by `writeArtifactBlob`
//                      (compensated by `deleteArtifactBlob` only when the DB
//                      tx fails AFTER finalization).
// A full crash journal that survives a process crash between finalization
// and commit is a SUBSEQUENT slice; this slice does NOT silently claim one
// exists — see the `ArtifactFinalizeFailure` / deferral notes below.
// ---------------------------------------------------------------------------

/**
 * Source-side eligible private artifact as returned by the
 * `listPrivateArtifactRecords` seam. The seam runs every candidate through
 * `isArtifactEligibleForPrivateExportInTx` (shared / foreign / no-edge
 * artifacts never surface) and projects each survivor via
 * `encodePortableArtifact`. `artifactInternalId` is the source DB PK; it
 * stays server-side and NEVER travels in the preview response — only the
 * opaque `selectionToken` (minted by the route) identifies the item.
 */
export interface PrivateArtifactRecord {
  readonly artifactInternalId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}

/** One bound entry in a source-side artifact selection snapshot. */
export interface ArtifactSelectionEntry {
  /** Source DB PK; server-side only, never echoed to the client. */
  readonly artifactInternalId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}

/** A complete bound snapshot of the caller's eligible private artifacts. */
export interface ArtifactSelectionSnapshot {
  readonly selectionPlanToken: string;
  readonly sessionUserId: string;
  readonly agentId: string;
  readonly expiresAt: number;
  /** Opaque selection token → bound entry (path/mime/size/sha + source id). */
  readonly items: Map<string, ArtifactSelectionEntry>;
  readonly totalCount: number;
  readonly totalBytes: number;
}

export interface ArtifactSelectionStore {
  put(snapshot: ArtifactSelectionSnapshot): void;
  get(selectionPlanToken: string): ArtifactSelectionSnapshot | null;
  delete(selectionPlanToken: string): void;
  clear(): void;
}

export function createArtifactSelectionStore(): ArtifactSelectionStore {
  const snapshots = new Map<string, ArtifactSelectionSnapshot>();
  return {
    put: (snapshot) => snapshots.set(snapshot.selectionPlanToken, snapshot),
    get: (selectionPlanToken) => snapshots.get(selectionPlanToken) ?? null,
    delete: (selectionPlanToken) => snapshots.delete(selectionPlanToken),
    clear: () => snapshots.clear(),
  };
}

const defaultArtifactSelectionStore = createArtifactSelectionStore();

/** One artifact the target import plan will replay, bound by opaque token. */
export interface PrivateArtifactPlanEntry {
  /** Opaque selection token; also the bundle `PortableArtifact.bytesEntry` id. */
  readonly bytesEntry: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * STAGED artifact bytes on the target (temporary spool). `artifactId` is the
 * fresh target-local external id minted at stage time (target-local fresh
 * file identity — never the source identity); `storageUri` is the durable
 * target location finalized by `writeArtifactBlob` at commit. Until
 * finalization, only `stagedPath` exists on disk.
 */
export interface StagedArtifact {
  readonly bytesEntry: string;
  readonly artifactId: string;
  readonly stagedPath: string;
  readonly sha256: string;
  readonly size: number;
  /** Set at commit finalization so compensation can delete durable bytes. */
  durableStorageUri: string | null;
}

export interface ArtifactStageStore {
  put(planToken: string, entry: StagedArtifact): void;
  get(planToken: string, bytesEntry: string): StagedArtifact | null;
  deleteOne(planToken: string, bytesEntry: string): void;
  deleteAll(planToken: string): void;
  clear(): void;
}

export function createArtifactStageStore(): ArtifactStageStore {
  const byPlan = new Map<string, Map<string, StagedArtifact>>();
  return {
    put: (planToken, entry) => {
      let m = byPlan.get(planToken);
      if (!m) {
        m = new Map();
        byPlan.set(planToken, m);
      }
      m.set(entry.bytesEntry, entry);
    },
    get: (planToken, bytesEntry) => byPlan.get(planToken)?.get(bytesEntry) ?? null,
    deleteOne: (planToken, bytesEntry) => {
      byPlan.get(planToken)?.delete(bytesEntry);
    },
    deleteAll: (planToken) => {
      byPlan.delete(planToken);
    },
    clear: () => byPlan.clear(),
  };
}

const defaultArtifactStageStore = createArtifactStageStore();

// ---------------------------------------------------------------------------
// D425 Wave 3 — durable artifact-byte crash journal + reconciler.
//
// The existing artifact flow finalizes durable target bytes (via
// `writeArtifactBlob`) BEFORE the DB transaction that inserts the artifact
// row + namespace junction, and compensates on DETECTED DB-tx failure by
// deleting those bytes. The uncompensated window is a process crash between
// finalize and tx commit: durable bytes exist on disk but no committed row
// points at them, so they leak as unreferenced bytes.
//
// This journal is a minimal, narrowly-scoped safety net for THAT window only.
// It is NOT a general blob GC. Each durable artifact write is bracketed by a
// durable journal record (`prepared` → `finalized` → cleared on tx commit).
// A reconciliation pass (run on route init when enabled, or via the explicit
// exported seam) scans the journal: a record whose DB row + storage URI now
// exists is cleared and its bytes retained; a record with no row has its
// bytes deleted and the record cleared; a malformed/unsafe record is
// quarantined + logged and NEVER used to dereference an arbitrary path.
// ---------------------------------------------------------------------------

/** State of a single durable artifact journal record. */
export type ArtifactJournalState = "prepared" | "finalized";

/** One durable journal record persisted across the finalize→commit window. */
export interface ArtifactJournalRecord {
  /** Plan identity (the in-memory plan token; UUID). */
  readonly planToken: string;
  /** Target-local external artifact id (UUID; the durable file identity). */
  readonly artifactId: string;
  /** Durable target storage URI (`file://<abs>`); the reconciler's lookup key. */
  readonly storageUri: string;
  /** ISO timestamp the record was first prepared. */
  readonly createdAt: string;
  readonly state: ArtifactJournalState;
}

/**
 * Durable, crash-safe journal of in-flight durable artifact writes. The
 * default persists JSON files under the artifacts root; tests inject an
 * in-memory store. `prepare`/`finalize`/`remove` are idempotent per
 * `(planToken, artifactId)`.
 */
export interface ArtifactJournalStore {
  prepare(
    planToken: string,
    artifactId: string,
    storageUri: string,
    createdAt: Date,
  ): Promise<void>;
  finalize(planToken: string, artifactId: string): Promise<void>;
  remove(planToken: string, artifactId: string): Promise<void>;
  list(): readonly ArtifactJournalRecord[];
  /** Move a malformed/unsafe record aside (or drop it) without touching bytes. */
  quarantine(planToken: string, artifactId: string, reason: string): Promise<void>;
}

/** Result of one reconciliation pass. */
export interface ArtifactReconcileResult {
  readonly retained: number;
  readonly cleaned: number;
  readonly quarantined: number;
  readonly failed: number;
}

/** Dependencies for one reconciliation pass. All DB/disk seams are injected. */
export interface ArtifactReconcileDeps {
  /** Journal to scan. */
  journal: ArtifactJournalStore;
  /**
   * Read-only lookup: for each storage URI, return whether a non-deleted
   * `artifacts` row with that `storage_uri` exists. The default issues a
   * single SELECT ... IN (...) against the artifacts table (READ ONLY — no
   * writes outside the existing commit transaction).
   */
  artifactRowsExistByStorageUri: (
    storageUris: readonly string[],
  ) => Promise<ReadonlyMap<string, boolean>>;
  /** Delete durable artifact bytes at a storage URI (compensation). */
  deleteArtifactBlob: (storageUri: string) => Promise<void>;
  /** Resolve the artifacts root; used to validate a record's path is in-bounds. */
  artifactsRoot: () => string;
  /** Resolve a `file://<abs>` storage URI to an absolute path (or null if not file://). */
  absPathFromStorageUri: (storageUri: string) => string | null;
  /** Log a reconciliation event (quarantine / cleanup failure / etc.). */
  log: (message: string) => void;
}

/**
 * Thrown by the default composed import mutation when a target private-
 * namespace path collision is detected inside the tx (an existing,
 * non-deleted artifact already owns the logical `path` in the target
 * namespace). The commit maps this to a 409 `artifact_path_collision` so a
 * bundle can never silently overwrite a target artifact. Tests injecting
 * `commitSourceImport` throw this directly to exercise the 409 path.
 */
export class ArtifactPathCollisionError extends Error {
  readonly path: string;
  readonly namespaceId: string;
  constructor(path: string, namespaceId: string) {
    super(`artifact path collision: ${path}`);
    this.name = "ArtifactPathCollisionError";
    this.path = path;
    this.namespaceId = namespaceId;
  }
}

/**
 * One logical private artifact to import, with its target-local fresh
 * identity (external `artifactId` + durable `storageUri`) and the staged
 * bytes already verified against the plan-bound manifest. The commit hands
 * these to the composed import mutation, which inserts each via
 * `insertPrivateArtifactInTx` inside the SAME caller-owned tx.
 */
export interface PrivateArtifactImportRecord {
  readonly bytesEntry: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  /** Fresh target-local external artifact id (never the source identity). */
  readonly artifactId: string;
  /** Durable target storage URI (written by `writeArtifactBlob` at finalize). */
  readonly storageUri: string;
}

export interface ProfileBundleDeps {
  ownerId?: string | undefined;
  /** Resolve the session user's personal Agent id. */
  resolvePersonalAgentId?: (userId: string) => Promise<string | null>;
  /** Read a profile by agent id (source or target). */
  readProfile?: (agentId: string) => Promise<NautiloProfile | null>;
  /** Read an agent's handle + handleCustomized flag. */
  readAgentHandle?: (
    agentId: string,
  ) => Promise<{ handle: string; handleCustomized: boolean } | null>;
  /** Materialize the selected visible avatar as portable media bytes. */
  readAvatarBytes?: (
    avatar: AvatarRef,
  ) => Promise<{ bytes: Buffer; mimeType: string } | null> | { bytes: Buffer; mimeType: string } | null;
  /** Compute the target-state digest (read-only, in-tx). */
  computeTargetStateDigest?: (agentId: string) => Promise<string>;
  /** This server's instance id. */
  instanceId?: () => string;
  now?: () => Date;
  planStore?: ProfileBundlePlanStore;
  spoolDir?: () => string;
  maxAvatarBytes?: number;
  /** M259 current-RBAC admission for Human-originated private Artifact import. */
  assertCanWriteArtifacts?: AssertCanWriteArtifacts;
  /**
   * D487 composition seam. Production owns create/select through the photo
   * lifecycle and applies the non-photo payload in its caller-owned DB
   * transaction. Tests may inject an equivalent contract; no production
   * fallback may write avatarRef directly.
   */
  commitSourceImport?: (args: CommitSourceImportArgs) => Promise<CommitSourceImportResult>;
  /**
   * D425 Wave 1B — list the source owner's ELIGIBLE private memory records
   * for export. The default opens a caller-owned read transaction and runs
   * every candidate memory through `isMemoryEligibleForPrivateExportInTx`
   * (which walks every `memory_namespaces` + `memory_scopes` edge and
   * accepts only memories purely private to the exporting owner), then
   * projects each legacy survivor onto the `MemoryRecord` contract via
   * `encodePrivateMemoryRecord` (no IDs, no embedding). If an otherwise
   * eligible protected Memory exists, the route returns typed unavailable
   * rather than producing a successful partial backup. Shared / foreign /
   * no-edge memories never surface. Tests inject a curated list.
   */
  listPrivateMemoryRecords?: (
    agentId: string,
    ownerUserId: string,
  ) => Promise<PrivateMemoryRecord[]>;
  /**
   * D425 Wave 1B — re-embed a single source memory's content with the
   * TARGET embedding model. Called OUTSIDE the DB transaction (never inside
   * one); a throw aborts the commit before any mutation runs. Defaults to
   * `embedTextWithProvenance` from `@nautilo/agent`.
   */
  embedTextWithProvenance?: (content: string) => Promise<EmbeddingWithProvenanceV1>;
  /**
   * Read exact portable-record fingerprints across the target personal
   * profile's full private-memory boundary (the same boundary export uses).
   * This powers the plan-time estimate and a fresh pre-commit optimization;
   * the namespace-locked replay remains authoritative for records that still
   * need insertion.
   */
  listTargetPrivateMemoryFingerprints?: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<ReadonlySet<string>>;
  /**
   * D425 Wave 1B — resolve the target personal agent's canonical private
   * namespace id (the 1:1 private Room's namespace). The default reads the
   * owner's single human actor + the default private Room for that actor +
   * agent and returns its `namespace_id`. Returns null when the target has
   * no canonical private namespace (the commit then fails closed — no
   * memory is inserted). Tests inject a fixed id.
   */
  resolveTargetPrivateNamespaceId?: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<string | null>;
  /**
   * D425 Wave 3 — list the source owner's ELIGIBLE private artifact records
   * for the selection preview. The default opens a caller-owned read
   * transaction, enumerates candidate artifacts with at least one
   * `artifact_namespaces` edge, runs EVERY candidate through
   * `isArtifactEligibleForPrivateExportInTx` (which walks every edge and
   * accepts only artifacts purely private to the exporting owner — shared /
   * foreign / no-edge / no-room are rejected; `artifact_scopes` is ignored
   * because subagent-scope runtime behavior is unimplemented), and projects
   * each survivor via `encodePortableArtifact`. Returns the source
   * `artifactInternalId` + portable projection; the route mints the opaque
   * selection token. Tests inject a curated list.
   */
  listPrivateArtifactRecords?: (
    agentId: string,
    ownerUserId: string,
  ) => Promise<PrivateArtifactRecord[]>;
  /**
   * D425 Wave 3 — revalidate a single source artifact's private eligibility
   * AND re-read its observed metadata (path/mime/size/sha) when its bytes
   * are opened/streamed. The default opens a read tx, runs
   * `isArtifactEligibleForPrivateExportInTx`, and re-reads the artifact row.
   * The route compares the returned metadata to the bound snapshot and
   * rejects on any mismatch or ineligible result (fail closed). Selection
   * identity is the opaque token, NEVER the path. Tests inject a fixed
   * result.
   */
  revalidatePrivateArtifact?: (
    agentId: string,
    ownerUserId: string,
    artifactInternalId: string,
  ) => Promise<{
    eligible: boolean;
    path: string;
    mimeType: string;
    size: number;
    sha256: string;
  }>;
  /** Read the raw bytes of a source private artifact (for the stream endpoint). */
  readArtifactBytes?: (
    record: ArtifactSelectionEntry,
  ) => Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * D425 Wave 3 — in-tx check for a target private-namespace path collision.
   * The default mutation calls this inside the caller tx before each
   * `insertPrivateArtifactInTx`; a non-null result makes it throw
   * `ArtifactPathCollisionError` (fail closed — never an overwrite). Tests
   * inject a stub when exercising the default mutation; tests that inject
   * `commitSourceImport` directly throw `ArtifactPathCollisionError`.
   */
  findArtifactByPathInTx?: (
    tx: ProfileMigrationTx,
    path: string,
    namespaceId: string,
  ) => Promise<boolean>;
  /**
   * D425 Wave 3 — DURABLE finalization of staged artifact bytes to target
   * storage. Returns the target-local `storageUri` to hand to
   * `insertPrivateArtifactInTx`. Called BEFORE the DB tx (so the committed
   * row can only point at existing bytes); on DB-tx failure the route
   * compensates by calling `deleteArtifactBlob(storageUri)`. Throws →
   * finalize failed (no DB mutation runs; staged spool cleaned; no durable
   * bytes to compensate). Default writes under the artifacts root.
   */
  writeArtifactBlob?: (
    artifactId: string,
    bytes: Buffer,
    mimeType: string,
  ) => Promise<string>;
  /**
   * D425 Wave 3 — DURABLE compensation: delete finalized artifact bytes when
   * the DB tx failed AFTER `writeArtifactBlob` succeeded. Best-effort
   * (swallowed). A process crash between `writeArtifactBlob` and the tx
   * commit is covered by the durable crash journal + `reconcileArtifactJournal`
   * seam (this slice): the orphaned bytes are deleted on the next
   * reconciliation pass.
   */
  deleteArtifactBlob?: (storageUri: string) => Promise<void>;
  /**
   * D425 Wave 3 — resolve the durable target storage URI for a fresh
   * `artifactId` BEFORE the durable write, so the crash journal can record
   * the storage identity in its `prepared` state (the URI must be known
   * before `writeArtifactBlob` runs). The default returns
   * `file://<getArtifactsRoot()>/<artifactId>`, matching the default
   * `writeArtifactBlob`. When a test injects `writeArtifactBlob` it MUST
   * inject a matching `resolveArtifactStorageUri` so the journal URI equals
   * the URI the writer actually produces (otherwise the reconciler would
   * look at the wrong path on crash recovery).
   */
  resolveArtifactStorageUri?: (artifactId: string, mimeType: string) => string;
  /**
   * D425 Wave 3 — durable crash journal for in-flight artifact writes.
   * Defaults to a file-backed store under the artifacts root; tests inject
   * an in-memory store.
   */
  artifactJournal?: ArtifactJournalStore;
  /**
   * D425 Wave 3 — read-only lookup used by the reconciler: for each storage
   * URI, whether a non-deleted `artifacts` row with that `storage_uri`
   * exists. The default issues a single SELECT ... IN (...) (READ ONLY; no
   * writes outside the existing commit transaction). Tests inject a curated
   * map.
   */
  artifactRowsExistByStorageUri?: (
    storageUris: readonly string[],
  ) => Promise<ReadonlyMap<string, boolean>>;
  /**
   * D425 Wave 3 — run one reconciliation pass over the durable journal at
   * route registration. Default OFF (fire-and-forget when enabled) so the
   * existing app.ts call site and the in-memory test harness are unchanged;
   * production may opt in. The explicit exported `reconcileArtifactJournal`
   * seam is the primary, deterministic entry point (used by tests).
   */
  reconcileOnRouteInit?: boolean;
  /** Override the artifact selection snapshot store (tests inject). */
  artifactSelectionStore?: ArtifactSelectionStore;
  /** Override the staged-artifact store (tests inject). */
  artifactStageStore?: ArtifactStageStore;
  /** Per-artifact byte cap for stage uploads; defaults to ARTIFACT_MAX_BYTES. */
  maxArtifactBytes?: number;
}

/** A single logical private memory to import, with a pre-computed target embedding. */
export interface PrivateMemoryImportRecord {
  readonly content: string;
  /** Pre-computed OUTSIDE the tx; `null` inserts with no embedding provenance. */
  readonly embedding: EmbeddingWithProvenanceV1 | null;
  readonly type?: string;
  readonly importance?: number;
  readonly createdAt?: Date | null;
}

/** Non-photo argument shape applied inside the composed import transaction. */
export interface ApplySourceMutationArgs {
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly name: string;
  readonly handleIntent: HandleIntent;
  readonly profileFields: Wave1AProfilePayload;
  /**
   * D425 Wave 1B — logical private memories to insert into the target's
   * canonical private namespace (`targetNamespaceId`) inside the SAME tx.
   * Empty for Wave 1A bundles (no `privateMemories` scope). Embeddings are
   * pre-computed by the caller; this seam does NO network work in-tx.
   */
  readonly privateMemories?: readonly PrivateMemoryImportRecord[];
  /** Target canonical private namespace; required iff `privateMemories` is non-empty. */
  readonly targetNamespaceId?: string | null;
  /**
   * D425 Wave 3 — logical private artifacts to insert into the target's
   * canonical private namespace (`targetArtifactNamespaceId`) inside the
   * SAME tx, each via `insertPrivateArtifactInTx`. Empty for Wave 1A/1B
   * bundles (no `privateArtifacts` scope). The caller pre-finalizes the
   * durable target bytes OUTSIDE the tx and passes the fresh target-local
   * `artifactId` + `storageUri`; this seam does NO FS work in-tx. A failure
   * on any artifact insert rolls the whole tx back — non-photo profile +
   * identity + every earlier memory + every earlier artifact — so the target
   * is left unchanged. No dedup, no update. A target private-namespace path
   * collision throws `ArtifactPathCollisionError` (fail closed).
   */
  readonly privateArtifacts?: readonly PrivateArtifactImportRecord[];
  /** Target canonical private namespace for artifacts; required iff `privateArtifacts` is non-empty. */
  readonly targetArtifactNamespaceId?: string | null;
}

/** Result shape for the non-photo import mutation. */
export interface ApplySourceMutationResult {
  readonly name: string;
  readonly handle: string;
  readonly handleCustomized: boolean;
  /** Authoritative result from `replayPrivateMemoriesInTx` in this same tx. */
  readonly privateMemoryReplay: PrivateMemoryReplayResult;
}

export interface CommitSourceImportArgs {
  readonly mutation: ApplySourceMutationArgs;
  readonly customPhoto: {
    readonly bytes: Buffer;
    readonly sha256: string;
  } | null;
}

export interface CommitSourceImportResult extends ApplySourceMutationResult {
  readonly avatar: AvatarRef | null;
}

const defaultSpoolDir = (): string => join(tmpdir(), "nautilo-profile-bundle-stage");

function defaultResolvePersonalAgentId(userId: string): Promise<string | null> {
  return findPersonalAgentsForUser(userId).then((rows) => rows[0]?.agentId ?? null);
}

async function defaultReadAgentHandle(
  agentId: string,
): Promise<{ handle: string; handleCustomized: boolean } | null> {
  const rows = await db
    .select({
      handle: agentsTable.handle,
      handleCustomized: agentsTable.handleCustomized,
    })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return rows[0] ?? null;
}

async function defaultReadAvatarBytes(
  avatar: AvatarRef,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (avatar.kind === "preset") {
    const bytes = await readPresetAvatarPng(avatar);
    return bytes ? { bytes, mimeType: "image/png" } : null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(avatar.blobId)) return null;
  const filePath = join(getProfileAvatarsRoot(), avatar.kind, `${avatar.blobId}.png`);
  if (!existsSync(filePath)) return null;
  return { bytes: readFileSync(filePath), mimeType: "image/png" };
}

async function defaultComputeTargetStateDigest(agentId: string): Promise<string> {
  const direct = getServerDirectDb();
  return direct.transaction(async (tx: ProfileMigrationTx) => {
    return computeTargetStateDigestInTx(tx, agentId);
  });
}

/**
 * Apply only the non-photo portion of a source import inside a caller-owned
 * transaction. D487 deliberately keeps avatar creation and selection in the
 * photo-library service; this helper cannot write avatarRef. A
 * `HandleCollisionError` propagates so the route can surface a deterministic
 * 409; any other throw rolls the caller's full composed transaction back.
 *
 * D425 Wave 1B — when `args.privateMemories` is non-empty, the SAME tx also
 * replays each logical record through `replayPrivateMemoriesInTx` into
 * `args.targetNamespaceId` (the target personal agent's canonical private
 * namespace). That primitive acquires the namespace advisory transaction
 * lock before exact portable-record lookup + insert, so overlapping restores
 * cannot create duplicates. Embeddings are pre-computed by the caller
 * OUTSIDE the tx; this function does NO embedding / network work. A throw on
 * any memory insert rolls the whole tx back — profile + identity + every
 * earlier memory — so the target is left unchanged.
 */
async function defaultApplyProfileMutationInTx(
  tx: ProfileMigrationTx,
  args: ApplySourceMutationArgs,
  opts: { findArtifactByPathInTx?: ProfileBundleDeps["findArtifactByPathInTx"] } = {},
): Promise<ApplySourceMutationResult> {
    const ident = await applyProfileIdentityInTx(tx, {
      ownerUserId: args.ownerUserId,
      agentId: args.agentId,
      name: args.name,
      handleIntent: args.handleIntent,
    });
    await applyWave1AProfileFieldsInTx(tx, args.agentId, args.profileFields);
    const privateMems = args.privateMemories ?? [];
    let privateMemoryReplay: PrivateMemoryReplayResult = { added: 0, alreadyPresent: 0 };
    if (privateMems.length > 0) {
      const targetNamespaceId = args.targetNamespaceId;
      if (!targetNamespaceId) {
        throw new Error(
          "defaultApplyProfileMutation: targetNamespaceId is required when privateMemories is non-empty",
        );
      }
      privateMemoryReplay = await replayPrivateMemoriesInTx(tx, {
        targetNamespaceId,
        records: privateMems.map((rec) => ({
          content: rec.content,
          embedding: rec.embedding,
          targetNamespaceId,
          ...(rec.type !== undefined ? { type: rec.type } : {}),
          ...(rec.importance !== undefined ? { importance: rec.importance } : {}),
          ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
        })),
      });
    }
    // D425 Wave 3 — insert each staged artifact via
    // `insertPrivateArtifactInTx` inside the SAME tx. The target path is
    // canonical-validated by the primitive; a target private-namespace path
    // collision fails closed (throws `ArtifactPathCollisionError`) BEFORE
    // any insert, so a bundle can never silently overwrite a target
    // artifact. A throw on any artifact insert rolls the whole tx back —
    // profile + identity + every earlier memory + every earlier
    // artifact — so the target is left unchanged. No dedup, no update. No
    // FS work runs here (bytes are finalized by the caller OUTSIDE the tx).
    const privateArts = args.privateArtifacts ?? [];
    if (privateArts.length > 0) {
      if (!args.targetArtifactNamespaceId) {
        throw new Error(
          "defaultApplyProfileMutation: targetArtifactNamespaceId is required when privateArtifacts is non-empty",
        );
      }
      const collisionCheck = opts.findArtifactByPathInTx ?? defaultFindArtifactByPathInTx;
      for (const art of privateArts) {
        if (!isValidPortableArtifactPath(art.path)) {
          throw new Error(
            "defaultApplyProfileMutation: artifact path is not a safe logical path",
          );
        }
        const collides = await collisionCheck(tx, art.path, args.targetArtifactNamespaceId);
        if (collides) {
          throw new ArtifactPathCollisionError(art.path, args.targetArtifactNamespaceId);
        }
        await insertPrivateArtifactInTx(tx, {
          artifactId: art.artifactId,
          path: art.path,
          mimeType: art.mimeType,
          size: art.size,
          storageUri: art.storageUri,
          targetNamespaceId: args.targetArtifactNamespaceId,
        });
      }
    }
    return { ...ident, privateMemoryReplay };
}

async function resolveBundlePhotoAuthority(
  ownerUserId: string,
  agentId: string,
): Promise<AgentPhotoLibraryAuthority> {
  const direct = getServerDirectDb();
  const [identity] = await direct
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) throw new Error("profile bundle target Server identity is unavailable");
  return {
    serverInstanceId: identity.serverInstanceId,
    viewerUserId: ownerUserId,
    ownerUserId,
    agentId,
  };
}

/**
 * D487 production composition: the accepted portable profile and its photo
 * selection share one DB commit. Custom media is reserved/staged first, then
 * entry creation, non-photo profile/memory/artifact writes, and selection
 * commit together. A failed outer transaction leaves no owned row and the
 * coordinator removes only its deterministic promoted media after proving
 * non-commit. An absent custom avatar is not deletion authority: the current
 * canonical avatar ref remains untouched.
 */
async function defaultCommitSourceImport(
  args: CommitSourceImportArgs,
  opts: { findArtifactByPathInTx?: ProfileBundleDeps["findArtifactByPathInTx"] } = {},
): Promise<CommitSourceImportResult> {
  const direct = getServerDirectDb();

  if (args.customPhoto) {
    const authority = await resolveBundlePhotoAuthority(
      args.mutation.ownerUserId,
      args.mutation.agentId,
    );
    const service = createProductionAgentPhotoLibraryService(direct);
    const coordinator = new AgentPhotoLibraryCreateCoordinator(service);
    let identity: ApplySourceMutationResult | null = null;
    let selection: AgentPhotoSelectionTransactionResult | null = null;
    const createOperationId = randomUUID();
    const selectOperationId = randomUUID();
    const created = await coordinator.produceStageAndFinalize({
      authority,
      operationId: createOperationId,
      source: "bundle_import",
      origin: "bundle_import",
      slotCount: 1,
      semantics: [{
        avatarKind: "uploaded",
        media: {
          mimeType: "image/png",
          byteSize: args.customPhoto.bytes.length,
          sha256: args.customPhoto.sha256,
        },
      }],
      produceCandidates: () => Promise.resolve([{
        kind: "uploaded",
        bytes: args.customPhoto!.bytes,
      }]),
    }, async ({ tx, result }) => {
      identity = await defaultApplyProfileMutationInTx(tx, args.mutation, opts);
      selection = await service.selectInTransaction(tx, {
        authority,
        operationId: selectOperationId,
        expectedSelectionRevision: result.scope.selectionRevision,
        origin: "bundle_import",
        target: { kind: "entry", entryId: result.entryIds[0]! },
      });
    });
    if (!identity || !selection || created.entryIds.length !== 1) {
      throw new Error("profile bundle photo transaction did not produce a complete result");
    }
    const selected = await service.publishCommittedSelection(selection);
    const committedIdentity = identity as ApplySourceMutationResult;
    return { ...committedIdentity, avatar: selected.currentAvatarRef };
  }

  return direct.transaction(async (tx: ProfileMigrationTx) => {
    const applied = await defaultApplyProfileMutationInTx(tx, args.mutation, opts);
    const [profile] = await tx
      .select({ avatarRef: profiles.avatarRef })
      .from(profiles)
      .where(eq(profiles.agentId, args.mutation.agentId))
      .limit(1);
    if (!profile) throw new Error("profile bundle target profile is unavailable");
    return { ...applied, avatar: profile.avatarRef };
  });
}

/**
 * D425 Wave 1B default — list the source owner's ELIGIBLE private memory
 * records for export. Opens a read transaction, enumerates candidate memory
 * ids that have at least one edge to the owner's personal-agent scope or a
 * private Room owned by the owner, then runs EVERY candidate through
 * `isMemoryEligibleForPrivateExportInTx` (which walks every
 * `memory_namespaces` + `memory_scopes` edge and accepts only memories
 * purely private to the exporting owner — shared / foreign / no-edge
 * memories are rejected), and projects each survivor onto the `MemoryRecord`
 * contract via `encodePrivateMemoryRecord` (type preserved; no IDs or embedding).
 *
 * The candidate query is a deliberate SUPERSET; the eligibility primitive is
 * the real gate, so a shared memory that happens to touch an owner-private
 * edge is still rejected by the primitive (it inspects every edge, not just
 * the candidate edge). No content / embedding / ID is emitted for rejected
 * memories.
 */
async function defaultListPrivateMemoryRecords(
  agentId: string,
  ownerUserId: string,
): Promise<PrivateMemoryRecord[]> {
  const direct = getServerDirectDb();
  return direct.transaction(async (tx: ProfileMigrationTx) => {
    // Resolve the exporting owner's single human actor (same rule the
    // eligibility primitive applies). Used to broaden the namespace candidate
    // to any private/access Room whose human set contains the owner — the
    // primitive then rejects a Room with extra humans.
    const ownerActorRows = await tx
      .select({ id: actorsTable.id })
      .from(actorsTable)
      .where(and(eq(actorsTable.ownerId, ownerUserId), eq(actorsTable.kind, "user")))
      .limit(2);
    const ownerActorId =
      ownerActorRows.length === 1 ? (ownerActorRows[0]?.id ?? null) : null;

    // Candidate superset: memories with a scope edge to
    // (personalAgentId, ownerUserId), OR — when the owner resolves to one
    // human actor — a namespace edge to a private Room whose human set
    // contains that actor. The eligibility primitive is the real gate; it
    // walks every edge and rejects any shared / foreign one.
    const scopeCandidate = exists(
      tx.select({ value: sql`1` }).from(memoryScopes).innerJoin(
        agentScopes,
        eq(agentScopes.id, memoryScopes.scopeId),
      ).where(and(
        eq(memoryScopes.memoryId, memories.id),
        eq(agentScopes.parentAgentId, agentId),
        eq(agentScopes.speakerUserId, ownerUserId),
      )),
    );
    const candidatePredicate = ownerActorId === null
      ? scopeCandidate
      : or(scopeCandidate, exists(
        tx.select({ value: sql`1` }).from(memoryNamespaces).innerJoin(
          rooms,
          eq(rooms.namespaceId, memoryNamespaces.namespaceId),
        ).where(and(
          eq(memoryNamespaces.memoryId, memories.id),
          eq(rooms.type, "private"),
          sql`${rooms.humanActorIds} @> ARRAY[${ownerActorId}]::uuid[]`,
        )),
      ));
    const rows = await tx.select({
      id: memories.id,
      crypto_object_id: memories.cryptoObjectId,
    }).from(memories).where(candidatePredicate);
    const seen = new Set<string>();
    const ordered: Array<{ id: string; protected: boolean }> = [];
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        seen.add(r.id);
        ordered.push({ id: r.id, protected: r.crypto_object_id !== null });
      }
    }

    const records: PrivateMemoryRecord[] = [];
    for (const candidate of ordered) {
      const eligibility = await isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: candidate.id,
        ownerUserId,
        personalAgentId: agentId,
      });
      if (!eligibility.eligible) continue;
      if (candidate.protected) {
        records.push({
          recordKind: "memory",
          scope: "private",
          type: PROTECTED_MEMORY_PLACEHOLDER_TYPE,
          content: "",
          createdAt: null,
        });
        continue;
      }
      const [mem] = await tx
        .select({
          type: memories.type,
          content: memories.content,
          createdAt: memories.createdAt,
        })
        .from(memories)
        .where(and(eq(memories.id, candidate.id), isNull(memories.cryptoObjectId)))
        .limit(1);
      if (!mem) continue;
      if (mem.type === null || mem.content === null) {
        throw new Error(
          `Profile bundle private memory ${candidate.id} ordinary content is unavailable`,
        );
      }
      records.push(
        encodePrivateMemoryRecord({
          type: mem.type,
          content: mem.content,
          createdAt: mem.createdAt,
        }),
      );
    }
    return records;
  });
}

/**
 * D425 Wave 1B default — resolve the target personal agent's canonical
 * private namespace id: the owner's single human actor → the default
 * private Room for (actor, agent) → that Room's `namespace_id`. Returns null
 * when the owner has no single human actor or no default private Room (the
 * commit then fails closed — no memory is inserted).
 */
async function defaultResolveTargetPrivateNamespaceId(
  ownerUserId: string,
  agentId: string,
): Promise<string | null> {
  const actorRows = await db
    .select({ id: actorsTable.id })
    .from(actorsTable)
    .where(and(eq(actorsTable.ownerId, ownerUserId), eq(actorsTable.kind, "user")))
    .limit(2);
  if (actorRows.length !== 1) return null;
  const ownerActorId = actorRows[0]?.id ?? null;
  if (!ownerActorId) return null;
  const room = await findDefaultRoomForActor(ownerActorId, agentId);
  if (!room) return null;
  const access = await getRoomWithAccess(room.id);
  return access?.namespaceId ?? null;
}

/**
 * Best-effort profile-wide snapshot for a target restore. Export collects
 * private memories across every eligible private Room / scope belonging to
 * the personal profile, so import must compare against that same boundary.
 * Comparing only the canonical insertion namespace incorrectly labels
 * memories in the profile's other private chats as new.
 *
 * The commit refreshes this snapshot before embedding. Records that remain
 * candidates are still handed to `replayPrivateMemoriesInTx`, whose canonical
 * insertion-namespace lock is authoritative for concurrent restore inserts.
 */
async function defaultListTargetPrivateMemoryFingerprints(
  ownerUserId: string,
  agentId: string,
): Promise<ReadonlySet<string>> {
  const records = await defaultListPrivateMemoryRecords(agentId, ownerUserId);
  return new Set(
    records
      .filter((record) => !isProtectedMemoryLegacyPlaceholder(record))
      .map((record) => fingerprintPrivateMemoryRecord(record)),
  );
}

// ---------------------------------------------------------------------------
// D425 Wave 3 — default seams for the private-artifact surface. Production
// reads through the committed eligibility primitive + the artifacts root;
// tests inject curated values so the contract is unit-testable with no DB.
// ---------------------------------------------------------------------------

/** Resolve a `file://<abs>` storage URI to an absolute filesystem path. */
function absPathFromStorageUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const rest = storageUri.slice("file://".length);
  if (!rest.startsWith("/")) return null;
  return rest;
}

/** Read an artifact's bytes from its `storage_uri` and SHA-256 them. */
function readArtifactBytesAndHash(storageUri: string): {
  bytes: Buffer;
  sha256: string;
} | null {
  const abs = absPathFromStorageUri(storageUri);
  if (!abs || !existsSync(abs)) return null;
  const bytes = readFileSync(abs);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * D425 Wave 3 default — list the source owner's ELIGIBLE private artifact
 * records for the selection preview. Opens a read tx, enumerates candidate
 * artifacts with at least one `artifact_namespaces` edge to a private Room
 * whose human set contains the owner's human actor (a deliberate superset;
 * `isArtifactEligibleForPrivateExportInTx` is the real gate and walks every
 * edge), runs every candidate through the primitive, and projects each
 * survivor via `encodePortableArtifact` + a bytes-derived sha256. Shared /
 * foreign / no-edge artifacts never surface.
 */
async function defaultListPrivateArtifactRecords(
  _agentId: string,
  ownerUserId: string,
): Promise<PrivateArtifactRecord[]> {
  const direct = getServerDirectDb();
  return direct.transaction(async (tx: ProfileMigrationTx) => {
    const ownerActorRows = await tx
      .select({ id: actorsTable.id })
      .from(actorsTable)
      .where(and(eq(actorsTable.ownerId, ownerUserId), eq(actorsTable.kind, "user")))
      .limit(2);
    const ownerActorId =
      ownerActorRows.length === 1 ? (ownerActorRows[0]?.id ?? null) : null;

    const namespaceClause = ownerActorId
      ? sql`
        OR EXISTS (
          SELECT 1 FROM artifact_namespaces an
          INNER JOIN rooms r ON r.namespace_id = an.namespace_id
          WHERE an.artifact_id = a.id
            AND r.type = 'private'
            AND r.human_actor_ids @> ARRAY[${ownerActorId}]::uuid[]
        )`
      : sql``;
    const candidateRows = (await tx.execute<{ id: string }>(sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.deleted_at IS NULL
      AND a.crypto_object_id IS NULL
      AND EXISTS (
        SELECT 1 FROM artifact_namespaces an
        INNER JOIN rooms r ON r.namespace_id = an.namespace_id
        WHERE an.artifact_id = a.id
          AND r.type = 'private'
          ${ownerActorId ? sql`AND r.human_actor_ids @> ARRAY[${ownerActorId}]::uuid[]` : sql``}
      )
      ${namespaceClause}
    `)) as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const rows = Array.isArray(candidateRows) ? candidateRows : candidateRows.rows;
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        seen.add(r.id);
        ordered.push(r.id);
      }
    }

    const records: PrivateArtifactRecord[] = [];
    for (const artifactInternalId of ordered) {
      const eligibility = await isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId,
        ownerUserId,
      });
      if (!eligibility.eligible) continue;
      const [row] = await tx
        .select({
          path: artifactsTable.path,
          mimeType: artifactsTable.mimeType,
          size: artifactsTable.size,
          storageUri: artifactsTable.storageUri,
        })
        .from(artifactsTable)
        .where(and(
          eq(artifactsTable.id, artifactInternalId),
          isNull(artifactsTable.cryptoObjectId),
        ))
        .limit(1);
      if (
        !row
        || row.path === null
        || row.mimeType === null
        || row.size === null
        || row.storageUri === null
      ) continue;
      const hashed = readArtifactBytesAndHash(row.storageUri);
      const sha256 = hashed?.sha256 ?? "";
      const encoded = encodePortableArtifact({
        path: row.path,
        mimeType: row.mimeType,
        size: Number(row.size),
        sha256,
        bytesEntry: `media/artifacts/${randomUUID()}.bin`,
      });
      if (!encoded.ok) continue;
      records.push({
        artifactInternalId,
        path: encoded.artifact.path,
        mimeType: encoded.artifact.mimeType,
        size: encoded.artifact.size,
        sha256: encoded.artifact.sha256,
      });
    }
    return records;
  });
}

/**
 * D425 Wave 3 default — revalidate a single source artifact's private
 * eligibility AND re-read its observed metadata (path/mime/size/sha) when
 * its bytes are opened/streamed. The route compares the returned metadata
 * to the bound snapshot and rejects on any mismatch or ineligible result.
 */
async function defaultRevalidatePrivateArtifact(
  _agentId: string,
  ownerUserId: string,
  artifactInternalId: string,
): Promise<{
  eligible: boolean;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}> {
  const direct = getServerDirectDb();
  return direct.transaction(async (tx: ProfileMigrationTx) => {
    const eligibility = await isArtifactEligibleForPrivateExportInTx(tx, {
      artifactInternalId,
      ownerUserId,
    });
    if (!eligibility.eligible) {
      return { eligible: false, path: "", mimeType: "", size: 0, sha256: "" };
    }
    const [row] = await tx
      .select({
        path: artifactsTable.path,
        mimeType: artifactsTable.mimeType,
        size: artifactsTable.size,
        storageUri: artifactsTable.storageUri,
      })
      .from(artifactsTable)
      .where(and(
        eq(artifactsTable.id, artifactInternalId),
        isNull(artifactsTable.cryptoObjectId),
      ))
      .limit(1);
    if (
      !row
      || row.path === null
      || row.mimeType === null
      || row.size === null
      || row.storageUri === null
    ) {
      return { eligible: false, path: "", mimeType: "", size: 0, sha256: "" };
    }
    const hashed = readArtifactBytesAndHash(row.storageUri);
    return {
      eligible: true,
      path: row.path,
      mimeType: row.mimeType,
      size: Number(row.size),
      sha256: hashed?.sha256 ?? "",
    };
  });
}

async function defaultReadArtifactBytes(
  record: ArtifactSelectionEntry,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  // The selection entry carries logical metadata only (no storage URI —
  // storage URIs never travel in the selection contract). The default re-
  // resolves the source artifact's `storage_uri` by its internal id and
  // reads the bytes back. A missing row / unreadable file returns null
  // (fail-closed → the stream endpoint surfaces `artifact_bytes_unavailable`).
  const direct = getServerDirectDb();
  let storageUri: string | null = null;
  try {
    await direct.transaction(async (tx: ProfileMigrationTx) => {
      const [row] = await tx
        .select({ storageUri: artifactsTable.storageUri })
        .from(artifactsTable)
        .where(and(
          eq(artifactsTable.id, record.artifactInternalId),
          isNull(artifactsTable.cryptoObjectId),
        ))
        .limit(1);
      storageUri = row?.storageUri ?? null;
      return null;
    });
  } catch {
    storageUri = null;
  }
  if (!storageUri) return null;
  const hashed = readArtifactBytesAndHash(storageUri);
  if (!hashed) return null;
  return { bytes: hashed.bytes, mimeType: record.mimeType };
}

/** D425 Wave 3 default — in-tx target private-namespace path collision check. */
async function defaultFindArtifactByPathInTx(
  tx: ProfileMigrationTx,
  path: string,
  namespaceId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: artifactsTable.id })
    .from(artifactsTable)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifactsTable.id),
    )
    .where(
      and(
        eq(artifactsTable.path, path),
        eq(artifactNamespaces.namespaceId, namespaceId),
        isNull(artifactsTable.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * D425 Wave 3 default — DURABLE finalization of staged artifact bytes to
 * the target artifacts root. Writes `<root>/<artifactId>` and returns the
 * `file://<abs>` storage URI handed to `insertPrivateArtifactInTx`.
 */
async function defaultWriteArtifactBlob(
  artifactId: string,
  bytes: Buffer,
  _mimeType: string,
): Promise<string> {
  const root = getArtifactsRoot();
  await mkdir(root, { recursive: true });
  const abs = join(root, artifactId);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(abs, bytes);
  return `file://${abs}`;
}

/** D425 Wave 3 default — DURABLE compensation: delete finalized artifact bytes. */
async function defaultDeleteArtifactBlob(storageUri: string): Promise<void> {
  const abs = absPathFromStorageUri(storageUri);
  if (abs) await rm(abs, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// D425 Wave 3 — durable artifact-byte crash journal: defaults + reconciler.
// ---------------------------------------------------------------------------

const JOURNAL_SUBDIR = ".profile-bundle-artifact-journal";
const JOURNAL_QUARANTINE_SUBDIR = ".quarantine";

/** Resolve the default journal directory (sibling of the artifacts root). */
function defaultArtifactJournalDir(): string {
  return join(getArtifactsRoot(), JOURNAL_SUBDIR);
}

/** Sanitize a plan/artifact id into a safe filename component (UUIDs already are). */
function safeJournalSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function journalFileName(planToken: string, artifactId: string): string {
  return `${safeJournalSegment(planToken)}__${safeJournalSegment(artifactId)}.json`;
}

/** Validate + parse a journal file's JSON into a record, or return null (malformed). */
function parseJournalRecord(raw: string): ArtifactJournalRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const planToken = o["planToken"];
  const artifactId = o["artifactId"];
  const storageUri = o["storageUri"];
  const createdAt = o["createdAt"];
  const state = o["state"];
  if (typeof planToken !== "string" || planToken.length === 0) return null;
  if (typeof artifactId !== "string" || artifactId.length === 0) return null;
  if (typeof storageUri !== "string" || storageUri.length === 0) return null;
  if (typeof createdAt !== "string" || createdAt.length === 0) return null;
  if (state !== "prepared" && state !== "finalized") return null;
  return { planToken, artifactId, storageUri, createdAt, state };
}

/**
 * D425 Wave 3 default — durable, file-backed journal. Each record is one JSON
 * file under `<artifactsRoot>/.profile-bundle-artifact-journal/`. Writes are
 * atomic (temp file + rename). `list()` reads the directory and skips+flags
 * malformed files (the reconciler quarantines them). `remove`/`finalize` are
 * idempotent (missing file is a no-op). No directory side-effect at import
 * time; `prepare` mkdirs on first use.
 */
function createArtifactJournalStore(
  journalDir: string = defaultArtifactJournalDir(),
): ArtifactJournalStore {
  const pathFor = (planToken: string, artifactId: string) =>
    join(journalDir, journalFileName(planToken, artifactId));
  return {
    prepare: async (planToken, artifactId, storageUri, createdAt) => {
      await mkdir(journalDir, { recursive: true });
      const record: ArtifactJournalRecord = {
        planToken,
        artifactId,
        storageUri,
        createdAt: createdAt.toISOString(),
        state: "prepared",
      };
      const target = pathFor(planToken, artifactId);
      const tmp = `${target}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(record), "utf8");
      await rename(tmp, target);
    },
    finalize: async (planToken, artifactId) => {
      const target = pathFor(planToken, artifactId);
      if (!existsSync(target)) return;
      const raw = readFileSync(target, "utf8");
      const rec = parseJournalRecord(raw);
      if (!rec) return;
      if (rec.state === "finalized") return;
      const updated: ArtifactJournalRecord = { ...rec, state: "finalized" };
      const tmp = `${target}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(updated), "utf8");
      await rename(tmp, target);
    },
    remove: async (planToken, artifactId) => {
      const target = pathFor(planToken, artifactId);
      await unlink(target).catch(() => {
        // idempotent: a missing record is the desired post-state.
      });
    },
    list: () => {
      if (!existsSync(journalDir)) return [];
      const names = readdirSync(journalDir);
      const out: ArtifactJournalRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        if (name.endsWith(".tmp")) continue;
        try {
          const raw = readFileSync(join(journalDir, name), "utf8");
          const rec = parseJournalRecord(raw);
          if (rec) out.push(rec);
        } catch {
          // skip unreadable/malformed; reconciler quarantines via list+scan
        }
      }
      return out;
    },
    quarantine: async (planToken, artifactId, _reason) => {
      const target = pathFor(planToken, artifactId);
      if (!existsSync(target)) return;
      const qDir = join(journalDir, JOURNAL_QUARANTINE_SUBDIR);
      await mkdir(qDir, { recursive: true });
      const dest = join(
        qDir,
        `${journalFileName(planToken, artifactId)}.${Date.now()}`,
      );
      await rename(target, dest).catch(() => {
        // best-effort move; if it fails the record stays in place (retryable).
      });
    },
  };
}

/**
 * D425 Wave 3 — in-memory journal store for tests. Same contract as the
 * durable file-backed store but non-persistent: `list()` reflects
 * `prepare`/`finalize`/`remove` calls within the process. `quarantine`
 * drops the record (tests assert via `list()` that it is gone).
 */
export function createInMemoryArtifactJournalStore(): ArtifactJournalStore {
  const records = new Map<string, ArtifactJournalRecord>();
  const key = (planToken: string, artifactId: string) => `${planToken}::${artifactId}`;
  return {
    prepare: (planToken, artifactId, storageUri, createdAt) => {
      records.set(key(planToken, artifactId), {
        planToken,
        artifactId,
        storageUri,
        createdAt: createdAt.toISOString(),
        state: "prepared",
      });
      return Promise.resolve();
    },
    finalize: (planToken, artifactId) => {
      const k = key(planToken, artifactId);
      const rec = records.get(k);
      if (rec && rec.state !== "finalized") {
        records.set(k, { ...rec, state: "finalized" });
      }
      return Promise.resolve();
    },
    remove: (planToken, artifactId) => {
      records.delete(key(planToken, artifactId));
      return Promise.resolve();
    },
    list: () => [...records.values()],
    quarantine: (planToken, artifactId) => {
      records.delete(key(planToken, artifactId));
      return Promise.resolve();
    },
  };
}

/**
 * D425 Wave 3 default — resolve the durable target storage URI for a fresh
 * `artifactId` BEFORE the durable write. Matches `defaultWriteArtifactBlob`
 * (`file://<getArtifactsRoot()>/<artifactId>`).
 */
function defaultResolveArtifactStorageUri(
  artifactId: string,
  _mimeType: string,
): string {
  return `file://${join(getArtifactsRoot(), artifactId)}`;
}

/**
 * D425 Wave 3 default — read-only lookup for the reconciler. Issues a single
 * SELECT against `artifacts` for the given storage URIs where `deleted_at`
 * IS NULL, returning a map of `storageUri → exists`. READ ONLY: no writes,
 * and never inside the commit transaction.
 */
async function defaultArtifactRowsExistByStorageUri(
  storageUris: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const out = new Map<string, boolean>();
  if (storageUris.length === 0) return out;
  const rows = await db
    .select({ storageUri: artifactsTable.storageUri })
    .from(artifactsTable)
    .where(
      and(
        inArray(artifactsTable.storageUri, [...storageUris]),
        isNull(artifactsTable.deletedAt),
        isNull(artifactsTable.cryptoObjectId),
      ),
    );
  for (const r of rows) {
    if (r.storageUri !== null) out.set(r.storageUri, true);
  }
  return out;
}

/**
 * D425 Wave 3 — run one reconciliation pass over the durable artifact
 * journal. For each record:
 *   - validate the record shape AND that its storage URI resolves to a path
 *     inside the artifacts root (never dereference an arbitrary path);
 *     malformed/unsafe records are quarantined + logged and their bytes are
 *     NEVER touched;
 *   - if a non-deleted `artifacts` row with that storage URI exists → the
 *     commit landed: clear the journal record, RETAIN the bytes;
 *   - if no row exists → the commit did not land: DELETE the durable bytes,
 *     then clear the journal record. A delete FAILURE is logged and the
 *     record is LEFT in place so a later pass can retry (never swallowed as
 *     success).
 *
 * Staged spool cleanup is separate and NOT touched here. This is a minimal
 * crash-window reconciler, NOT a general blob GC.
 */
export async function reconcileArtifactJournal(
  deps: ArtifactReconcileDeps,
): Promise<ArtifactReconcileResult> {
  const root = resolve(deps.artifactsRoot());
  const records = deps.journal.list();
  let retained = 0;
  let cleaned = 0;
  let quarantined = 0;
  let failed = 0;

  // Validate each record: storage URI must be a `file://<abs>` path that
  // resolves INSIDE the artifacts root. A malformed/unsafe record is never
  // used to dereference a path — it is quarantined + logged and its bytes
  // are never touched. `relative` + leading-`..` guard rejects traversal
  // without touching the FS.
  const inBounds = (r: ArtifactJournalRecord): boolean => {
    const abs = deps.absPathFromStorageUri(r.storageUri);
    if (abs === null) return false;
    const rel = relative(root, resolve(abs));
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
  };
  const wellFormed = records.filter(inBounds);
  const malformed = records.filter((r) => !inBounds(r));

  for (const r of malformed) {
    deps.log(
      `[profile-bundle] reconcile: quarantining malformed/unsafe journal record ` +
        `planToken=${r.planToken} artifactId=${r.artifactId} ` +
        `(storageUri not a file:// path inside the artifacts root)`,
    );
    await deps.journal.quarantine(r.planToken, r.artifactId, "malformed").catch(() => {});
    quarantined += 1;
  }

  let existsMap: ReadonlyMap<string, boolean> = new Map();
  if (wellFormed.length > 0) {
    try {
      existsMap = await deps.artifactRowsExistByStorageUri(
        wellFormed.map((r) => r.storageUri),
      );
    } catch (e) {
      deps.log(
        `[profile-bundle] reconcile: artifact row lookup failed: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      // Without a DB answer we cannot decide retain vs delete safely; leave
      // all records retryable. Do NOT delete bytes on a lookup failure.
      failed += wellFormed.length;
      return { retained, cleaned, quarantined, failed };
    }
  }

  for (const r of wellFormed) {
    const rowExists = existsMap.get(r.storageUri) === true;
    if (rowExists) {
      // Commit landed: retain bytes, clear the journal record.
      try {
        await deps.journal.remove(r.planToken, r.artifactId);
        retained += 1;
      } catch (e) {
        failed += 1;
        deps.log(
          `[profile-bundle] reconcile: failed to clear journal record for retained artifact ` +
            `artifactId=${r.artifactId}; left retryable: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    } else {
      // Commit did not land: delete the orphaned durable bytes.
      try {
        await deps.deleteArtifactBlob(r.storageUri);
        await deps.journal.remove(r.planToken, r.artifactId);
        cleaned += 1;
      } catch (e) {
        failed += 1;
        deps.log(
          `[profile-bundle] reconcile: delete failed for orphaned artifact bytes ` +
            `artifactId=${r.artifactId}; left retryable: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }
  }
  return { retained, cleaned, quarantined, failed };
}

// ---------------------------------------------------------------------------
// Semantic mapping: NautiloProfile + agent handle state → GenieLiveV1 records
// ---------------------------------------------------------------------------

function toPortableVoices(voices: NautiloProfile["voices"]): semantic.VoiceMapEntry[] {
  const out: semantic.VoiceMapEntry[] = [];
  for (const [lang, ref] of Object.entries(voices ?? {})) {
    if (!ref || typeof ref.voiceId !== "string" || typeof ref.voiceName !== "string") {
      continue;
    }
    out.push({
      slot: lang,
      voiceId: ref.voiceId,
      label: ref.voiceName,
      provider: null,
      voiceUri: null,
    });
  }
  return out;
}

/**
 * Build the ordered semantic record set for a source profile. ID-free by
 * construction: only the D425-approved portable fields are read off the
 * profile row; lifecycle/identity/timestamp columns are never touched.
 */
function buildSemanticRecords(
  profile: NautiloProfile,
  agentHandle: { handle: string; handleCustomized: boolean } | null,
  avatarSha256: string | null,
): SemanticRecord[] {
  const records: SemanticRecord[] = [];
  const prefs: Record<string, string | number | boolean | null> = {};

  records.push({
    recordKind: "identity",
    name: profile.name,
    handleIntent: agentHandle?.handleCustomized ? (agentHandle.handle ?? null) : null,
  });

  records.push({ recordKind: "soul", text: profile.soulFile ?? null });
  records.push({ recordKind: "personality", text: profile.personalityPrompt ?? null });
  records.push({ recordKind: "voices", voices: toPortableVoices(profile.voices) });
  records.push({
    recordKind: "modelPolicy",
    policy: {
      primaryModel: profile.defaultModel ?? null,
      fallbackModel: null,
      temperature: null,
    },
  });

  if (avatarSha256 !== null) {
    records.push({
      recordKind: "avatar",
      avatar: {
        mediaEntry: `media/${AVATAR_MEDIA_ENTRY}`,
        mimeType: "image/png",
        sha256: avatarSha256,
        width: null,
        height: null,
      },
    });
  } else {
    records.push({ recordKind: "avatar", avatar: null });
  }

  // Scalar preferences only — the frozen Wave 0 preferences record rejects
  // arrays, so the ordered fallbackChain has no contract home in Wave 1A
  // (tracked deferral; see closing report).
  if (typeof profile.language === "string") prefs["language"] = profile.language;
  if (profile.personalityTone !== null && profile.personalityTone !== undefined) {
    prefs["personalityTone"] = profile.personalityTone;
  }
  if (profile.motherAnswer !== null && profile.motherAnswer !== undefined) {
    prefs["motherAnswer"] = profile.motherAnswer;
  }
  if (profile.privacySpectrum !== null && profile.privacySpectrum !== undefined) {
    prefs["privacySpectrum"] = profile.privacySpectrum;
  }
  if (profile.workLifeMode !== null && profile.workLifeMode !== undefined) {
    prefs["workLifeMode"] = profile.workLifeMode;
  }
  if (profile.voiceId !== null && profile.voiceId !== undefined) {
    prefs["voiceId"] = profile.voiceId;
  }
  if (profile.voiceName !== null && profile.voiceName !== undefined) {
    prefs["voiceName"] = profile.voiceName;
  }
  prefs["fallbackEnabled"] = profile.fallbackEnabled === true;
  records.push({ recordKind: "preferences", preferences: prefs });

  return records;
}

/** SHA-256 hex of a Buffer. */
function sha256HexBuf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conflict detection (read-only): which groups differ between source & target
// ---------------------------------------------------------------------------

function recordByKind(records: readonly SemanticRecord[], kind: SemanticRecord["recordKind"]): SemanticRecord | undefined {
  return records.find((r) => r.recordKind === kind);
}

/** Stringify a preference value without risking `[object Object]`. */
function prefStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return "";
}

/**
 * Compare the source bundle's record groups against the target's current
 * profile/handle state and return the groups that differ. Wave 1A applies one
 * explicit whole-profile `source|target` choice across every group, so the
 * returned list is informational (it tells the CLI what the choice WOULD
 * change); the `choice` on each entry mirrors the requested whole-profile
 * choice.
 */
function detectConflicts(
  source: GenieLiveV1,
  target: NautiloProfile | null,
  targetHandle: { handle: string; handleCustomized: boolean } | null,
  wholeProfileChoice: WholeProfileChoice,
): ProfileBundleConflict[] {
  const conflicts: ProfileBundleConflict[] = [];
  const mark = (group: ProfileConflictGroup): void => {
    conflicts.push({ group, choice: wholeProfileChoice });
  };

  const identity = recordByKind(source.records, "identity");
  if (identity && identity.recordKind === "identity") {
    const targetName = target?.name ?? "";
    if (identity.name !== targetName) mark("identity");
  }

  const soul = recordByKind(source.records, "soul");
  if (soul && soul.recordKind === "soul") {
    if ((soul.text ?? null) !== (target?.soulFile ?? null)) mark("soul");
  }

  const personality = recordByKind(source.records, "personality");
  if (personality && personality.recordKind === "personality") {
    if ((personality.text ?? null) !== (target?.personalityPrompt ?? null)) mark("personality");
  }

  const voices = recordByKind(source.records, "voices");
  if (voices && voices.recordKind === "voices") {
    const targetVoices = canonicalJson(toPortableVoices(target?.voices ?? {}));
    const sourceVoices = canonicalJson(voices.voices);
    if (targetVoices !== sourceVoices) mark("voices");
  }

  const modelPolicy = recordByKind(source.records, "modelPolicy");
  if (modelPolicy && modelPolicy.recordKind === "modelPolicy") {
    if ((modelPolicy.policy.primaryModel ?? null) !== (target?.defaultModel ?? null)) {
      mark("modelPolicy");
    }
  }

  const avatar = recordByKind(source.records, "avatar");
  if (avatar && avatar.recordKind === "avatar") {
    const sourceHas = avatar.avatar !== null;
    const targetAvatar = target?.avatar ?? null;
    const targetHasCustom = targetAvatar !== null && targetAvatar.kind !== "preset";
    // `avatar: null` is not an explicit clear instruction: legacy bundles use
    // it for preset avatars and omission as well. Only actual source media can
    // request an avatar change.
    if (sourceHas && !targetHasCustom) mark("avatar");
  }

  const preferences = recordByKind(source.records, "preferences");
  if (preferences && preferences.recordKind === "preferences") {
    const src = preferences.preferences as Record<string, unknown>;
    const differs =
      prefStr(src["language"]) !== String(target?.language ?? "") ||
      prefStr(src["personalityTone"]) !== String(target?.personalityTone ?? "") ||
      prefStr(src["motherAnswer"]) !== String(target?.motherAnswer ?? "") ||
      prefStr(src["privacySpectrum"]) !== String(target?.privacySpectrum ?? "") ||
      prefStr(src["workLifeMode"]) !== String(target?.workLifeMode ?? "") ||
      prefStr(src["voiceId"]) !== String(target?.voiceId ?? "") ||
      prefStr(src["voiceName"]) !== String(target?.voiceName ?? "") ||
      Boolean(src["fallbackEnabled"]) === Boolean(target?.fallbackEnabled) === false;
    if (differs) mark("preferences");
  }

  void targetHandle;
  return conflicts;
}

// ---------------------------------------------------------------------------
// Wave 1A supported scope + request helpers
// ---------------------------------------------------------------------------

const WAVE_1A_SUPPORTED_SCOPES: readonly PortableScope[] = ["profile", "avatar"];

// D425 Wave 1B widens the supported-scope set to `privateMemories`. The codec
// already defines the scope; the import path only accepts it when the bundle
// carries it AND the caller requests it. `profile` + `avatar` remain the
// Wave 1A set so a bundle that omits `privateMemories` behaves exactly like
// Wave 1A (no memory work runs). `WAVE_1A_SUPPORTED_SCOPES` is retained as
// the documented Wave 1A baseline; the live gate is the Wave 1B set below.
const WAVE_1B_SUPPORTED_SCOPES: readonly PortableScope[] = [
  ...WAVE_1A_SUPPORTED_SCOPES,
  "privateMemories",
];
const PRIVATE_MEMORIES_SCOPE: PortableScope = "privateMemories";

// D425 Wave 3 widens the supported-scope set further to `privateArtifacts`.
// The codec already defines the scope and validates artifact records + the
// artifactMedia manifest; the import path only accepts it when the bundle
// carries it AND the caller requests it. A bundle that omits
// `privateArtifacts` behaves exactly like Wave 1B (no artifact work runs).
// `WAVE_1B_SUPPORTED_SCOPES` is retained as the documented Wave 1B baseline;
// the live gate is the Wave 3 set below.
const WAVE_3_SUPPORTED_SCOPES: readonly PortableScope[] = [
  ...WAVE_1B_SUPPORTED_SCOPES,
  "privateArtifacts",
];
const WAVE_3_SUPPORTED_SCOPE_SET: ReadonlySet<string> = new Set(
  WAVE_3_SUPPORTED_SCOPES,
);
const PRIVATE_ARTIFACTS_SCOPE: PortableScope = "privateArtifacts";

function defaultReadProfile(agentId: string): Promise<NautiloProfile | null> {
  return getProfileByAgentId(agentId);
}

function defaultInstanceId(): string {
  return parseNautiloInstanceId(process.env);
}

function isWholeProfileChoice(v: unknown): v is WholeProfileChoice {
  return v === "source" || v === "target";
}

function isPortableScopeValue(v: unknown): v is PortableScope {
  return (
    typeof v === "string" &&
    (ALL_PORTABLE_SCOPES as readonly string[]).includes(v)
  );
}

/**
 * Extract the avatar media summary (bare entry name + sha256 + mime) from a
 * bundle's `avatar` record. Returns null when the source carried no custom
 * avatar (preset ref needs no copy). Strips the `media/` manifest prefix so
 * the stage/media HTTP contract uses the bare filename (`avatar.bin`).
 */
function avatarMediaFromBundle(
  bundle: GenieLiveV1,
): { mediaEntry: string; sha256: string; mimeType: string } | null {
  const rec = bundle.records.find((r) => r.recordKind === "avatar");
  if (!rec || rec.recordKind !== "avatar" || rec.avatar === null) return null;
  const entry = rec.avatar.mediaEntry.replace(/^media\//, "");
  return {
    mediaEntry: entry,
    sha256: rec.avatar.sha256,
    mimeType: rec.avatar.mimeType,
  };
}

function spoolPathFor(spoolDir: string, planToken: string): string {
  return join(spoolDir, planToken + "-" + AVATAR_MEDIA_ENTRY);
}

/**
 * D425 Wave 1B — collect the bundle's `privateMemories` records in source
 * order. Only `recordKind: "memory"` records with `scope: "private"` are
 * portable (the codec guarantees this; the double-check is defense in
 * depth). Content is preserved verbatim for the commit to re-embed; no
 * source IDs / embeddings travel on a `MemoryRecord` (the contract is
 * content + type only by construction). Semantic v1.0 records predate the
 * type field and are normalized to the schema default (`general`) on import.
 */
function privateMemoryRecordsFromBundle(bundle: GenieLiveV1): PrivateMemoryRecord[] {
  const out: PrivateMemoryRecord[] = [];
  for (const rec of bundle.records) {
    if (rec.recordKind !== "memory") continue;
    if (rec.scope !== "private") continue;
    out.push({
      recordKind: "memory",
      scope: "private",
      type: "type" in rec ? rec.type : "general",
      content: rec.content,
      createdAt: rec.createdAt,
    });
  }
  return out;
}

interface PrivateMemoryReplayClassification {
  readonly record: PrivateMemoryRecord;
  /** Present in the snapshot or an exact earlier record in this same bundle. */
  readonly alreadyPresent: boolean;
}

/**
 * Classify a source-order replay against an exact-fingerprint snapshot. The
 * working set is updated for every new record, so duplicates within one bundle
 * are counted as already present too. This is an optimization/plan estimate;
 * `replayPrivateMemoriesInTx` repeats the same identity test under its
 * namespace xact lock before any insert.
 */
function classifyPrivateMemoryReplay(
  records: readonly PrivateMemoryRecord[],
  knownFingerprints: ReadonlySet<string>,
): readonly PrivateMemoryReplayClassification[] {
  const known = new Set(knownFingerprints);
  return records.map((record) => {
    const fingerprint = fingerprintPrivateMemoryRecord(record);
    const alreadyPresent = known.has(fingerprint);
    if (!alreadyPresent) known.add(fingerprint);
    return { record, alreadyPresent };
  });
}

/**
 * Protected-only test rows may use a reserved type sentinel, while encrypted
 * shadows of existing Memories deliberately retain their legacy plaintext for
 * rollback. Neither representation may cross the legacy portability boundary
 * or reach the embedding provider. Reject the reserved type regardless of
 * content so a substituted placeholder cannot become portable. Semantic v1.0
 * records have no `type` and remain compatible.
 */
function isProtectedMemoryLegacyPlaceholder(
  record: { readonly type?: string },
): boolean {
  return record.type === PROTECTED_MEMORY_PLACEHOLDER_TYPE;
}

/**
 * D425 Wave 3 — collect the bundle's `privateArtifacts` records in source
 * order as plan-bound entries keyed by their opaque `bytesEntry` selection
 * token. Only `recordKind: "artifact"` records are portable. The
 * `bytesEntry` is the opaque plan-local token that also appears 1:1 in the
 * bundle's `ArtifactMediaManifest` (the codec's `validateArtifactMediaManifest`
 * already enforced that binding + size/sha agreement at `isGenieLiveV1`
 * time, so this helper trusts the validated shape). The canonical logical
 * `path` is re-validated at stage + commit time via `isValidPortableArtifactPath`
 * (fail closed); it is NOT used as selection identity.
 */
function privateArtifactPlanEntriesFromBundle(
  bundle: GenieLiveV1,
): PrivateArtifactPlanEntry[] {
  const out: PrivateArtifactPlanEntry[] = [];
  for (const rec of bundle.records) {
    if (rec.recordKind !== "artifact") continue;
    out.push({
      bytesEntry: rec.bytesEntry,
      path: rec.path,
      mimeType: rec.mimeType,
      size: rec.size,
      sha256: rec.sha256,
    });
  }
  return out;
}

/** Reconstruct the complete `ProfileVoices` map from slot-preserving records. */
function voicesToProfileVoices(
  entries: readonly semantic.VoiceMapEntry[],
): ProfileVoices {
  if (entries.length === 0) return {};
  const out: ProfileVoices = {};
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry.voiceId !== "string" || typeof entry.label !== "string") {
      continue;
    }
    // Legacy Wave 1 bundles had no slot. Keep their established one-entry
    // behavior rather than guessing language slots from array order.
    const slot = entry.slot ?? (index === 0 ? "default" : null);
    if (slot === null || slot in out) continue;
    out[slot] = { voiceId: entry.voiceId, voiceName: entry.label };
  }
  return out;
}

/**
 * Decode a `GenieLiveV1` bundle into the Wave 1A apply payload: the source
 * identity name, the handle intent (customized → fail-closed on collision;
 * null/auto → regenerate target-locally), the frozen portable profile fields
 * (everything EXCEPT name, which the identity primitive owns, and avatarRef,
 * which the owned-photo lifecycle imports and selects), plus the refused and
 * unknown key lists. Runs the source map through `applyWave1AProfileAllowlist`
 * so the frozen filter is the single partition between what lands on the
 * target and what fails closed — preference keys outside the Wave 1A set
 * surface as `unknown` and block the commit.
 */
function decodeWave1AProfileFromBundle(bundle: GenieLiveV1): {
  sourceName: string;
  handleIntent: HandleIntent;
  profileFields: Wave1AProfilePayload;
  refused: string[];
  unknown: string[];
} {
  const identity = recordByKind(bundle.records, "identity");
  const soul = recordByKind(bundle.records, "soul");
  const personality = recordByKind(bundle.records, "personality");
  const voices = recordByKind(bundle.records, "voices");
  const modelPolicy = recordByKind(bundle.records, "modelPolicy");
  const preferences = recordByKind(bundle.records, "preferences");

  const sourceName =
    identity && identity.recordKind === "identity" ? identity.name : "";
  const handleIntent: HandleIntent =
    identity &&
    identity.recordKind === "identity" &&
    identity.handleIntent != null
      ? { kind: "customized", handle: identity.handleIntent }
      : { kind: "auto" };

  // Flat map mirroring the Wave 1A allowlist; preference keys are copied
  // verbatim so the frozen filter partitions known vs unknown for us.
  const flat: Record<string, unknown> = {};
  if (soul && soul.recordKind === "soul") flat["soulFile"] = soul.text ?? null;
  if (personality && personality.recordKind === "personality") {
    flat["personalityPrompt"] = personality.text ?? null;
  }
  if (voices && voices.recordKind === "voices") {
    flat["voices"] = voicesToProfileVoices(voices.voices);
    const defaultVoice = voices.voices.find((voice) => voice.slot === "default") ?? voices.voices[0];
    if (defaultVoice) {
      flat["voiceId"] = defaultVoice.voiceId;
      flat["voiceName"] = defaultVoice.label;
    }
  }
  if (modelPolicy && modelPolicy.recordKind === "modelPolicy") {
    flat["defaultModel"] = modelPolicy.policy.primaryModel ?? null;
  }
  if (preferences && preferences.recordKind === "preferences") {
    const prefs = preferences.preferences as Record<string, unknown>;
    for (const [k, v] of Object.entries(prefs)) {
      flat[k] = v;
    }
  }

  const { payload, refused, unknown } = applyWave1AProfileAllowlist(flat);
  // `name` is never in `flat` (identity-owned); avatarRef is refused by the
  // generic primitive and handled through the D487 lifecycle. Strip name
  // defensively in case a future record adds it.
  const { name: _name, ...profileFields } = payload;
  void _name;
  return { sourceName, handleIntent, profileFields, refused, unknown };
}

/**
 * D425 Wave 1A — register the self-service profile-bundle HTTP surface.
 *
 * Every route is session-authenticated and scoped to the caller's OWN
 * personal Agent. `deps` lets tests inject a fake profile/handle/avatar/
 * digest/instance/store so the contract is unit-testable with no DB; in
 * production the defaults read through the existing domain helpers.
 */
export function profileBundleRoutes(
  app: FastifyInstance,
  deps?: ProfileBundleDeps,
): void {
  const resolvePersonalAgentId =
    deps?.resolvePersonalAgentId ?? defaultResolvePersonalAgentId;
  const readProfile = deps?.readProfile ?? defaultReadProfile;
  const readAgentHandle = deps?.readAgentHandle ?? defaultReadAgentHandle;
  const readAvatarBytes = deps?.readAvatarBytes ?? defaultReadAvatarBytes;
  const computeTargetStateDigest =
    deps?.computeTargetStateDigest ?? defaultComputeTargetStateDigest;
  const instanceId = deps?.instanceId ?? defaultInstanceId;
  const now = deps?.now ?? (() => new Date());
  const planStore = deps?.planStore ?? defaultPlanStore;
  const spoolDir = deps?.spoolDir ?? defaultSpoolDir;
  const maxAvatarBytes = deps?.maxAvatarBytes ?? DEFAULT_MAX_AVATAR_BYTES;
  const assertCanWriteArtifacts = deps?.assertCanWriteArtifacts;
  const listPrivateMemoryRecords =
    deps?.listPrivateMemoryRecords ?? defaultListPrivateMemoryRecords;
  const embedTextWithProvenanceFn = deps?.embedTextWithProvenance ?? embedTextWithProvenance;
  const resolveTargetPrivateNamespaceId =
    deps?.resolveTargetPrivateNamespaceId ?? defaultResolveTargetPrivateNamespaceId;
  const listTargetPrivateMemoryFingerprints =
    deps?.listTargetPrivateMemoryFingerprints ?? defaultListTargetPrivateMemoryFingerprints;
  // D425 Wave 3 — private-artifact seams.
  const listPrivateArtifactRecords =
    deps?.listPrivateArtifactRecords ?? defaultListPrivateArtifactRecords;
  const revalidatePrivateArtifact =
    deps?.revalidatePrivateArtifact ?? defaultRevalidatePrivateArtifact;
  const readArtifactBytes = deps?.readArtifactBytes ?? defaultReadArtifactBytes;
  const findArtifactByPathInTx =
    deps?.findArtifactByPathInTx ?? defaultFindArtifactByPathInTx;
  const commitSourceImport =
    deps?.commitSourceImport ??
    ((args: CommitSourceImportArgs) =>
      defaultCommitSourceImport(args, { findArtifactByPathInTx }));
  const writeArtifactBlob = deps?.writeArtifactBlob ?? defaultWriteArtifactBlob;
  const deleteArtifactBlob = deps?.deleteArtifactBlob ?? defaultDeleteArtifactBlob;
  // D425 Wave 3 — durable crash journal seams.
  const resolveArtifactStorageUri =
    deps?.resolveArtifactStorageUri ?? defaultResolveArtifactStorageUri;
  const artifactJournal =
    deps?.artifactJournal ?? createArtifactJournalStore();
  const artifactRowsExistByStorageUri =
    deps?.artifactRowsExistByStorageUri ??
    defaultArtifactRowsExistByStorageUri;
  const artifactSelectionStore =
    deps?.artifactSelectionStore ?? defaultArtifactSelectionStore;
  const artifactStageStore =
    deps?.artifactStageStore ?? defaultArtifactStageStore;
  const maxArtifactBytes = deps?.maxArtifactBytes ?? ARTIFACT_MAX_BYTES;

  // D425 Wave 3 — optional reconciliation pass at route registration. OFF by
  // default so the existing app.ts call site and the in-memory test harness
  // are unchanged; production may opt in via `reconcileOnRouteInit`. The
  // explicit exported `reconcileArtifactJournal` seam is the deterministic
  // entry point used by tests. Fire-and-forget: route registration must not
  // block on a (possibly slow) DB read.
  if (deps?.reconcileOnRouteInit === true) {
    reconcileArtifactJournal({
      journal: artifactJournal,
      artifactRowsExistByStorageUri,
      deleteArtifactBlob,
      artifactsRoot: getArtifactsRoot,
      absPathFromStorageUri,
      log: (msg) => logError(msg),
    }).catch((e) => {
      logError(
        "[profile-bundle] route-init artifact journal reconciliation failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
    });
  }

  const requireSession = (request: FastifyRequest): string | null => {
    const uid =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? null;
    return uid && uid.length > 0 ? uid : null;
  };

  // GET /api/profile/bundle/export — ID-free semantic payload.
  app.get("/api/profile/bundle/export", async (request, reply) => {
    const userId = requireSession(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    try {
      const agentId = await resolvePersonalAgentId(userId);
      if (!agentId) {
        return reply
          .code(404)
          .send({ error: "no_personal_agent", code: "no_personal_agent" });
      }
      const profile = await readProfile(agentId);
      if (!profile) {
        return reply.code(404).send({ error: "no_profile", code: "no_profile" });
      }
      const handle = await readAgentHandle(agentId);
      const avatarBytes =
        profile.avatar != null ? await readAvatarBytes(profile.avatar) : null;
      if (profile.avatar != null && avatarBytes === null) {
        return reply.code(409).send({
          error: "avatar_portability_unavailable",
          code: "avatar_portability_unavailable",
        });
      }
      const avatarSha256 = avatarBytes ? sha256HexBuf(avatarBytes.bytes) : null;
      const records = buildSemanticRecords(profile, handle, avatarSha256);
      // D425 Wave 1B — append the owner's ELIGIBLE private memory records
      // (the seam runs every candidate through the committed eligibility
      // primitive; shared / foreign / no-edge memories never surface). The
      // `privateMemories` scope is advertised only when at least one
      // eligible record exists, so a bundle with no private memories is
      // byte-identical to a Wave 1A bundle.
      const privateMemoryRecords = await listPrivateMemoryRecords(agentId, userId);
      if (privateMemoryRecords.some(isProtectedMemoryLegacyPlaceholder)) {
        return reply.code(409).send({
          error: "protected_memory_portability_unavailable",
          code: "protected_memory_portability_unavailable",
        });
      }
      for (const rec of privateMemoryRecords) {
        records.push(rec);
      }
      const bundleId = randomUUID();
      const scopes: PortableScope[] = ["profile", "avatar"];
      if (privateMemoryRecords.length > 0) {
        scopes.push(PRIVATE_MEMORIES_SCOPE);
      }
      const avatarMedia = avatarBytes
        ? {
            mediaEntry: AVATAR_MEDIA_ENTRY,
            sha256: avatarSha256 as string,
            mimeType: avatarBytes.mimeType,
            size: avatarBytes.bytes.length,
          }
        : null;
      const body: ProfileBundleExportResponse = {
        semanticVersion: SEMANTIC_VERSION,
        bundleId,
        scopes,
        records,
        avatarMedia,
      };
      return reply.send(body);
    } catch (e) {
      logError(
        "[profile-bundle] GET /export failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "export_failed" });
    }
  });

  // GET /api/profile/bundle/export/media/:mediaEntry — raw avatar byte stream.
  app.get<{ Params: { mediaEntry: string } }>(
    "/api/profile/bundle/export/media/:mediaEntry",
    async (request, reply) => {
      const userId = requireSession(request);
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { mediaEntry } = request.params;
      if (!ALLOWED_MEDIA_ENTRIES.has(mediaEntry)) {
        return reply
          .code(400)
          .send({ error: "invalid_media_entry", code: "invalid_media_entry" });
      }
      try {
        const agentId = await resolvePersonalAgentId(userId);
        if (!agentId) {
          return reply
            .code(404)
            .send({ error: "no_personal_agent", code: "no_personal_agent" });
        }
        const profile = await readProfile(agentId);
        if (!profile?.avatar) {
          return reply
            .code(404)
            .send({ error: "no_avatar", code: "no_avatar" });
        }
        const data = await readAvatarBytes(profile.avatar);
        if (!data) {
          return reply
            .code(404)
            .send({ error: "avatar_not_found", code: "avatar_not_found" });
        }
        return reply.type(data.mimeType).send(data.bytes);
      } catch (e) {
        logError(
          "[profile-bundle] GET /export/media failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "media_read_failed" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // D425 Wave 3 — SOURCE artifact selection preview + stream.
  //
  // The preview returns a paginated, COMPLETE snapshot of the caller's
  // eligible private artifacts as opaque plan-local selection tokens + logical
  // path/type/size ONLY (no source DB id, no storage URI, no sha in the
  // response). The full snapshot — including every large item — is bound
  // server-side to a `selectionPlanToken`; pagination only slices the
  // response, it never omits items. The stream endpoint opens an artifact by
  // selection token (NOT by path), revalidates private eligibility + observed
  // metadata (path/mime/size/sha) against the bound snapshot, and streams
  // raw bytes. Selection identity is the opaque token; a path is never used
  // as identity.
  // -------------------------------------------------------------------------

  // GET /api/profile/bundle/artifacts/preview — paginated eligible-artifact
  // snapshot, bound to a server-side selection plan.
  app.get<{ Querystring: { limit?: string; offset?: string; selectionPlanToken?: string } }>(
    "/api/profile/bundle/artifacts/preview",
    async (request, reply) => {
      const userId = requireSession(request);
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      try {
        const agentId = await resolvePersonalAgentId(userId);
        if (!agentId) {
          return reply
            .code(404)
            .send({ error: "no_personal_agent", code: "no_personal_agent" });
        }
        const requestedPlanToken = request.query.selectionPlanToken?.trim();
        let snapshot: ArtifactSelectionSnapshot;
        if (requestedPlanToken) {
          const existing = artifactSelectionStore.get(requestedPlanToken);
          if (!existing) {
            return reply
              .code(404)
              .send({ error: "selection_plan_not_found", code: "selection_plan_not_found" });
          }
          if (now().getTime() > existing.expiresAt) {
            artifactSelectionStore.delete(requestedPlanToken);
            return reply.code(410).send({ error: "selection_plan_expired", code: "selection_plan_expired" });
          }
          if (existing.sessionUserId !== userId || existing.agentId !== agentId) {
            return reply.code(403).send({ error: "selection_plan_forbidden", code: "selection_plan_forbidden" });
          }
          snapshot = existing;
        } else {
          // The seam runs every candidate through the committed eligibility
          // primitive; shared / foreign / no-edge artifacts never surface.
          const records = await listPrivateArtifactRecords(agentId, userId);

          // Mint opaque plan-local selection tokens (one per eligible artifact)
          // and bind token → observed metadata (path/mime/size/sha) + the
          // source-internal id (server-side only) in a selection snapshot.
          const items = new Map<string, ArtifactSelectionEntry>();
          let totalBytes = 0;
          for (const r of records) {
            // Token is opaque + plan-local; it does NOT travel as the source
            // path. randomUUID matches the artifact opaque-id charset.
            const selectionToken = randomUUID();
            items.set(selectionToken, {
              artifactInternalId: r.artifactInternalId,
              path: r.path,
              mimeType: r.mimeType,
              size: r.size,
              sha256: r.sha256,
            });
            totalBytes += r.size;
          }
          snapshot = {
            selectionPlanToken: randomUUID(),
            sessionUserId: userId,
            agentId,
            expiresAt: now().getTime() + DEFAULT_PLAN_TTL_MS,
            items,
            totalCount: items.size,
            totalBytes,
          };
          artifactSelectionStore.put(snapshot);
        }

        // Paginate the RESPONSE only; the bound snapshot already holds every
        // item regardless of size. We do NOT silently omit large items.
        const rawLimit = Number.parseInt(request.query.limit ?? "", 10);
        const rawOffset = Number.parseInt(request.query.offset ?? "", 10);
        const limit =
          Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, ARTIFACT_PREVIEW_MAX_PAGE)
            : ARTIFACT_PREVIEW_DEFAULT_PAGE;
        const offset =
          Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
        const allEntries = Array.from(snapshot.items.entries());
        const page = allEntries.slice(offset, offset + limit).map(
          ([selectionToken, entry]) => ({
            selectionToken,
            path: entry.path,
            mimeType: entry.mimeType,
            size: entry.size,
          }),
        );
        const hasMore = offset + page.length < allEntries.length;

        return reply.send({
          selectionPlanToken: snapshot.selectionPlanToken,
          items: page,
          totalCount: snapshot.totalCount,
          totalBytes: snapshot.totalBytes,
          limit,
          offset,
          hasMore,
        });
      } catch (e) {
        logError(
          "[profile-bundle] GET /artifacts/preview failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "artifact_preview_failed" });
      }
    },
  );

  // GET /api/profile/bundle/artifacts/source/:selectionToken — stream a
  // selected artifact's raw bytes, revalidating eligibility + metadata.
  app.get<{ Params: { selectionToken: string }; Querystring: { selectionPlanToken?: string } }>(
    "/api/profile/bundle/artifacts/source/:selectionToken",
    async (request, reply) => {
      const userId = requireSession(request);
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { selectionToken } = request.params;
      const selectionPlanToken = request.query.selectionPlanToken ?? "";
      if (selectionPlanToken.length === 0) {
        return reply
          .code(400)
          .send({ error: "selection_plan_required", code: "selection_plan_required" });
      }
      try {
        const snapshot = artifactSelectionStore.get(selectionPlanToken);
        if (!snapshot) {
          return reply
            .code(404)
            .send({ error: "selection_plan_not_found", code: "selection_plan_not_found" });
        }
        if (now().getTime() > snapshot.expiresAt) {
          artifactSelectionStore.delete(selectionPlanToken);
          return reply.code(410).send({ error: "selection_plan_expired", code: "selection_plan_expired" });
        }
        if (snapshot.sessionUserId !== userId) {
          return reply
            .code(403)
            .send({ error: "selection_plan_owner_mismatch", code: "selection_plan_owner_mismatch" });
        }
        // Reject unknown / missing / unselected tokens: the selection token
        // must be present in the bound snapshot. A path is NEVER used as
        // identity here.
        const entry = snapshot.items.get(selectionToken);
        if (!entry) {
          return reply
            .code(404)
            .send({ error: "selection_token_unknown", code: "selection_token_unknown" });
        }

        // Revalidate private eligibility AND observed metadata at open time.
        // The source may have changed (artifact shared / deleted / bytes
        // drifted) between preview and stream; fail closed on any mismatch.
        const revalidation = await revalidatePrivateArtifact(
          snapshot.agentId,
          userId,
          entry.artifactInternalId,
        );
        if (!revalidation.eligible) {
          return reply
            .code(409)
            .send({ error: "artifact_no_longer_eligible", code: "artifact_no_longer_eligible" });
        }
        if (
          revalidation.path !== entry.path ||
          revalidation.mimeType !== entry.mimeType ||
          revalidation.size !== entry.size ||
          revalidation.sha256 !== entry.sha256
        ) {
          logError(
            `[profile-bundle] artifact metadata drift for ${selectionToken}: ` +
              `path=${entry.path}→${revalidation.path} mime=${entry.mimeType}→${revalidation.mimeType} ` +
              `size=${entry.size}→${revalidation.size} sha=${entry.sha256}→${revalidation.sha256}`,
          );
          return reply
            .code(409)
            .send({ error: "artifact_metadata_drift", code: "artifact_metadata_drift" });
        }

        const data = await readArtifactBytes(entry);
        if (!data) {
          return reply
            .code(404)
            .send({ error: "artifact_bytes_unavailable", code: "artifact_bytes_unavailable" });
        }
        return reply.type(data.mimeType).send(data.bytes);
      } catch (e) {
        logError(
          "[profile-bundle] GET /artifacts/source failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "artifact_read_failed" });
      }
    },
  );

  // POST /api/profile/bundle/import/plan — read-only dry-run plan.
  app.post("/api/profile/bundle/import/plan", async (request, reply) => {
    const userId = requireSession(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const body = (request.body ?? null) as {
      bundle?: unknown;
      destinationInstanceId?: unknown;
      scopes?: unknown;
      wholeProfileChoice?: unknown;
    };

    if (!body || !semantic.isGenieLiveV1(body.bundle)) {
      return reply.code(400).send({ error: "invalid_bundle", code: "invalid_bundle" });
    }
    const bundle: GenieLiveV1 = body.bundle;
    if (
      bundle.records.some(
        (record) =>
          record.recordKind === "memory"
          && isProtectedMemoryLegacyPlaceholder(record),
      )
    ) {
      return reply.code(400).send({
        error: "protected_memory_portability_unavailable",
        code: "protected_memory_portability_unavailable",
      });
    }
    if (
      !Number.isInteger(bundle.semanticVersion.major) ||
      bundle.semanticVersion.major !== SEMANTIC_VERSION.major
    ) {
      return reply
        .code(400)
        .send({ error: "unsupported_semantic_version", code: "unsupported_semantic_version" });
    }

    const destinationInstanceId =
      typeof body.destinationInstanceId === "string"
        ? body.destinationInstanceId.trim()
        : "";
    if (destinationInstanceId.length === 0) {
      return reply
        .code(400)
        .send({ error: "destination_required", code: "destination_required" });
    }
    if (destinationInstanceId !== instanceId()) {
      return reply
        .code(409)
        .send({ error: "destination_mismatch", code: "destination_mismatch" });
    }

    const requestedScopes = Array.isArray(body.scopes) ? body.scopes : null;
    if (!requestedScopes || requestedScopes.length === 0) {
      return reply
        .code(400)
        .send({ error: "scopes_required", code: "scopes_required" });
    }
    const scopes: PortableScope[] = [];
    for (const s of requestedScopes) {
      if (!isPortableScopeValue(s)) {
        return reply
          .code(400)
          .send({ error: "unsupported_scope", code: "unsupported_scope", scope: String(s) });
      }
      if (!WAVE_3_SUPPORTED_SCOPE_SET.has(s)) {
        return reply
          .code(400)
          .send({ error: "unsupported_scope", code: "unsupported_scope", scope: s });
      }
      if (!bundle.scopes.includes(s)) {
        return reply
          .code(400)
          .send({ error: "scope_not_in_bundle", code: "scope_not_in_bundle", scope: s });
      }
      if (!scopes.includes(s)) scopes.push(s);
    }

    const choice = body?.wholeProfileChoice;
    if (!isWholeProfileChoice(choice)) {
      return reply
        .code(400)
        .send({ error: "invalid_whole_profile_choice", code: "invalid_whole_profile_choice" });
    }

    try {
      const targetAgentId = await resolvePersonalAgentId(userId);
      if (!targetAgentId) {
        return reply
          .code(404)
          .send({ error: "no_personal_agent", code: "no_personal_agent" });
      }
      const recordHashes = bundle.records.map((r) => computeRecordHash(r));
      const semanticRoot = computeSemanticRoot(recordHashes);
      const targetStateDigest = await computeTargetStateDigest(targetAgentId);
      const avatarMedia = avatarMediaFromBundle(bundle);
      const targetProfile = await readProfile(targetAgentId);
      const targetHandle = await readAgentHandle(targetAgentId);
      const conflicts = detectConflicts(
        bundle,
        targetProfile,
        targetHandle,
        choice,
      );
      const decoded = decodeWave1AProfileFromBundle(bundle);

      // D425 Wave 1B — collect the bundle's `privateMemories` records ONLY when
      // the caller requested the scope. The plan response carries a COUNT
      // (never content); the records are stored server-side for the commit to
      // re-embed + insert. When the scope was not requested (or the bundle
      // omits it) the plan is byte-identical to Wave 1A: zero memories.
      const includePrivateMemories = scopes.includes(PRIVATE_MEMORIES_SCOPE);
      const privateMemories: PrivateMemoryRecord[] = includePrivateMemories
        ? privateMemoryRecordsFromBundle(bundle)
        : [];
      // Exact-record replay estimate for the confirmation UI. It is useful
      // for a person restoring a backup, but intentionally not treated as an
      // authority: the commit mutation repeats lookup + insert under its
      // namespace-scoped advisory transaction lock.
      const privateMemoryPlanClassification =
        choice === "source" && privateMemories.length > 0
          ? classifyPrivateMemoryReplay(
              privateMemories,
              await listTargetPrivateMemoryFingerprints(userId, targetAgentId),
            )
          : [];
      const privateMemoryAlreadyPresentCount = privateMemoryPlanClassification
        .filter((entry) => entry.alreadyPresent)
        .length;
      const privateMemoryAddedCount = privateMemoryPlanClassification.length
        - privateMemoryAlreadyPresentCount;

      // D425 Wave 3 — collect the bundle's `privateArtifacts` records ONLY
      // when the caller requested the scope. The plan response carries a
      // COUNT + total bytes (never content / storage URIs / source ids); the
      // entries are stored server-side for stage (checksum/size gate) +
      // commit (canonical path validation + target insert). When the scope
      // was not requested (or the bundle omits it) the plan is byte-identical
      // to Wave 1B: zero artifacts.
      const includePrivateArtifacts = scopes.includes(PRIVATE_ARTIFACTS_SCOPE);
      const privateArtifacts: PrivateArtifactPlanEntry[] = includePrivateArtifacts
        ? privateArtifactPlanEntriesFromBundle(bundle)
        : [];
      // Reject duplicate `bytesEntry` selection tokens up front (fail closed
      // — the codec already enforces this, but a corrupt store must not
      // smuggle a duplicate through to staging).
      {
        const seen = new Set<string>();
        for (const a of privateArtifacts) {
          if (seen.has(a.bytesEntry)) {
            return reply
              .code(400)
              .send({ error: "duplicate_artifact_token", code: "duplicate_artifact_token", bytesEntry: a.bytesEntry });
          }
          seen.add(a.bytesEntry);
        }
      }

      const planToken = randomUUID();
      const expiresAt = now().getTime() + DEFAULT_PLAN_TTL_MS;
      const stored: StoredPlan = {
        planToken,
        semanticRoot,
        recordHashes,
        targetStateDigest,
        sessionUserId: userId,
        destinationInstanceId,
        targetAgentId,
        scopes,
        wholeProfileChoice: choice,
        avatarMedia,
        sourceName: decoded.sourceName,
        handleIntent: decoded.handleIntent,
        sourceProfile: decoded.profileFields,
        refused: decoded.refused,
        unknown: decoded.unknown,
        privateMemories,
        privateArtifacts,
        stagedArtifacts: new Map(),
        expiresAt,
        consumed: false,
        committedIdempotencyKey: null,
        committedAt: null,
        committedResult: null,
      };
      planStore.put(stored);

      const privateArtifactBytes = privateArtifacts.reduce((sum, a) => sum + a.size, 0);
      const plan: ProfileBundlePlan = {
        planToken,
        semanticRoot,
        targetStateDigest,
        targetAgentId,
        destinationInstanceId,
        scopes,
        wholeProfileChoice: choice,
        conflicts,
        avatarMedia,
        privateMemoryCount: privateMemories.length,
        privateMemoryAddedCount,
        privateMemoryAlreadyPresentCount,
        privateArtifactCount: privateArtifacts.length,
        privateArtifactBytes,
        refused: decoded.refused,
        unknown: decoded.unknown,
        expiresAt: new Date(expiresAt).toISOString(),
      };
      const res: ProfileBundlePlanResponse = { planToken, plan };
      return reply.send(res);
    } catch (e) {
      logError(
        "[profile-bundle] POST /import/plan failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "plan_failed" });
    }
  });

  // POST /api/profile/bundle/import/stage — raw avatar byte upload (multipart).
  app.post<{ Params: { mediaEntry: string } }>(
    "/api/profile/bundle/import/stage/:mediaEntry",
    { bodyLimit: maxAvatarBytes + 1024 },
    async (request, reply) => {
      const userId = requireSession(request);
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { mediaEntry } = request.params;
      if (!ALLOWED_MEDIA_ENTRIES.has(mediaEntry)) {
        return reply
          .code(400)
          .send({ error: "invalid_media_entry", code: "invalid_media_entry" });
      }
      const planToken =
        typeof request.query === "object" &&
        request.query !== null &&
        typeof (request.query as { planToken?: unknown }).planToken === "string"
          ? (request.query as { planToken: string }).planToken
          : "";
      if (planToken.length === 0) {
        return reply
          .code(400)
          .send({ error: "plan_token_required", code: "plan_token_required" });
      }
      const plan = planStore.get(planToken);
      if (!plan) {
        return reply
          .code(404)
          .send({ error: "plan_not_found", code: "plan_not_found" });
      }
      if (now().getTime() > plan.expiresAt) {
        planStore.delete(planToken);
        return reply.code(410).send({ error: "plan_expired", code: "plan_expired" });
      }
      if (plan.sessionUserId !== userId) {
        return reply.code(403).send({ error: "plan_owner_mismatch", code: "plan_owner_mismatch" });
      }
      if (!plan.avatarMedia) {
        return reply
          .code(400)
          .send({ error: "no_avatar_in_plan", code: "no_avatar_in_plan" });
      }
      if (plan.avatarMedia.mediaEntry !== mediaEntry) {
        return reply
          .code(400)
          .send({ error: "media_entry_mismatch", code: "media_entry_mismatch" });
      }

      let data: Awaited<ReturnType<typeof request.file>> | null;
      try {
        // Match the parser ceiling to our documented cap. The in-handler
        // counter remains the deterministic enforcement and checksum gate.
        data = await request.file({
          // @fastify/multipart otherwise applies its 1 MiB default and
          // silently truncates a larger custom avatar before the checksum
          // gate sees it. Raise the parser ceiling to the D425 limit; the
          // streaming counter below remains the authoritative enforcement.
          limits: { files: 1, fileSize: maxAvatarBytes },
        });
      } catch (e) {
        const o = e as { statusCode?: number; code?: string };
        if (o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "avatar_too_large", code: "avatar_too_large" });
        }
        logError(
          "[profile-bundle] POST /import/stage read failed:",
          e instanceof Error ? e.message : String(e),
        );
        return reply.code(400).send({ error: "invalid_upload", code: "invalid_upload" });
      }
      if (!data || data.fieldname !== "file") {
        return reply.code(400).send({ error: "no_file", code: "no_file" });
      }

      try {
        await mkdir(spoolDir(), { recursive: true });
        const dest = spoolPathFor(spoolDir(), planToken);
        const hash = createHash("sha256");
        let total = 0;
        let tooLarge = false;
        const out = createWriteStream(dest);
        for await (const chunk of data.file) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > maxAvatarBytes) {
            tooLarge = true;
            break;
          }
          hash.update(buf);
          out.write(buf);
        }
        await new Promise<void>((resolve, reject) => {
          out.on("error", reject);
          out.end(() => resolve());
        });
        if (tooLarge || data.file.truncated) {
          await rm(dest, { force: true });
          return reply.code(413).send({ error: "avatar_too_large", code: "avatar_too_large" });
        }
        const digest = hash.digest("hex");
        if (!constantTimeEqualHex(digest, plan.avatarMedia.sha256)) {
          await rm(dest, { force: true });
          logError(
            `[profile-bundle] staged avatar checksum mismatch: expected=${plan.avatarMedia.sha256} actual=${digest} bytes=${total}`,
          );
          return reply
            .code(400)
            .send({ error: "avatar_checksum_mismatch", code: "avatar_checksum_mismatch" });
        }
        const res: ProfileBundleStageResponse = {
          planToken,
          mediaEntry,
          sha256: digest,
          size: total,
          staged: true,
        };
        return reply.send(res);
      } catch (e) {
        logError(
          "[profile-bundle] POST /import/stage failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "stage_failed" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // D425 Wave 3 — TARGET artifact staging. Accepts artifact bytes by their
  // opaque `bytesEntry` selection token (the `<opaque-id>` segment of
  // `media/artifacts/<opaque-id>.bin`), verifies checksum + size against the
  // plan-bound manifest, and writes them to a TARGET-LOCAL FRESH file
  // identity (a fresh external `artifactId` + spool path — never the source
  // identity). Rejects unknown / duplicate / unselected / missing tokens
  // fail-closed. Finalization (DB insert via `insertPrivateArtifactInTx`)
  // happens in the commit tx; this endpoint only stages bytes.
  // -------------------------------------------------------------------------
  app.register((scope, _opts, done) => {
    // D425 Wave 3 (streaming slice) — register a STREAMING
    // `application/octet-stream` parser in an ENCAPSULATED child scope so
    // it overrides any globally-registered octet-stream parser (e.g.
    // wopi.ts's buffered PutFile parser when office is enabled) ONLY for
    // this route. The rest of the app is untouched (same pattern as
    // office-proxy.ts). `removeContentTypeParser` is encapsulation-aware
    // and a no-op when no claim is inherited; the passthrough parser
    // hands the raw request stream to the handler as `request.body`
    // (never buffered), so the CLI's deserializer sink can feed bounded
    // decrypted chunks straight into the request body.
    scope.removeContentTypeParser("application/octet-stream");
    scope.addContentTypeParser(
      "application/octet-stream",
      (_req, payload, parsed) => {
        parsed(null, payload);
      },
    );

    scope.post<{ Params: { opaqueId: string }; Querystring: { planToken?: string } }>(
      "/api/profile/bundle/import/stage-artifact/:opaqueId",
      { bodyLimit: maxArtifactBytes + 1024 },
      async (request, reply) => {
      const userId = requireSession(request);
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { opaqueId } = request.params;
      if (!ARTIFACT_OPAQUE_ID_RE.test(opaqueId)) {
        return reply
          .code(400)
          .send({ error: "invalid_artifact_token", code: "invalid_artifact_token" });
      }
      const bytesEntry = `media/artifacts/${opaqueId}.bin`;
      const planToken = request.query.planToken ?? "";
      if (planToken.length === 0) {
        return reply
          .code(400)
          .send({ error: "plan_token_required", code: "plan_token_required" });
      }
      const plan = planStore.get(planToken);
      if (!plan) {
        return reply
          .code(404)
          .send({ error: "plan_not_found", code: "plan_not_found" });
      }
      if (now().getTime() > plan.expiresAt) {
        planStore.delete(planToken);
        return reply.code(410).send({ error: "plan_expired", code: "plan_expired" });
      }
      if (plan.sessionUserId !== userId) {
        return reply.code(403).send({ error: "plan_owner_mismatch", code: "plan_owner_mismatch" });
      }

      // Reject unknown / unselected tokens: the bytesEntry must be present in
      // the plan-bound artifact set. A path is never used as identity.
      const entry = plan.privateArtifacts.find((a) => a.bytesEntry === bytesEntry);
      if (!entry) {
        return reply
          .code(404)
          .send({ error: "artifact_token_unknown", code: "artifact_token_unknown", bytesEntry });
      }
      if (!(await requireArtifactWrite(
        { humanUserId: userId },
        reply,
        assertCanWriteArtifacts,
      ))) {
        return;
      }
      // Reject duplicate stage: an already-staged bytesEntry is fail-closed
      // (the caller must not stage the same artifact twice).
      if (plan.stagedArtifacts.has(bytesEntry) || artifactStageStore.get(planToken, bytesEntry)) {
        return reply
          .code(409)
          .send({ error: "artifact_already_staged", code: "artifact_already_staged", bytesEntry });
      }
      // Canonical logical path validation from the committed primitive. A
      // bundle smuggling an unsafe path fails closed before any bytes land.
      if (!isValidPortableArtifactPath(entry.path)) {
        return reply
          .code(400)
          .send({ error: "artifact_path_invalid", code: "artifact_path_invalid", path: entry.path });
      }

      // Resolve the byte source. Raw `application/octet-stream` → the
      // streaming parser handed us the raw request stream as `request.body`
      // (an async iterable of Buffer chunks, never aggregated). Legacy
      // `multipart/form-data` → the @fastify/multipart `file` part (kept
      // for backward-compat tests). Both flow chunk-by-chunk to the spool
      // with backpressure; neither aggregates a whole artifact in memory.
      const contentType = (request.headers["content-type"] ?? "").toLowerCase();
      let source: AsyncIterable<Buffer | Uint8Array>;
      let multipartTruncated = false;
      if (contentType.startsWith("application/octet-stream")) {
        const body = request.body as AsyncIterable<Buffer | Uint8Array> | null;
        if (body === null || body === undefined) {
          return reply.code(400).send({ error: "no_file", code: "no_file" });
        }
        source = body;
      } else {
        let data: Awaited<ReturnType<typeof request.file>> | null;
        try {
          data = await request.file({
            limits: { files: 1, fileSize: maxArtifactBytes },
          });
        } catch (e) {
          const o = e as { statusCode?: number; code?: string };
          if (o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE") {
            return reply
              .code(413)
              .send({ error: "artifact_too_large", code: "artifact_too_large" });
          }
          logError(
            "[profile-bundle] POST /import/stage-artifact read failed:",
            e instanceof Error ? e.message : String(e),
          );
          return reply.code(400).send({ error: "invalid_upload", code: "invalid_upload" });
        }
        if (!data || data.fieldname !== "file") {
          return reply.code(400).send({ error: "no_file", code: "no_file" });
        }
        source = data.file as unknown as AsyncIterable<Buffer | Uint8Array>;
        multipartTruncated = data.file.truncated;
      }

      // Target-local FRESH file identity: a freshly minted external
      // `artifactId` (never the source identity) + a private spool path.
      const artifactId = randomUUID();
      const stagedPath = join(spoolDir(), planToken + "-artifact-" + artifactId);
      try {
        await mkdir(spoolDir(), { recursive: true });
        const hash = createHash("sha256");
        let total = 0;
        let tooLarge = false;
        const out = createWriteStream(stagedPath);
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > maxArtifactBytes) {
            tooLarge = true;
            break;
          }
          hash.update(buf);
          // Respect write-stream backpressure so a slow disk bounds the
          // request-body read (never aggregate a whole artifact in memory).
          if (!out.write(buf)) {
            await new Promise<void>((resolve) => out.once("drain", () => resolve()));
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.on("error", reject);
          out.end(() => resolve());
        });
        if (tooLarge || multipartTruncated) {
          await rm(stagedPath, { force: true });
          return reply
            .code(413)
            .send({ error: "artifact_too_large", code: "artifact_too_large" });
        }
        const digest = hash.digest("hex");
        // Checksum + size verification against the plan-bound manifest.
        if (!constantTimeEqualHex(digest, entry.sha256)) {
          await rm(stagedPath, { force: true });
          logError(
            `[profile-bundle] staged artifact checksum mismatch: bytesEntry=${bytesEntry} expected=${entry.sha256} actual=${digest} bytes=${total}`,
          );
          return reply
            .code(400)
            .send({ error: "artifact_checksum_mismatch", code: "artifact_checksum_mismatch", bytesEntry });
        }
        if (total !== entry.size) {
          await rm(stagedPath, { force: true });
          logError(
            `[profile-bundle] staged artifact size mismatch: bytesEntry=${bytesEntry} expected=${entry.size} actual=${total}`,
          );
          return reply
            .code(400)
            .send({ error: "artifact_size_mismatch", code: "artifact_size_mismatch", bytesEntry });
        }
        const staged: StagedArtifact = {
          bytesEntry,
          artifactId,
          stagedPath,
          sha256: digest,
          size: total,
          durableStorageUri: null,
        };
        plan.stagedArtifacts.set(bytesEntry, staged);
        artifactStageStore.put(planToken, staged);
        return reply.send({
          planToken,
          bytesEntry,
          artifactId,
          sha256: digest,
          size: total,
          staged: true,
        });
      } catch (e) {
        logError(
          "[profile-bundle] POST /import/stage-artifact failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        await rm(stagedPath, { force: true }).catch(() => {});
        return reply.code(500).send({ error: "artifact_stage_failed" });
      }
    },
    );

    // D425 Wave 3 (streaming slice) — explicit plan-scoped cleanup of all
    // staged artifact spool files + store entries. The CLI calls this on a
    // terminal manifest / decrypt / chunk error so a half-staged plan does
    // not leave orphan spool bytes behind. Best-effort: each staged file is
    // removed with `force: true`; the store is cleared regardless. If this
    // endpoint is unreachable the caller leaves temp state to the plan TTL
    // / commit-time cleanup (made explicit at the CLI call site).
    scope.delete<{ Querystring: { planToken?: string } }>(
      "/api/profile/bundle/import/stage-artifact",
      async (request, reply) => {
        const userId = requireSession(request);
        if (!userId) {
          return reply.code(401).send({ error: "Authentication required" });
        }
        const planToken = request.query.planToken ?? "";
        if (planToken.length === 0) {
          return reply
            .code(400)
            .send({ error: "plan_token_required", code: "plan_token_required" });
        }
        const plan = planStore.get(planToken);
        if (!plan) {
          return reply
            .code(404)
            .send({ error: "plan_not_found", code: "plan_not_found" });
        }
        if (plan.sessionUserId !== userId) {
          return reply.code(403).send({ error: "plan_owner_mismatch", code: "plan_owner_mismatch" });
        }
        let cleared = 0;
        for (const [, s] of plan.stagedArtifacts) {
          await rm(s.stagedPath, { force: true }).catch(() => {});
          cleared += 1;
        }
        artifactStageStore.deleteAll(planToken);
        plan.stagedArtifacts.clear();
        return reply.send({ planToken, cleared, clearedAll: true });
      },
    );

    done();
  });

  // POST /api/profile/bundle/import/commit — freshness + idempotency gate.
  app.post("/api/profile/bundle/import/commit", async (request, reply) => {
    const userId = requireSession(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const body = (request.body ?? null) as {
      planToken?: unknown;
      idempotencyKey?: unknown;
    };
    const planToken =
      typeof body?.planToken === "string" ? body.planToken : "";
    const idempotencyKey =
      typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (planToken.length === 0 || idempotencyKey.length === 0) {
      return reply
        .code(400)
        .send({ error: "plan_token_and_idempotency_required", code: "plan_token_and_idempotency_required" });
    }
    const plan = planStore.get(planToken);
    if (!plan) {
      return reply
        .code(404)
        .send({ error: "plan_not_found", code: "plan_not_found" });
    }
    if (now().getTime() > plan.expiresAt) {
      planStore.delete(planToken);
      return reply.code(410).send({ error: "plan_expired", code: "plan_expired" });
    }
    if (plan.sessionUserId !== userId) {
      return reply.code(403).send({ error: "plan_owner_mismatch", code: "plan_owner_mismatch" });
    }
    if (plan.destinationInstanceId !== instanceId()) {
      return reply
        .code(409)
        .send({ error: "destination_mismatch", code: "destination_mismatch" });
    }

    // Idempotency replay handling.
    if (plan.committedIdempotencyKey !== null) {
      if (plan.committedIdempotencyKey === idempotencyKey) {
        if (plan.wholeProfileChoice === "target") {
          const res: ProfileBundleCommitTargetResponse = {
            planToken,
            idempotencyKey,
            semanticRoot: plan.semanticRoot,
            targetStateDigest: plan.targetStateDigest,
            fresh: true,
            committed: true,
            choice: "target",
            privateMemoryAddedCount: 0,
            privateMemoryAlreadyPresentCount: 0,
          };
          return reply.send(res);
        }
        // source replay — return the exact result the first commit produced.
        const committed = plan.committedResult;
        const res: ProfileBundleCommitSourceResponse = {
          planToken,
          idempotencyKey,
          semanticRoot: plan.semanticRoot,
          targetStateDigest: plan.targetStateDigest,
          fresh: true,
          committed: true,
          choice: "source",
          privateMemoryAddedCount: committed?.privateMemoryAddedCount ?? 0,
          privateMemoryAlreadyPresentCount: committed?.privateMemoryAlreadyPresentCount ?? 0,
          applied: {
            name: committed?.name ?? plan.sourceName,
            handle: committed?.handle ?? "",
            handleCustomized: committed?.handleCustomized ?? false,
            avatar: committed?.avatar ?? null,
          },
        };
        return reply.send(res);
      }
      return reply
        .code(409)
        .send({ error: "idempotency_replay_conflict", code: "idempotency_replay_conflict" });
    }

    if (
      plan.wholeProfileChoice === "source" &&
      plan.privateArtifacts.length > 0 &&
      !(await requireArtifactWrite(
        { humanUserId: userId },
        reply,
        assertCanWriteArtifacts,
      ))
    ) {
      return;
    }

    try {
      // --- Preflight rechecks (immediately before mutation) ---
      // Semantic root: recompute from the stored per-record hashes and reject
      // a plan whose stored root no longer matches (store corruption guard).
      const recomputedRoot = computeSemanticRoot(plan.recordHashes);
      if (!constantTimeEqualHex(recomputedRoot, plan.semanticRoot)) {
        return reply
          .code(500)
          .send({ error: "plan_corrupted", code: "plan_corrupted" });
      }
      // Selected scopes still Wave 3 supported (defense vs store corruption).
      for (const s of plan.scopes) {
        if (!WAVE_3_SUPPORTED_SCOPE_SET.has(s)) {
          return reply
            .code(500)
            .send({ error: "plan_corrupted", code: "plan_corrupted" });
        }
      }
      // Freshness: recompute the target-state digest and reject a moved target.
      const currentDigest = await computeTargetStateDigest(plan.targetAgentId);
      if (!constantTimeEqualHex(currentDigest, plan.targetStateDigest)) {
        if (plan.avatarMedia) {
          await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
        }
        for (const [, s] of plan.stagedArtifacts) {
          await rm(s.stagedPath, { force: true }).catch(() => {});
        }
        artifactStageStore.deleteAll(planToken);
        plan.stagedArtifacts.clear();
        return reply.code(409).send({ error: "stale_target", code: "stale_target" });
      }

      // `target` choice is a verified no-op. It must not require avatar
      // staging: the CLI intentionally skips that upload when retaining the
      // target profile.
      if (plan.wholeProfileChoice === "target") {
        plan.consumed = true;
        plan.committedIdempotencyKey = idempotencyKey;
        plan.committedAt = now().getTime();
        if (plan.avatarMedia) {
          await rm(spoolPathFor(spoolDir(), planToken), { force: true });
        }
        // D425 Wave 3 — a target no-op discards any staged artifact spool
        // too; no durable bytes were finalized for the target choice.
        for (const [, s] of plan.stagedArtifacts) {
          await rm(s.stagedPath, { force: true }).catch(() => {});
        }
        artifactStageStore.deleteAll(planToken);
        plan.stagedArtifacts.clear();
        const res: ProfileBundleCommitTargetResponse = {
          planToken,
          idempotencyKey,
          semanticRoot: plan.semanticRoot,
          targetStateDigest: plan.targetStateDigest,
          fresh: true,
          committed: true,
          choice: "target",
          privateMemoryAddedCount: 0,
          privateMemoryAlreadyPresentCount: 0,
        };
        return reply.send(res);
      }

      // Source choice with avatar media requires a staged, checksum-matching
      // blob. Keep the verified bytes for finalization (no re-read).
      let stagedBytes: Buffer | null = null;
      if (plan.avatarMedia) {
        const dest = spoolPathFor(spoolDir(), planToken);
        if (!existsSync(dest)) {
          return reply
            .code(409)
            .send({ error: "avatar_not_staged", code: "avatar_not_staged" });
        }
        const staged = readFileSync(dest);
        const digest = sha256HexBuf(staged);
        if (!constantTimeEqualHex(digest, plan.avatarMedia.sha256)) {
          await rm(dest, { force: true });
          return reply
            .code(409)
            .send({ error: "avatar_checksum_mismatch", code: "avatar_checksum_mismatch" });
        }
        stagedBytes = staged;
      }

      // `source` choice: fail closed on refused/unknown portable fields. The
      // plan reported them at dry-run time; the commit refuses to mutate so a
      // bundle smuggling a non-allowlist field can never land silently.
      if (plan.refused.length > 0 || plan.unknown.length > 0) {
        if (plan.avatarMedia) {
          await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
        }
        return reply.code(409).send({
          error: "bundle_refused_or_unknown_fields",
          code: "bundle_refused_or_unknown_fields",
          refused: plan.refused,
          unknown: plan.unknown,
        });
      }

      // D567 — refresh the PROFILE-WIDE exact-memory snapshot immediately
      // before embedding or mutation. Export spans every eligible private
      // chat/scope owned by this personal profile, so comparing only the
      // canonical insertion namespace would duplicate memories already held
      // in another private chat. The source-order classifier also collapses
      // exact repeats inside the bundle. Remaining candidates are embedded
      // outside the transaction and then rechecked by the canonical
      // namespace-locked replay, which remains authoritative for concurrent
      // restore inserts.
      let privateMemoryImports: PrivateMemoryImportRecord[] = [];
      let targetNamespaceId: string | null = null;
      let privateMemoryAlreadyPresentBeforeReplay = 0;
      if (plan.privateMemories.length > 0) {
        const classification = classifyPrivateMemoryReplay(
          plan.privateMemories,
          await listTargetPrivateMemoryFingerprints(
            plan.sessionUserId,
            plan.targetAgentId,
          ),
        );
        privateMemoryAlreadyPresentBeforeReplay = classification
          .filter((entry) => entry.alreadyPresent)
          .length;
        const recordsToImport = classification
          .filter((entry) => !entry.alreadyPresent)
          .map((entry) => entry.record);
        if (recordsToImport.length > 0) {
          targetNamespaceId = await resolveTargetPrivateNamespaceId(
            plan.sessionUserId,
            plan.targetAgentId,
          );
          if (!targetNamespaceId) {
            if (plan.avatarMedia) {
              await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
            }
            return reply
              .code(409)
              .send({ error: "no_target_private_namespace", code: "no_target_private_namespace" });
          }
          const imports: PrivateMemoryImportRecord[] = [];
          try {
            for (const rec of recordsToImport) {
              imports.push({
                type: rec.type,
                content: rec.content,
                embedding: await embedTextWithProvenanceFn(rec.content),
                ...(rec.createdAt
                  ? { createdAt: new Date(rec.createdAt) }
                  : {}),
              });
            }
          } catch (embedErr) {
            if (plan.avatarMedia) {
              await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
            }
            logError(
              "[profile-bundle] private memory re-embedding failed:",
              embedErr instanceof Error ? embedErr.stack ?? embedErr.message : String(embedErr),
            );
            return reply
              .code(500)
              .send({ error: "memory_embedding_failed", code: "memory_embedding_failed" });
          }
          privateMemoryImports = imports;
        }
      }

      // D425 Wave 3 — prepare the private-artifact replay BEFORE the DB tx.
      // Every plan-bound artifact must be staged (reject missing tokens fail
      // closed); staged bytes are re-verified against the plan-bound manifest
      // (checksum + size). Durable target bytes are finalized OUTSIDE the tx
      // via `writeArtifactBlob` (target-local fresh `artifactId` + storage URI)
      // so the committed row can only point at existing bytes; on DB-tx failure
      // the route compensates by deleting the durable bytes. The STAGED spool
      // files are temporary and cleaned on every outcome (see
      // `cleanupArtifactStagedSpool`); the DURABLE bytes are compensated only
      // on DB-tx failure (see `compensateArtifactBlobs`). D425 Wave 3 (this
      // slice) adds a DURABLE crash journal bracketing each durable write
      // (`prepare` → `finalize` → clear-on-commit) so a process crash between
      // finalization and tx commit no longer orphans durable bytes — the
      // reconciler (`reconcileArtifactJournal`) clears/retains/deletes on the
      // next init. This is a minimal crash-window safety net, NOT a general
      // blob GC.
      const cleanupArtifactStagedSpool = async (): Promise<void> => {
        for (const [, s] of plan.stagedArtifacts) {
          await rm(s.stagedPath, { force: true }).catch(() => {});
        }
        artifactStageStore.deleteAll(planToken);
        plan.stagedArtifacts.clear();
      };
      const finalizedArtifactUris: string[] = [];
      const compensateArtifactBlobs = async (): Promise<void> => {
        for (const uri of finalizedArtifactUris) {
          await deleteArtifactBlob(uri).catch(() => {});
        }
        // Clear the journal records for every in-flight artifact: the tx
        // failed (so the committed row does not exist) and the durable bytes
        // above were just deleted. Leaving a `finalized` record here would
        // make the reconciler redo this work (harmless but noisy) — clearing
        // keeps the journal to records the route cannot reach (a real crash).
        for (const imp of privateArtifactImports) {
          await artifactJournal.remove(planToken, imp.artifactId).catch(() => {});
        }
        finalizedArtifactUris.length = 0;
      };

      let privateArtifactImports: PrivateArtifactImportRecord[] = [];
      let targetArtifactNamespaceId: string | null = null;
      if (plan.privateArtifacts.length > 0) {
        targetArtifactNamespaceId = await resolveTargetPrivateNamespaceId(
          plan.sessionUserId,
          plan.targetAgentId,
        );
        if (!targetArtifactNamespaceId) {
          if (plan.avatarMedia) {
            await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
          }
          await cleanupArtifactStagedSpool();
          return reply
            .code(409)
            .send({ error: "no_target_private_namespace", code: "no_target_private_namespace" });
        }
        const imports: PrivateArtifactImportRecord[] = [];
        for (const entry of plan.privateArtifacts) {
          const staged = plan.stagedArtifacts.get(entry.bytesEntry);
          // Reject missing tokens: every plan-bound artifact must be staged.
          if (!staged || !existsSync(staged.stagedPath)) {
            if (plan.avatarMedia) {
              await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
            }
            await cleanupArtifactStagedSpool();
            return reply.code(409).send({
              error: "artifact_not_staged",
              code: "artifact_not_staged",
              bytesEntry: entry.bytesEntry,
            });
          }
          const bytes = readFileSync(staged.stagedPath);
          const digest = sha256HexBuf(bytes);
          if (!constantTimeEqualHex(digest, entry.sha256) || bytes.length !== entry.size) {
            if (plan.avatarMedia) {
              await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
            }
            await cleanupArtifactStagedSpool();
            logError(
              `[profile-bundle] staged artifact drift at commit: bytesEntry=${entry.bytesEntry} expectedSha=${entry.sha256} actualSha=${digest} expectedSize=${entry.size} actualSize=${bytes.length}`,
            );
            return reply.code(409).send({
              error: "artifact_checksum_mismatch",
              code: "artifact_checksum_mismatch",
              bytesEntry: entry.bytesEntry,
            });
          }
          // Canonical logical path validation from the committed primitive
          // (defense in depth — the stage endpoint already validated).
          if (!isValidPortableArtifactPath(entry.path)) {
            if (plan.avatarMedia) {
              await rm(spoolPathFor(spoolDir(), planToken), { force: true }).catch(() => {});
            }
            await cleanupArtifactStagedSpool();
            return reply.code(400).send({
              error: "artifact_path_invalid",
              code: "artifact_path_invalid",
              path: entry.path,
            });
          }
          imports.push({
            bytesEntry: entry.bytesEntry,
            path: entry.path,
            mimeType: entry.mimeType,
            size: entry.size,
            sha256: entry.sha256,
            artifactId: staged.artifactId,
            storageUri: "", // finalized below, before the tx
          });
        }
        privateArtifactImports = imports;
      }

      // --- Destructive apply (source) ---
      // D487: custom bytes are handed to the owned-photo coordinator below;
      // it stages/publishes deterministic media and composes entry creation,
      // the accepted non-photo import, and selection in one DB transaction.
      // No-custom-photo imports preserve the canonical target selection.
      // The current bundle schema cannot distinguish preset/omitted/clear, so
      // missing media never grants deletion authority.
      const customPhoto = plan.avatarMedia && stagedBytes
        ? { bytes: stagedBytes, sha256: plan.avatarMedia.sha256 }
        : null;
      const spoolPath = plan.avatarMedia ? spoolPathFor(spoolDir(), planToken) : null;
      const cleanupSpool = async (): Promise<void> => {
        if (spoolPath) await rm(spoolPath, { force: true }).catch(() => {});
      };
      try {
        // D425 Wave 3 — finalize durable target bytes for each staged
        // artifact BEFORE the DB tx (so the committed row can only point at
        // existing bytes). On DB-tx failure these are compensated by
        // `compensateArtifactBlobs` in the catch below.
        //
        // D425 Wave 3 (this slice) — each durable write is bracketed by a
        // DURABLE journal record so a process crash between finalize and tx
        // commit no longer leaks unreferenced bytes:
        //   1. `prepare`  — BEFORE the write, with the pre-resolved storage URI;
        //   2. `writeArtifactBlob` — the durable write;
        //   3. `finalize` — AFTER the write succeeded;
        //   4. `remove`   — AFTER the tx commits (success path) OR after
        //      compensation deletes the bytes (failure path). A crash leaves
        //      a `finalized` record for the reconciler to clean on next init.
        if (privateArtifactImports.length > 0) {
          for (let i = 0; i < privateArtifactImports.length; i++) {
            const imp = privateArtifactImports[i]!;
            const staged = plan.stagedArtifacts.get(imp.bytesEntry)!;
            const bytes = readFileSync(staged.stagedPath);
            const storageUri = resolveArtifactStorageUri(imp.artifactId, imp.mimeType);
            await artifactJournal.prepare(planToken, imp.artifactId, storageUri, now());
            let writtenUri: string;
            try {
              writtenUri = await writeArtifactBlob(imp.artifactId, bytes, imp.mimeType);
            } catch (writeErr) {
              // Write failed: no durable bytes to compensate. Clear the
              // `prepared` record so the reconciler does not treat it as an
              // orphan, then abort the commit (the catch below cleans the
              // earlier finalized artifacts).
              await artifactJournal.remove(planToken, imp.artifactId).catch(() => {});
              throw writeErr;
            }
            if (writtenUri !== storageUri) {
              // The injected writer returned a different URI than the
              // pre-resolved one the journal already recorded. Re-finalize
              // the journal with the ACTUAL URI so the reconciler looks at
              // the path the writer really used. (Defaults always match.)
              logError(
                `[profile-bundle] resolveArtifactStorageUri mismatch for ` +
                  `artifactId=${imp.artifactId}: journal will use the writer's URI`,
              );
              await artifactJournal.remove(planToken, imp.artifactId).catch(() => {});
              await artifactJournal.prepare(planToken, imp.artifactId, writtenUri, now());
            }
            await artifactJournal.finalize(planToken, imp.artifactId);
            finalizedArtifactUris.push(writtenUri);
            privateArtifactImports[i] = { ...imp, storageUri: writtenUri };
          }
        }

        const ident = await commitSourceImport({
          customPhoto,
          mutation: {
            ownerUserId: plan.sessionUserId,
            agentId: plan.targetAgentId,
            name: plan.sourceName,
            handleIntent: plan.handleIntent,
            profileFields: plan.sourceProfile,
            ...(privateMemoryImports.length > 0
              ? { privateMemories: privateMemoryImports, targetNamespaceId }
              : {}),
            ...(privateArtifactImports.length > 0
              ? {
                  privateArtifacts: privateArtifactImports,
                  targetArtifactNamespaceId,
                }
              : {}),
          },
        });

        // Success: mark the plan committed and record the exact result so an
        // idempotent replay returns the same shape.
        plan.consumed = true;
        plan.committedIdempotencyKey = idempotencyKey;
        plan.committedAt = now().getTime();
        const privateMemoryAddedCount = ident.privateMemoryReplay.added;
        const privateMemoryAlreadyPresentCount =
          privateMemoryAlreadyPresentBeforeReplay + ident.privateMemoryReplay.alreadyPresent;
        plan.committedResult = {
          name: ident.name,
          handle: ident.handle,
          handleCustomized: ident.handleCustomized,
          avatar: ident.avatar,
          privateMemoryAddedCount,
          privateMemoryAlreadyPresentCount,
        };
        // Drop the staged bytes BEFORE the response so no temporary byte
        // survives the commit (the plan stays for replay; replay needs no
        // re-stage because the mutation does not re-run). Artifact durable
        // bytes are NOT deleted — they are now the committed target bytes.
        // D425 Wave 3 — the tx committed, so clear every artifact journal
        // record (the committed row now owns the durable bytes; the
        // reconciler would retain them anyway, but clearing avoids a
        // redundant reconcile pass).
        for (const imp of privateArtifactImports) {
          await artifactJournal.remove(planToken, imp.artifactId).catch(() => {});
        }
        await cleanupSpool();
        await cleanupArtifactStagedSpool();
        const res: ProfileBundleCommitSourceResponse = {
          planToken,
          idempotencyKey,
          semanticRoot: plan.semanticRoot,
          targetStateDigest: plan.targetStateDigest,
          fresh: true,
          committed: true,
          choice: "source",
          privateMemoryAddedCount,
          privateMemoryAlreadyPresentCount,
          applied: {
            name: ident.name,
            handle: ident.handle,
            handleCustomized: ident.handleCustomized,
            avatar: ident.avatar,
          },
        };
        return reply.send(res);
      } catch (mutErr) {
        // The photo coordinator compensates only its proven-uncommitted
        // deterministic media. This route still owns artifact compensation
        // and temporary spool cleanup.
        await compensateArtifactBlobs();
        await cleanupSpool();
        await cleanupArtifactStagedSpool();
        if (mutErr instanceof HandleCollisionError) {
          return reply.code(409).send({
            error: "handle_collision",
            code: "handle_collision",
            handle: mutErr.handle,
          });
        }
        if (mutErr instanceof ArtifactPathCollisionError) {
          return reply.code(409).send({
            error: "artifact_path_collision",
            code: "artifact_path_collision",
            path: mutErr.path,
            namespaceId: mutErr.namespaceId,
          });
        }
        logError(
          "[profile-bundle] source commit mutation failed:",
          mutErr instanceof Error ? mutErr.stack ?? mutErr.message : String(mutErr),
        );
        return reply.code(500).send({ error: "commit_failed", code: "commit_failed" });
      }
    } catch (e) {
      logError(
        "[profile-bundle] POST /import/commit failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "commit_failed" });
    }
  });
}
