/**
 * D425 Wave 3 — narrow, transaction-aware private-artifact migration
 * primitives for the portable Genie profile importer.
 *
 * Wave 1B (`./profile-migration-memory-primitives.ts`) introduced the
 * caller-owned-transaction pattern for the private-memory surface.
 * Wave 3 extends that pattern to the *private artifact* surface with
 * three narrow primitives — no broad artifact-store refactor:
 *
 *   1. **Source eligibility** — `isArtifactEligibleForPrivateExportInTx`
 *      (+ the pure `evaluatePrivateArtifactEligibility` it delegates to).
 *      Walks EVERY `artifact_namespaces` edge of a source artifact,
 *      resolves each namespace to its Room, resolves the exporting
 *      owner's single human actor, and accepts the artifact iff at
 *      least one edge exists AND every edge's Room has exactly that
 *      human actor as its sole human member. Any shared / foreign /
 *      no-room edge — or no edge at all — rejects the whole artifact
 *      (R7: shared artifacts never enter a bundle). `artifact_scopes`
 *      is intentionally NOT inspected: subagent-scope runtime behavior
 *      is unimplemented (M088 Phase 4), so scope edges carry no
 *      portable meaning and are ignored.
 *   2. **Pure portable projection** — `encodePortableArtifact` projects a
 *      source artifact row onto the `PortableArtifact` contract
 *      (`recordKind: "artifact"`, `path`, `mimeType`, `size`, `sha256`,
 *      `bytesEntry`) with NO source IDs, NO storage URI, NO revision.
 *      The primitive-facing helpers validate a safe logical `path` and
 *      the exact `media/artifacts/<opaque-id>.bin` `bytesEntry` grammar
 *      — they do NOT broaden to arbitrary input.
 *   3. **Import-only insert** — `insertPrivateArtifactInTx` inserts a
 *      caller-supplied fresh target artifact row plus its
 *      `artifact_namespaces` junction inside the caller's transaction.
 *      No upsert / dedup / update. DB only; NO filesystem writes.
 *
 * Scope guard: this module is private-artifact-migration-only. It wires
 * NO import endpoint, touches NO storage / CLI / schema / migration,
 * and does NOT recreate `artifact_scopes` junctions on import.
 */

import { and, eq } from "drizzle-orm";
import { artifacts } from "../schema/artifacts";
import { artifactNamespaces } from "../schema/artifact-namespaces";
import { actors } from "../schema/trust";
import { rooms } from "../schema/rooms";
import type { ProfileMigrationTx } from "./profile-migration-primitives";

/** Re-exported transaction handle type (sibling to the Wave 1A/1B modules). */
export type { ProfileMigrationTx };

// ---------------------------------------------------------------------------
// Pure portable projection — PortableArtifact contract
// ---------------------------------------------------------------------------

/**
 * The semantic record shape, compatible with the existing `PortableArtifact`
 * contract (`packages/profile-portability/src/semantic/types.ts`):
 * `recordKind: "artifact"`, `path`, `mimeType`, `size`, `sha256`, `bytesEntry`.
 * Inlined here (not imported from profile-portability) so `@nautilo/db` stays
 * free of the portability-package dependency; structurally identical.
 *
 * `path` is the artifact's bundle-internal logical path (user-visible, not a
 * source-filesystem path). `bytesEntry` is the bundle-internal manifest entry
 * name that locates the encrypted artifact bytes. `sha256` covers the bytes.
 * NO source DB id, NO internal uuid, NO storage URI, NO revision survive.
 */
export interface PortableArtifact {
  readonly recordKind: "artifact";
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytesEntry: string;
}

/**
 * Source artifact projection input — only the contract-relevant fields. The
 * DB-fetcher reads an `artifacts` row and trims to this shape before
 * encoding; `id` / `artifactId` / `storageUri` / `revision` / timestamps are
 * deliberately dropped (R3/R7: never portable).
 */
export interface PortableArtifactInput {
  /** Bundle-internal logical path (e.g. `notes/idea.md`). */
  path: string;
  /** MIME type, non-empty (defaults to `application/octet-stream`). */
  mimeType: string;
  /** Byte length of the artifact bytes; non-negative finite number. */
  size: number;
  /** SHA-256 hex digest of the artifact bytes (64 lowercase hex chars). */
  sha256: string;
  /** Manifest entry name, exactly `media/artifacts/<opaque-id>.bin`. */
  bytesEntry: string;
}

export type PortableArtifactFieldError =
  | "path_invalid"
  | "mimeType_invalid"
  | "size_invalid"
  | "sha256_invalid"
  | "bytesEntry_invalid";

export interface ValidatePortableArtifactResult {
  readonly ok: boolean;
  readonly errors: readonly PortableArtifactFieldError[];
}

/** Exact bytes-entry grammar: `media/artifacts/<opaque-id>.bin`. */
const ARTIFACT_BYTES_ENTRY_RE = /^media\/artifacts\/[A-Za-z0-9_-]{1,128}\.bin$/;
/** SHA-256 = 64 lowercase hex chars. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** Max logical path length. */
const MAX_ARTIFACT_PATH_LEN = 1024;

/** True if `s` contains any C0 control character (U+0000–U+001F). */
function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f) return true;
  }
  return false;
}

/**
 * Safe logical path for a portable artifact. Rejects anything that could
 * escape the bundle's logical namespace: empty, leading slash / backslash,
 * any backslash, NUL or control chars, `.` / `..` segments, empty segments
 * (double slash / trailing slash), or a colon (Windows drive / ADS).
 * Pure / synchronous / no DB.
 */
export function isValidPortableArtifactPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_ARTIFACT_PATH_LEN) return false;
  if (path !== path.trim()) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\\")) return false;
  if (containsControlChar(path)) return false; // includes NUL + control
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return false; // no `//`, no trailing `/`
    if (seg === "." || seg === "..") return false;
    if (seg.includes(":")) return false;
  }
  return true;
}

/** Exact `media/artifacts/<opaque-id>.bin` bytes-entry grammar. */
export function isValidArtifactBytesEntry(entry: unknown): entry is string {
  return typeof entry === "string" && ARTIFACT_BYTES_ENTRY_RE.test(entry);
}

/** 64-char lowercase hex SHA-256. */
export function isValidArtifactSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * Validate every field of a `PortableArtifactInput` against the contract.
 * Collects ALL field errors (not just the first) so the importer can report
 * a complete dry-run rejection. Pure / synchronous / no DB.
 */
export function validatePortableArtifactInput(
  input: PortableArtifactInput,
): ValidatePortableArtifactResult {
  const errors: PortableArtifactFieldError[] = [];
  if (!isValidPortableArtifactPath(input.path)) errors.push("path_invalid");
  if (typeof input.mimeType !== "string" || input.mimeType.length === 0) {
    errors.push("mimeType_invalid");
  }
  if (
    typeof input.size !== "number" ||
    !Number.isFinite(input.size) ||
    input.size < 0
  ) {
    errors.push("size_invalid");
  }
  if (!isValidArtifactSha256(input.sha256)) errors.push("sha256_invalid");
  if (!isValidArtifactBytesEntry(input.bytesEntry)) {
    errors.push("bytesEntry_invalid");
  }
  return { ok: errors.length === 0, errors };
}

export type EncodePortableArtifactResult =
  | { readonly ok: true; readonly artifact: PortableArtifact }
  | { readonly ok: false; readonly errors: readonly PortableArtifactFieldError[] };

/**
 * Project a source artifact row onto the portable `PortableArtifact`
 * contract. Pure / synchronous / no DB. Preserves ONLY the contract fields
 * — no source id, no internal uuid, no storage URI, no revision, no
 * timestamps. Validates the safe logical `path` and the exact
 * `media/artifacts/<opaque-id>.bin` `bytesEntry` grammar (plus `sha256` /
 * `size` / `mimeType`) and refuses to broaden to arbitrary input: an
 * invalid field yields `{ ok: false, errors }` rather than a silently
 * smuggled-through record.
 */
export function encodePortableArtifact(
  input: PortableArtifactInput,
): EncodePortableArtifactResult {
  const result = validatePortableArtifactInput(input);
  if (!result.ok) return { ok: false, errors: result.errors };
  return {
    ok: true,
    artifact: {
      recordKind: "artifact",
      path: input.path,
      mimeType: input.mimeType,
      size: input.size,
      sha256: input.sha256,
      bytesEntry: input.bytesEntry,
    },
  };
}

// ---------------------------------------------------------------------------
// Eligibility — pure evaluator (unit-testable) + transaction-aware fetcher
// ---------------------------------------------------------------------------

/**
 * An `artifact_namespaces` edge resolved against the Room that owns the
 * namespace. The fetcher joins `rooms.namespace_id → namespaces.id`
 * (REL-NSP-RMS 1:1) and carries the Room's denormalized human-member
 * actor-id set so the pure evaluator can apply the "exactly the exporting
 * owner's human actor" rule without a DB.
 */
export interface PrivateArtifactNamespaceEdge {
  readonly namespaceId: string;
  /** The Room that owns this namespace, or null if the namespace is orphaned. */
  readonly roomId: string | null;
  /** The Room's `human_actor_ids`; null when the namespace has no Room. */
  readonly humanActorIds: readonly string[] | null;
}

/**
 * Fully-resolved eligibility input — everything the pure evaluator needs to
 * decide with zero DB access. The transaction-aware fetcher
 * (`isArtifactEligibleForPrivateExportInTx`) assembles this.
 */
export interface PrivateArtifactEligibilityInput {
  /** The source artifact's internal `artifacts.id` (uuid PK). */
  readonly artifactInternalId: string;
  readonly ownerUserId: string;
  /** The exporting owner's single human actor id, or null if not uniquely resolvable. */
  readonly ownerHumanActorId: string | null;
  readonly namespaceEdges: readonly PrivateArtifactNamespaceEdge[];
}

export type PrivateArtifactEligibilityReason =
  | "no_edges"
  | "owner_human_actor_unresolved"
  | "namespace_no_room"
  | "namespace_shared_or_foreign";

export interface PrivateArtifactEligibilityResult {
  readonly eligible: boolean;
  readonly artifactInternalId: string;
  readonly namespaceEdgeCount: number;
  readonly reason?: PrivateArtifactEligibilityReason;
}

/**
 * Pure eligibility decision. Implements the Wave 3 rule:
 *
 *   - at least one `artifact_namespaces` edge; an artifact with no edges is
 *     rejected (it is not provably private to anyone);
 *   - the exporting owner must resolve to EXACTLY ONE human actor;
 *   - every namespace edge belongs to a Room whose `human_actor_ids` is
 *     exactly `[ownerHumanActorId]` — a private Room of the owner only;
 *   - the FIRST shared / foreign / no-room edge rejects the whole artifact.
 *
 * `artifact_scopes` is intentionally NOT evaluated — subagent-scope runtime
 * behavior is unimplemented (M088 Phase 4), so scope edges carry no
 * portable meaning.
 *
 * Pure / synchronous / no DB — exhaustively unit-testable.
 */
export function evaluatePrivateArtifactEligibility(
  input: PrivateArtifactEligibilityInput,
): PrivateArtifactEligibilityResult {
  const namespaceEdgeCount = input.namespaceEdges.length;
  const base = {
    artifactInternalId: input.artifactInternalId,
    namespaceEdgeCount,
  };

  if (namespaceEdgeCount === 0) {
    return { eligible: false, ...base, reason: "no_edges" };
  }

  if (!input.ownerHumanActorId) {
    return { eligible: false, ...base, reason: "owner_human_actor_unresolved" };
  }

  for (const edge of input.namespaceEdges) {
    if (!edge.roomId || !edge.humanActorIds) {
      return { eligible: false, ...base, reason: "namespace_no_room" };
    }
    if (
      edge.humanActorIds.length !== 1 ||
      edge.humanActorIds[0] !== input.ownerHumanActorId
    ) {
      return { eligible: false, ...base, reason: "namespace_shared_or_foreign" };
    }
  }

  return { eligible: true, ...base };
}

// ---------------------------------------------------------------------------
// Eligibility — transaction-aware fetcher
// ---------------------------------------------------------------------------

/**
 * Resolve EVERY `artifact_namespaces` edge of `artifactInternalId` against
 * the owning Room, plus the exporting owner's single human actor, and decide
 * private-export eligibility via `evaluatePrivateArtifactEligibility`. Runs
 * entirely inside the caller's transaction (read-only). `artifact_scopes` is
 * intentionally not inspected (runtime behavior unimplemented).
 */
export async function isArtifactEligibleForPrivateExportInTx(
  tx: ProfileMigrationTx,
  args: {
    /** Source artifact internal `artifacts.id` (uuid PK). */
    artifactInternalId: string;
    ownerUserId: string;
  },
): Promise<PrivateArtifactEligibilityResult> {
  // 1. The exporting owner's human actor — require exactly one.
  const ownerActorRows = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, args.ownerUserId), eq(actors.kind, "user")))
    .limit(2);
  const ownerHumanActorId =
    ownerActorRows.length === 1 ? (ownerActorRows[0]?.id ?? null) : null;

  // 2. Namespace edges → resolved against the owning Room.
  const namespaceRows = await tx
    .select({ namespaceId: artifactNamespaces.namespaceId })
    .from(artifactNamespaces)
    .where(eq(artifactNamespaces.artifactId, args.artifactInternalId));
  const namespaceEdges: PrivateArtifactNamespaceEdge[] = [];
  for (const row of namespaceRows) {
    const [room] = await tx
      .select({
        id: rooms.id,
        humanActorIds: rooms.humanActorIds,
      })
      .from(rooms)
      .where(eq(rooms.namespaceId, row.namespaceId))
      .limit(1);
    namespaceEdges.push({
      namespaceId: row.namespaceId,
      roomId: room?.id ?? null,
      humanActorIds: room?.humanActorIds ?? null,
    });
  }

  return evaluatePrivateArtifactEligibility({
    artifactInternalId: args.artifactInternalId,
    ownerUserId: args.ownerUserId,
    ownerHumanActorId,
    namespaceEdges,
  });
}

// ---------------------------------------------------------------------------
// Import — transaction-aware insert (no filesystem writes, no dedup/update)
// ---------------------------------------------------------------------------

/**
 * Arguments for `insertPrivateArtifactInTx`. The caller supplies a FRESH
 * target external `artifactId` (the stable id returned to tools / UI), the
 * canonical validated logical `path`, MIME, byte `size`, physical
 * `storageUri`, and the target private `namespaceId` to junction into.
 * No upsert / dedup / update: a colliding external `artifactId` is rejected
 * by the `uniq_artifacts_artifact_id` index, not silently overwritten.
 */
export interface InsertPrivateArtifactInTxArgs {
  /** Fresh target external `artifacts.artifact_id`. */
  artifactId: string;
  /** Canonical validated logical path. */
  path: string;
  /** MIME type. */
  mimeType: string;
  /** Byte length of the artifact bytes. */
  size: number;
  /** Physical storage URI (e.g. `file://...`). DB only — no FS write here. */
  storageUri: string;
  /** Target private namespace to junction the new artifact into. */
  targetNamespaceId: string;
}

export interface InsertPrivateArtifactInTxResult {
  /** The freshly minted internal `artifacts.id` (uuid). */
  artifactInternalId: string;
  /** The external `artifactId` the caller supplied. */
  artifactId: string;
  /** The namespace the new artifact was junctioned to. */
  namespaceId: string;
}

/**
 * Insert a fresh private artifact row + its `artifact_namespaces` junction
 * inside the caller's transaction. Import-only and deliberately narrow:
 *
 *   - NO filesystem / storage code runs here — bytes are written by the
 *     importer OUTSIDE this helper; this is a DB-only primitive.
 *   - NO deduplication / upsert / update — a new `artifacts.id` is always
 *     minted; a colliding external `artifactId` throws (unique index).
 *   - Only the `artifact_namespaces` junction is created. `artifact_scopes`
 *     junction replay is intentionally out of scope (runtime behavior
 *     unimplemented); the importer / a later wave owns it.
 *
 * Validates the safe logical `path` (the one contract field this primitive
 * persists) and rejects empty `artifactId` / `storageUri` / `mimeType` /
 * `targetNamespaceId` and negative `size` before touching the DB.
 *
 * A failure on either the artifact INSERT or the junction INSERT rolls back
 * with the caller's transaction, leaving no inserted rows / junctions.
 */
export async function insertPrivateArtifactInTx(
  tx: ProfileMigrationTx,
  args: InsertPrivateArtifactInTxArgs,
): Promise<InsertPrivateArtifactInTxResult> {
  if (!args.artifactId) {
    throw new Error("insertPrivateArtifactInTx: artifactId is required");
  }
  if (!isValidPortableArtifactPath(args.path)) {
    throw new Error("insertPrivateArtifactInTx: path is not a safe logical path");
  }
  if (!args.mimeType) {
    throw new Error("insertPrivateArtifactInTx: mimeType is required");
  }
  if (
    typeof args.size !== "number" ||
    !Number.isFinite(args.size) ||
    args.size < 0
  ) {
    throw new Error("insertPrivateArtifactInTx: size must be a non-negative number");
  }
  if (!args.storageUri) {
    throw new Error("insertPrivateArtifactInTx: storageUri is required");
  }
  if (!args.targetNamespaceId) {
    throw new Error(
      "insertPrivateArtifactInTx: targetNamespaceId is required (an artifact with no namespace edge is not provably private)",
    );
  }

  // Fresh INSERT — never an upsert, never an update. The `artifacts.id`
  // defaultRandom() mints a new internal uuid; `RETURNING id` reads it back so
  // the caller can compose further writes. A colliding external `artifactId`
  // is rejected by `uniq_artifacts_artifact_id` (throws) — no silent overwrite.
  const [inserted] = await tx
    .insert(artifacts)
    .values({
      artifactId: args.artifactId,
      path: args.path,
      mimeType: args.mimeType,
      size: args.size,
      storageUri: args.storageUri,
    })
    .returning({ id: artifacts.id });
  const artifactInternalId = inserted?.id;
  if (!artifactInternalId) {
    throw new Error("insertPrivateArtifactInTx: artifacts insert returned no row");
  }

  // Junction row. PK is (artifact_id, namespace_id); the artifact is freshly
  // minted so there is no conflict path, but `ON CONFLICT DO NOTHING` keeps
  // the helper idempotent if a caller ever re-runs against the same pair. A
  // non-existent namespace fails FK RESTRICT and throws — aborting the tx and
  // rolling back the artifact row above.
  await tx
    .insert(artifactNamespaces)
    .values({
      artifactId: artifactInternalId,
      namespaceId: args.targetNamespaceId,
    })
    .onConflictDoNothing();

  return {
    artifactInternalId,
    artifactId: args.artifactId,
    namespaceId: args.targetNamespaceId,
  };
}


