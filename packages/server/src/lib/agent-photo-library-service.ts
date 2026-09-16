import { createHash, randomUUID } from "node:crypto";
import {
  agentPhotoSelectionRevisions,
  and,
  createOwnedPhotoEntryIdempotently,
  eq,
  isNotNull,
  isNull,
  lt,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  sql,
  type AgentPhotoSelectionOrigin,
  type DirectDatabase,
  type OwnedPhotoEntry,
} from "@nautilo/db";
import { error as logError } from "@nautilo/logger";
import { gt } from "drizzle-orm";
import type { AvatarRef } from "@nautilo/types";
import { deriveOwnedAvatarBlobId } from "../photo-library/owned-avatar-staging";
import {
  AgentPhotoLibraryError,
  validateAgentPhotoLibraryAuthority,
  type AgentPhotoLibraryAuthority,
  type AgentPhotoLibraryCurrentState,
  type AgentPhotoLibraryErrorCode,
  type AgentPhotoLibraryFailure,
  type AgentPhotoLibraryScope,
} from "./agent-photo-library-authority";

export {
  AgentPhotoLibraryError,
  validateAgentPhotoLibraryAuthority,
  type AgentPhotoLibraryAuthority,
  type AgentPhotoLibraryCurrentState,
  type AgentPhotoLibraryErrorCode,
  type AgentPhotoLibraryProfileSnapshot,
  type AgentPhotoLibraryScope,
} from "./agent-photo-library-authority";

export type AgentPhotoSelectionTarget =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "preset"; readonly presetId: string }
  | { readonly kind: "clear" };

type StoredError = AgentPhotoLibraryFailure;

export interface AgentPhotoSelectionResult {
  readonly operation: "select" | "undo";
  readonly changed: boolean;
  readonly currentAvatarRef: AvatarRef | null;
  readonly currentEntryId: string | null;
  readonly revisionId: string | null;
  readonly scope: AgentPhotoLibraryScope;
}

/** A lifecycle mutation deliberately never changes the selected photo. */
export interface AgentPhotoEntryLifecycleResult {
  readonly operation: "delete" | "restore";
  readonly changed: true;
  readonly entryId: string;
  readonly scope: AgentPhotoLibraryScope;
}

export type AgentPhotoMutationResult =
  | AgentPhotoSelectionResult
  | AgentPhotoEntryLifecycleResult;

export interface AgentPhotoCreateReservationInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly slotCount: number;
  readonly source: "upload" | "generation" | "bundle_import";
  readonly origin: AgentPhotoSelectionOrigin;
  readonly semantics: readonly AgentPhotoCreateSemantic[];
}

/**
 * Creation semantics are the client-visible request identity. Provider/model
 * selection remains a server policy input, but once policy has selected it the
 * exact effective values are fingerprinted and cannot drift at finalization.
 */
export interface AgentPhotoCreateSemantic {
  readonly avatarKind: "generated" | "uploaded";
  /** Upload bytes are normalized and bound before the capacity reservation. */
  readonly media?: {
    readonly mimeType: "image/png";
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly prompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly batchOrdinal?: number;
}

export interface AgentPhotoCreateReservation {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly slotCount: number;
  readonly expiresAt: Date;
  readonly scope: AgentPhotoLibraryScope;
}

export type AgentPhotoCreateReservationOutcome = AgentPhotoCreateReservation | AgentPhotoCreateResult;

export interface AgentPhotoCreateFinalEntry {
  readonly ordinal: number;
  readonly blobId: string;
  readonly avatarKind: "generated" | "uploaded";
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: "image/png";
  readonly generation?: {
    readonly prompt?: string;
    readonly provider: string;
    readonly model: string;
    readonly batchOrdinal: number;
  };
}

export interface AgentPhotoCreateFinalizeInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly source: "upload" | "generation" | "bundle_import";
  readonly origin: AgentPhotoSelectionOrigin;
  readonly semantics: readonly AgentPhotoCreateSemantic[];
  readonly entries: readonly AgentPhotoCreateFinalEntry[];
}

export interface AgentPhotoCreateResult {
  readonly operation: "create";
  readonly entryIds: readonly string[];
  /** Safe replay projection: opaque entry identity plus authorized media URLs. */
  readonly entries: readonly AgentPhotoCreateEntry[];
  readonly scope: AgentPhotoLibraryScope;
}

export interface AgentPhotoCreateTransactionContext {
  readonly tx: AgentPhotoLibraryTransaction;
  readonly result: AgentPhotoCreateResult;
}

export interface AgentPhotoCreateEntry {
  readonly id: string;
  readonly source: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly media: {
    readonly thumbnailUrl: string;
    readonly fullUrl: string;
  };
}

export interface AgentPhotoCreateFailureInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly error: AgentPhotoLibraryFailure;
}

export type AgentPhotoCreateCommitState =
  | { readonly kind: "committed"; readonly value: AgentPhotoCreateResult }
  | { readonly kind: "not_committed" }
  | { readonly kind: "terminal_failure"; readonly error: AgentPhotoLibraryFailure };

/** A bounded, DB-proven expired reservation that is safe for artifact cleanup. */
export interface ExpiredAgentPhotoCreateReservation {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly slotCount: number;
}

interface StoredSuccess {
  readonly version: 1;
  readonly ok: true;
  readonly value: AgentPhotoMutationResult;
}

interface StoredFailure {
  readonly version: 1;
  readonly ok: false;
  readonly error: StoredError;
}

type StoredReceipt = StoredSuccess | StoredFailure;

export interface AgentPhotoSelectionInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly expectedSelectionRevision: string;
  readonly origin: AgentPhotoSelectionOrigin;
  readonly target: AgentPhotoSelectionTarget;
}

export interface AgentPhotoUndoInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly expectedSelectionRevision: string;
  readonly origin: AgentPhotoSelectionOrigin;
  readonly revisionId: string;
}

export interface AgentPhotoEntryLifecycleInput {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly operationId: string;
  readonly entryId: string;
  readonly origin: AgentPhotoSelectionOrigin;
}

export type AgentPhotoDeleteInput = AgentPhotoEntryLifecycleInput;
export type AgentPhotoRestoreInput = AgentPhotoEntryLifecycleInput;

export interface PhotoBlobPresenceInput {
  readonly entryId: string;
  readonly kind: "generated" | "uploaded";
  readonly blobId: string;
  readonly mediaMimeType: string;
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
}

export interface AgentPhotoLibraryDependencies {
  readonly db: DirectDatabase;
  /** Resolve only the known owned entry's exact storage location. */
  readonly blobExists: (input: PhotoBlobPresenceInput) => boolean | Promise<boolean>;
  /** The static preset catalogue remains outside owned-photo persistence. */
  readonly presetExists: (presetId: string) => boolean | Promise<boolean>;
  /** Publication happens only after the transaction has committed. */
  readonly afterCommit?: (result: AgentPhotoMutationResult) => void | Promise<void>;
  /** Create publication is emitted only after its entry/receipt transaction commits. */
  readonly afterCreateCommit?: (result: AgentPhotoCreateResult) => void | Promise<void>;
  readonly onAfterCommitError?: (
    error: unknown,
    result: AgentPhotoMutationResult | AgentPhotoCreateResult,
  ) => void;
}

type MutationKind = "select" | "undo" | "delete" | "restore";
type MutationInput = AgentPhotoSelectionInput | AgentPhotoUndoInput | AgentPhotoEntryLifecycleInput;

type TransactionOutcome =
  | { readonly kind: "success"; readonly value: AgentPhotoMutationResult; readonly publish: boolean }
  | { readonly kind: "failure"; readonly error: StoredError };

export type AgentPhotoLibraryTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export interface AgentPhotoSelectionTransactionResult {
  readonly value: AgentPhotoSelectionResult;
  readonly publish: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_TOKEN_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_TOKEN = Number.MAX_SAFE_INTEGER;
const ACTIVE_ENTRY_LIMIT = 200;
const CREATE_RESERVATION_MS = 15 * 60 * 1000;
const RECOVERABLE_DELETE_LIMIT = 100;
const RECOVERABLE_DELETE_MS = 30 * 24 * 60 * 60 * 1000;

const selectionOrigins = new Set<AgentPhotoSelectionOrigin>([
  "workbench",
  "mobile",
  "desktop_wizard",
  "cli_setup",
  "manage_avatar",
  "bundle_import",
]);

const errorCodes = new Set<AgentPhotoLibraryErrorCode>([
  "idempotency_mismatch",
  "deleted_library_capacity_reached",
  "library_capacity_reached",
  "invalid_photo_request",
  "operation_incomplete",
  "photo_blob_missing",
  "photo_deleted",
  "photo_forbidden",
  "photo_library_unavailable",
  "photo_not_found",
  "selection_conflict",
  "stale_library_revision",
  "stale_viewer_scope",
  "undo_conflict",
]);

function failure(
  code: AgentPhotoLibraryErrorCode,
  message: string,
  retryable = false,
  current?: AgentPhotoLibraryCurrentState,
): StoredError {
  return current ? { code, message, retryable, current } : { code, message, retryable };
}

function parseRevisionToken(value: string): number {
  if (!DECIMAL_TOKEN_PATTERN.test(value)) {
    throw new AgentPhotoLibraryError(failure(
      "invalid_photo_request",
      "Selection revision must be a canonical non-negative decimal string",
    ));
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AgentPhotoLibraryError(failure(
      "invalid_photo_request",
      "Selection revision is outside the supported range",
    ));
  }
  return parsed;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AgentPhotoLibraryError(failure(
      "invalid_photo_request",
      `${label} must be a UUID`,
    ));
  }
}

function avatarRefEquals(left: AvatarRef | null, right: AvatarRef | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "preset" && right.kind === "preset") return left.id === right.id;
  if (left.kind !== "preset" && right.kind !== "preset") return left.blobId === right.blobId;
  return false;
}

function requestFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalTarget(target: AgentPhotoSelectionTarget): Readonly<Record<string, string>> {
  if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
  if (target.kind === "preset") return { kind: "preset", presetId: target.presetId };
  return { kind: "clear" };
}

function scopeFor(
  authority: AgentPhotoLibraryAuthority,
  selectionRevision: number,
  libraryRevision: number,
): AgentPhotoLibraryScope {
  return {
    serverInstanceId: authority.serverInstanceId,
    viewerUserId: authority.viewerUserId,
    agentId: authority.agentId,
    selectionRevision: String(selectionRevision),
    libraryRevision: String(libraryRevision),
  };
}

function currentState(
  authority: AgentPhotoLibraryAuthority,
  profile: {
    avatarRef: AvatarRef | null;
    avatarSelectionRevision: number;
    avatarLibraryRevision: number;
  },
  entryId: string | null,
): AgentPhotoLibraryCurrentState {
  return {
    avatarRef: profile.avatarRef,
    entryId,
    scope: scopeFor(
      authority,
      profile.avatarSelectionRevision,
      profile.avatarLibraryRevision,
    ),
  };
}

function storedSuccess(value: AgentPhotoMutationResult): StoredSuccess {
  return { version: 1, ok: true, value };
}

function storedFailure(error: StoredError): StoredFailure {
  return { version: 1, ok: false, error };
}

function isAvatarRef(value: unknown): value is AvatarRef | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["kind"] === "preset") {
    return typeof candidate["id"] === "string"
      && candidate["id"].length > 0
      && candidate["id"].length <= 100;
  }
  return (candidate["kind"] === "generated" || candidate["kind"] === "uploaded")
    && typeof candidate["blobId"] === "string"
    && /^[A-Za-z0-9._-]{1,256}$/.test(candidate["blobId"]);
}

function isScope(value: unknown): value is AgentPhotoLibraryScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["serverInstanceId"] === "string"
    && UUID_PATTERN.test(candidate["serverInstanceId"])
    && typeof candidate["viewerUserId"] === "string"
    && UUID_PATTERN.test(candidate["viewerUserId"])
    && typeof candidate["agentId"] === "string"
    && UUID_PATTERN.test(candidate["agentId"])
    && typeof candidate["selectionRevision"] === "string"
    && DECIMAL_TOKEN_PATTERN.test(candidate["selectionRevision"])
    && Number.isSafeInteger(Number(candidate["selectionRevision"]))
    && typeof candidate["libraryRevision"] === "string"
    && DECIMAL_TOKEN_PATTERN.test(candidate["libraryRevision"])
    && Number.isSafeInteger(Number(candidate["libraryRevision"]));
}

function isCurrentState(value: unknown): value is AgentPhotoLibraryCurrentState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isAvatarRef(candidate["avatarRef"])
    && (candidate["entryId"] === null
      || (typeof candidate["entryId"] === "string" && UUID_PATTERN.test(candidate["entryId"])))
    && isScope(candidate["scope"]);
}

function isSelectionResult(value: unknown): value is AgentPhotoSelectionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate["operation"] === "select" || candidate["operation"] === "undo")
    && typeof candidate["changed"] === "boolean"
    && isAvatarRef(candidate["currentAvatarRef"])
    && (candidate["currentEntryId"] === null
      || (typeof candidate["currentEntryId"] === "string"
        && UUID_PATTERN.test(candidate["currentEntryId"])))
    && (candidate["revisionId"] === null
      || (typeof candidate["revisionId"] === "string" && UUID_PATTERN.test(candidate["revisionId"])))
    && isScope(candidate["scope"]);
}

function isEntryLifecycleResult(value: unknown): value is AgentPhotoEntryLifecycleResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate["operation"] === "delete" || candidate["operation"] === "restore")
    && candidate["changed"] === true
    && typeof candidate["entryId"] === "string"
    && UUID_PATTERN.test(candidate["entryId"])
    && isScope(candidate["scope"]);
}

function isMutationResult(value: unknown): value is AgentPhotoMutationResult {
  return isSelectionResult(value) || isEntryLifecycleResult(value);
}

function isStoredError(value: unknown): value is StoredError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["code"] === "string"
    && errorCodes.has(candidate["code"] as AgentPhotoLibraryErrorCode)
    && typeof candidate["message"] === "string"
    && candidate["message"].length > 0
    && candidate["message"].length <= 1_000
    && typeof candidate["retryable"] === "boolean"
    && (candidate["current"] === undefined || isCurrentState(candidate["current"]))
    // Read-only refresh scope is never persisted in an idempotency receipt.
    && candidate["scope"] === undefined;
}

function isAgentPhotoCreateResult(value: unknown): value is AgentPhotoCreateResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate["operation"] === "create"
    && Array.isArray(candidate["entryIds"])
    && candidate["entryIds"].length >= 1
    && candidate["entryIds"].length <= 4
    && candidate["entryIds"].every((id) => typeof id === "string" && UUID_PATTERN.test(id))
    && Array.isArray(candidate["entries"])
    && candidate["entries"].length === candidate["entryIds"].length
    && candidate["entries"].every((entry) => isAgentPhotoCreateEntry(entry))
    && isScope(candidate["scope"]);
}

function isAgentPhotoCreateEntry(value: unknown): value is AgentPhotoCreateEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const media = candidate["media"];
  return typeof candidate["id"] === "string"
    && UUID_PATTERN.test(candidate["id"])
    && typeof candidate["source"] === "string"
    && typeof candidate["origin"] === "string"
    && typeof candidate["createdAt"] === "string"
    && !Number.isNaN(Date.parse(candidate["createdAt"]))
    && !!media
    && typeof media === "object"
    && typeof (media as Record<string, unknown>)["thumbnailUrl"] === "string"
    && typeof (media as Record<string, unknown>)["fullUrl"] === "string";
}

function createResultEntry(entry: OwnedPhotoEntry): AgentPhotoCreateEntry {
  const base = `/api/profile/agent-photo-library/entries/${encodeURIComponent(entry.id)}/media`;
  return {
    id: entry.id,
    source: entry.source,
    origin: entry.origin,
    createdAt: entry.createdAt.toISOString(),
    media: {
      thumbnailUrl: `${base}?size=thumb&v=${encodeURIComponent(entry.id)}`,
      fullUrl: `${base}?size=full&v=${encodeURIComponent(entry.id)}`,
    },
  };
}

function parseCreateReceipt(value: unknown): AgentPhotoCreateResult | StoredError {
  if (!value || typeof value !== "object") {
    throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Stored photo creation receipt is invalid", true));
  }
  const receipt = value as Record<string, unknown>;
  if (receipt["version"] !== 1 || typeof receipt["ok"] !== "boolean") {
    throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Stored photo creation receipt is invalid", true));
  }
  if (receipt["ok"] === true && isAgentPhotoCreateResult(receipt["value"])) return receipt["value"];
  if (receipt["ok"] === false && isStoredError(receipt["error"])) return receipt["error"];
  throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Stored photo creation receipt is invalid", true));
}

interface CanonicalCreateSemantic {
  readonly avatarKind: "generated" | "uploaded";
  readonly prompt: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly batchOrdinal: number | null;
  readonly mediaMimeType: "image/png" | null;
  readonly mediaByteSize: number | null;
  readonly mediaSha256: string | null;
}

function canonicalCreateSemantics(
  source: AgentPhotoCreateReservationInput["source"],
  semantics: readonly AgentPhotoCreateSemantic[],
): readonly CanonicalCreateSemantic[] {
  return semantics.map((semantic, ordinal) => {
    if (semantic.avatarKind !== "generated" && semantic.avatarKind !== "uploaded") {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation candidate kind is invalid"));
    }
    if (source === "generation" && semantic.avatarKind !== "generated") {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Generated batches may contain only generated candidates"));
    }
    if (source === "upload" && semantic.avatarKind !== "uploaded") {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Uploaded batches may contain only uploaded candidates"));
    }
    const prompt = semantic.prompt ?? null;
    const provider = semantic.provider ?? null;
    const model = semantic.model ?? null;
    // The server-owned generation policy must canonicalize this before the
    // reservation. Accepting an omitted ordinal here and discovering it only
    // after the provider ran would spend paid work on an unfinalizable batch.
    const batchOrdinal = semantic.batchOrdinal ?? null;
    const media = semantic.media ?? null;
    if (typeof prompt !== "string" && prompt !== null || typeof provider !== "string" && provider !== null || typeof model !== "string" && model !== null) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation metadata is invalid"));
    }
    if ((prompt?.length ?? 0) > 500 || (provider?.length ?? 0) > 200 || (model?.length ?? 0) > 200) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation metadata exceeds its limit"));
    }
    if (semantic.avatarKind === "generated") {
      if (!Number.isInteger(batchOrdinal) || batchOrdinal !== ordinal || !provider || !model) {
        throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Generated candidate policy metadata is invalid"));
      }
      if (media !== null) {
        throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Generated candidate may not carry upload media intent"));
      }
    } else if (prompt !== null || provider !== null || model !== null || batchOrdinal !== null) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Uploaded candidate may not carry generation metadata"));
    }
    if (semantic.avatarKind === "uploaded" && (
      !media
      || media.mimeType !== "image/png"
      || !Number.isSafeInteger(media.byteSize)
      || media.byteSize < 1
      || media.byteSize > 5 * 1024 * 1024
      || !/^[0-9a-f]{64}$/.test(media.sha256)
    )) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Uploaded candidate must bind normalized media facts"));
    }
    return {
      avatarKind: semantic.avatarKind,
      prompt,
      provider,
      model,
      batchOrdinal,
      mediaMimeType: media?.mimeType ?? null,
      mediaByteSize: media?.byteSize ?? null,
      mediaSha256: media?.sha256 ?? null,
    };
  });
}

function createFingerprint(input: {
  readonly authority: AgentPhotoLibraryAuthority;
  readonly slotCount: number;
  readonly source: AgentPhotoCreateReservationInput["source"];
  readonly origin: AgentPhotoSelectionOrigin;
  readonly semantics: readonly AgentPhotoCreateSemantic[];
}): string {
  if (!Number.isInteger(input.slotCount) || input.slotCount < 1 || input.slotCount > 4 || input.semantics.length !== input.slotCount) {
    throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation batch must contain from 1 to 4 entries"));
  }
  if (input.source !== "upload" && input.source !== "generation" && input.source !== "bundle_import") {
    throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation source is invalid"));
  }
  if (!selectionOrigins.has(input.origin)) {
    throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation origin is invalid"));
  }
  return requestFingerprint({
    fingerprintVersion: 1,
    operation: "create",
    authority: [input.authority.serverInstanceId, input.authority.viewerUserId, input.authority.ownerUserId, input.authority.agentId],
    slotCount: input.slotCount,
    source: input.source,
    origin: input.origin,
    semantics: canonicalCreateSemantics(input.source, input.semantics),
  });
}

function parseStoredReceipt(value: unknown): StoredReceipt {
  if (!value || typeof value !== "object") {
    throw new AgentPhotoLibraryError(failure(
      "photo_library_unavailable",
      "Stored photo operation receipt is invalid",
      true,
    ));
  }
  const receipt = value as Record<string, unknown>;
  if (receipt["version"] !== 1 || typeof receipt["ok"] !== "boolean") {
    throw new AgentPhotoLibraryError(failure(
      "photo_library_unavailable",
      "Stored photo operation receipt is invalid",
      true,
    ));
  }
  if (receipt["ok"] === true && isMutationResult(receipt["value"])) {
    return { version: 1, ok: true, value: receipt["value"] };
  }
  if (receipt["ok"] === false && isStoredError(receipt["error"])) {
    return { version: 1, ok: false, error: receipt["error"] };
  }
  throw new AgentPhotoLibraryError(failure(
    "photo_library_unavailable",
    "Stored photo operation receipt has an invalid terminal result",
    true,
  ));
}

function currentCustomRef(avatarRef: AvatarRef | null): avatarRef is Extract<AvatarRef, { kind: "generated" | "uploaded" }> {
  return avatarRef !== null && avatarRef.kind !== "preset";
}

function entryAvatarKind(entry: OwnedPhotoEntry): "generated" | "uploaded" {
  if (entry.avatarKind !== "generated" && entry.avatarKind !== "uploaded") {
    throw new AgentPhotoLibraryError(failure(
      "photo_library_unavailable",
      "Owned photo entry has an invalid avatar kind",
      true,
    ));
  }
  return entry.avatarKind;
}

/**
 * The sole mutation spine for D487 Agent-photo selection and Undo.
 *
 * Callers must resolve an authority tuple first. The service does not trust it:
 * the durable instance identity, canonical actors mirror, and Agent profile are
 * revalidated while holding the profile row lock that serializes selection.
 */
export class AgentPhotoLibraryService {
  readonly #dependencies: AgentPhotoLibraryDependencies;

  constructor(dependencies: AgentPhotoLibraryDependencies) {
    this.#dependencies = dependencies;
  }

  /** Reserve 1–4 creation slots before any provider call or final write. */
  async reserveCreate(input: AgentPhotoCreateReservationInput): Promise<AgentPhotoCreateReservationOutcome> {
    assertUuid(input.operationId, "Operation id");
    const fingerprint = createFingerprint(input);
    const outcome = await this.#dependencies.db.transaction(async (tx): Promise<
      AgentPhotoCreateReservationOutcome | { readonly capacityFailure: true; readonly error: AgentPhotoLibraryError }
    > => {
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const now = new Date();
      const [existing] = await tx.select().from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
      )).limit(1).for("update");
      if (existing) {
        if (existing.operationKind !== "create" || existing.requestFingerprint !== fingerprint) {
          throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Operation id is already bound to a different photo request"));
        }
        if (existing.state !== "pending") {
          const replay = parseCreateReceipt(existing.result);
          if ("operation" in replay) return replay;
          throw new AgentPhotoLibraryError(replay);
        }
        // Never start a second provider call for a caller that lost the first
        // response. The pending reservation is intentionally not replayable.
        throw new AgentPhotoLibraryError(failure("operation_incomplete", "Photo creation is already in progress or has completed", true));
      }
      // New creation would need to advance the library revision. Do not
      // reserve capacity (and consequently do not invoke a provider) when the
      // durable token cannot advance; a terminal replay remains above.
      if (profile.avatarLibraryRevision >= MAX_TOKEN) {
        throw new AgentPhotoLibraryError(failure(
          "photo_library_unavailable",
          "Agent photo revision capacity is exhausted",
        ));
      }
      const [active, reserved] = await Promise.all([
        tx.select({ count: sql<number>`count(*)::int` }).from(ownedPhotoEntries).where(and(
          eq(ownedPhotoEntries.serverInstanceId, input.authority.serverInstanceId),
          eq(ownedPhotoEntries.ownerUserId, input.authority.ownerUserId),
          eq(ownedPhotoEntries.subjectKind, "agent"),
          eq(ownedPhotoEntries.agentId, input.authority.agentId),
          isNull(ownedPhotoEntries.deletedAt),
        )),
        tx.select({ count: sql<number>`coalesce(sum(${photoLibraryOperations.reservedSlots}), 0)::int` }).from(photoLibraryOperations).where(and(
          eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
          eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
          eq(photoLibraryOperations.agentId, input.authority.agentId),
          eq(photoLibraryOperations.operationKind, "create"),
          eq(photoLibraryOperations.state, "pending"),
          gt(photoLibraryOperations.reservationExpiresAt, now),
        )),
      ]);
      if ((active[0]?.count ?? 0) + (reserved[0]?.count ?? 0) + input.slotCount > ACTIVE_ENTRY_LIMIT) {
        const leaseToken = randomUUID();
        await tx.insert(photoLibraryOperations).values({
          serverInstanceId: input.authority.serverInstanceId,
          viewerUserId: input.authority.viewerUserId,
          ownerUserId: input.authority.ownerUserId,
          agentId: input.authority.agentId,
          operationId: input.operationId,
          operationKind: "create",
          requestFingerprint: fingerprint,
          state: "failed",
          reservedSlots: input.slotCount,
          reservationExpiresAt: now,
          reservationLeaseToken: leaseToken,
          // No candidate producer ran for a capacity receipt. Mark it as
          // reconciled immediately so bounded artifact recovery never spends
          // a page repeatedly selecting receipts that have no artifacts.
          artifactCleanupCompletedAt: now,
          result: { version: 1, ok: false, error: { code: "library_capacity_reached", message: "The active Agent photo library is full", retryable: false } },
          completedAt: now,
        });
        // Return through the transaction so the exact terminal failure is
        // committed. Throw only after the transaction resolves; otherwise the
        // insert rolls back and a later retry can accidentally become a new
        // provider request.
        return {
          capacityFailure: true,
          error: new AgentPhotoLibraryError(failure(
            "library_capacity_reached",
            "The active Agent photo library is full",
          )),
        };
      }
      const expiresAt = new Date(now.getTime() + CREATE_RESERVATION_MS);
      const leaseToken = randomUUID();
      await tx.insert(photoLibraryOperations).values({
        serverInstanceId: input.authority.serverInstanceId,
        viewerUserId: input.authority.viewerUserId,
        ownerUserId: input.authority.ownerUserId,
        agentId: input.authority.agentId,
        operationId: input.operationId,
        operationKind: "create",
        requestFingerprint: fingerprint,
        state: "pending",
        reservedSlots: input.slotCount,
        reservationExpiresAt: expiresAt,
        reservationLeaseToken: leaseToken,
      });
      return { operationId: input.operationId, leaseToken, slotCount: input.slotCount, expiresAt, scope: scopeFor(input.authority, profile.avatarSelectionRevision, profile.avatarLibraryRevision) };
    });
    if ("capacityFailure" in outcome) throw outcome.error;
    return outcome;
  }

  /**
   * Terminalize a small page of expired reservations without ever retrying a
   * provider. Holding the same profile lock as finalization proves no worker
   * can publish/commit while an item is converted into a cleanup receipt.
   */
  async reapExpiredCreateReservations(input: {
    readonly authority: AgentPhotoLibraryAuthority;
    readonly limit?: number;
  }): Promise<readonly ExpiredAgentPhotoCreateReservation[]> {
    const limit = input.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Expired reservation recovery limit is invalid"));
    }
    return this.#dependencies.db.transaction(async (tx) => {
      await this.#lockAndValidateAuthority(tx, input.authority);
      const now = new Date();
      const expired = await tx.select({
        id: photoLibraryOperations.id,
        operationId: photoLibraryOperations.operationId,
        reservationLeaseToken: photoLibraryOperations.reservationLeaseToken,
        reservedSlots: photoLibraryOperations.reservedSlots,
        state: photoLibraryOperations.state,
        result: photoLibraryOperations.result,
        artifactCleanupCompletedAt: photoLibraryOperations.artifactCleanupCompletedAt,
      }).from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationKind, "create"),
        lt(photoLibraryOperations.reservationExpiresAt, now),
        sql`(${photoLibraryOperations.state} = 'pending' OR (${photoLibraryOperations.state} = 'failed' AND ${photoLibraryOperations.artifactCleanupCompletedAt} IS NULL))`,
      )).limit(limit).for("update");
      const cleaned: ExpiredAgentPhotoCreateReservation[] = [];
      for (const operation of expired) {
        if (!operation.reservationLeaseToken || operation.reservedSlots < 1 || operation.reservedSlots > 4) {
          throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Expired photo reservation is malformed", true));
        }
        // The profile lock serializes all finalization. A committed owned row
        // with a pending receipt is impossible; refuse cleanup rather than
        // guessing if corruption ever violates that invariant.
        const committed = await tx.select({ id: ownedPhotoEntries.id }).from(ownedPhotoEntries).where(and(
          eq(ownedPhotoEntries.serverInstanceId, input.authority.serverInstanceId),
          eq(ownedPhotoEntries.ownerUserId, input.authority.ownerUserId),
          eq(ownedPhotoEntries.subjectKind, "agent"),
          eq(ownedPhotoEntries.agentId, input.authority.agentId),
          eq(ownedPhotoEntries.operationId, operation.operationId),
        )).limit(1);
        if (committed.length > 0) {
          throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Expired photo reservation has committed media", true));
        }
        if (operation.state === "pending") {
          const updated = await tx.update(photoLibraryOperations).set({
            state: "failed",
            result: { version: 1, ok: false, error: { code: "operation_incomplete", message: "Photo creation reservation expired", retryable: true } },
            completedAt: now,
          }).where(and(
            eq(photoLibraryOperations.id, operation.id),
            eq(photoLibraryOperations.state, "pending"),
            eq(photoLibraryOperations.reservationLeaseToken, operation.reservationLeaseToken),
          )).returning({ id: photoLibraryOperations.id });
          if (updated.length !== 1) continue;
        } else {
          // A previous cleanup attempt can fail at the filesystem boundary
          // after the durable receipt is already terminal. Only retry the
          // known artifact-producing failure classes; capacity failures never
          // had a producer and are not filesystem cleanup work.
          const receipt = parseCreateReceipt(operation.result);
          if ("operation" in receipt || !(
            receipt.code === "operation_incomplete"
            || receipt.code === "photo_library_unavailable"
          )) continue;
        }
        {
          cleaned.push({
            operationId: operation.operationId,
            leaseToken: operation.reservationLeaseToken,
            slotCount: operation.reservedSlots,
          });
        }
      }
      return cleaned;
    });
  }

  /** Mark only successfully removed deterministic artifacts as reconciled. */
  async markExpiredCreateArtifactCleanupComplete(input: {
    readonly authority: AgentPhotoLibraryAuthority;
    readonly operationId: string;
    readonly leaseToken: string;
  }): Promise<boolean> {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.leaseToken, "Photo creation lease token");
    return this.#dependencies.db.transaction(async (tx) => {
      await this.#lockAndValidateAuthority(tx, input.authority);
      const updated = await tx.update(photoLibraryOperations).set({
        artifactCleanupCompletedAt: new Date(),
      }).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
        eq(photoLibraryOperations.operationKind, "create"),
        eq(photoLibraryOperations.state, "failed"),
        eq(photoLibraryOperations.reservationLeaseToken, input.leaseToken),
        isNull(photoLibraryOperations.artifactCleanupCompletedAt),
      )).returning({ id: photoLibraryOperations.id });
      if (updated.length === 1) return true;
      // Two recovery workers can both remove the same deterministic files.
      // A second worker arriving after the first committed the durable marker
      // has still completed the intended idempotent cleanup, not failed it.
      const [alreadyMarked] = await tx.select({
        artifactCleanupCompletedAt: photoLibraryOperations.artifactCleanupCompletedAt,
      }).from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
        eq(photoLibraryOperations.operationKind, "create"),
        eq(photoLibraryOperations.state, "failed"),
        eq(photoLibraryOperations.reservationLeaseToken, input.leaseToken),
      )).limit(1).for("update");
      return alreadyMarked?.artifactCleanupCompletedAt !== null
        && alreadyMarked?.artifactCleanupCompletedAt !== undefined;
    });
  }

  /** Commit all previously staged candidates together; this never selects one. */
  async finalizeCreate(
    input: AgentPhotoCreateFinalizeInput,
    promoteStaged: () => Promise<void>,
    afterCreateInTransaction?: (
      context: AgentPhotoCreateTransactionContext,
    ) => Promise<void>,
  ): Promise<AgentPhotoCreateResult> {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.leaseToken, "Photo creation lease token");
    if (input.entries.length < 1 || input.entries.length > 4 || input.entries.length !== input.semantics.length || new Set(input.entries.map((entry) => entry.blobId)).size !== input.entries.length) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation finalization has an invalid batch"));
    }
    const fingerprint = createFingerprint({ ...input, slotCount: input.entries.length });
    const outcome = await this.#dependencies.db.transaction(async (tx): Promise<{ readonly value: AgentPhotoCreateResult; readonly publish: boolean }> => {
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const [operation] = await tx.select().from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
      )).limit(1).for("update");
      if (!operation) throw new AgentPhotoLibraryError(failure("photo_not_found", "Photo creation reservation is unavailable"));
      if (operation.operationKind !== "create" || operation.requestFingerprint !== fingerprint) {
        throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Photo creation finalization differs from its reservation"));
      }
      if (operation.state !== "pending") {
        const replay = parseCreateReceipt(operation.result);
        if ("operation" in replay) return { value: replay, publish: false };
        throw new AgentPhotoLibraryError(replay);
      }
      if (!operation.reservationExpiresAt || !operation.reservationLeaseToken || operation.reservationExpiresAt <= new Date()) {
        throw new AgentPhotoLibraryError(failure("operation_incomplete", "Photo creation reservation expired", true));
      }
      if (operation.reservationLeaseToken !== input.leaseToken) {
        throw new AgentPhotoLibraryError(failure("operation_incomplete", "Photo creation lease is no longer current", true));
      }
      if (operation.reservedSlots !== input.entries.length) {
        throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Photo creation batch does not match its reservation"));
      }
      const expectedSemantics = canonicalCreateSemantics(input.source, input.semantics);
      for (const [ordinal, entry] of input.entries.entries()) {
        const semantic = expectedSemantics[ordinal];
        const expectedBlobId = deriveOwnedAvatarBlobId({ scope: input.authority, operationId: input.operationId, ordinal });
        if (
          !semantic
          || entry.ordinal !== ordinal
          || entry.blobId !== expectedBlobId
          || entry.avatarKind !== semantic.avatarKind
          || entry.mediaMimeType !== "image/png"
          || !Number.isSafeInteger(entry.mediaByteSize)
          || entry.mediaByteSize < 1
          || !/^[0-9a-f]{64}$/.test(entry.mediaSha256)
          || (semantic.avatarKind === "uploaded" && (
            entry.mediaByteSize !== semantic.mediaByteSize
            || entry.mediaSha256 !== semantic.mediaSha256
          ))
        ) {
          throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Photo creation entry does not match its reservation"));
        }
      }
      // The profile then operation row locks fence this bounded local publish:
      // no expired or stale lease can race final files into visibility.
      await promoteStaged();
      const created = [] as OwnedPhotoEntry[];
      for (const [ordinal, entry] of input.entries.entries()) {
        if (!/^[A-Za-z0-9._-]{1,256}$/.test(entry.blobId) || !Number.isSafeInteger(entry.mediaByteSize) || entry.mediaByteSize < 1 || !/^[0-9a-f]{64}$/.test(entry.mediaSha256)) {
          throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation entry is invalid"));
        }
        const semantic = expectedSemantics[ordinal];
        const expectedBlobId = deriveOwnedAvatarBlobId({ scope: input.authority, operationId: input.operationId, ordinal });
        if (!semantic || entry.ordinal !== ordinal || entry.blobId !== expectedBlobId || entry.avatarKind !== semantic.avatarKind || entry.mediaMimeType !== "image/png") {
          throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Photo creation entry does not match its reservation"));
        }
        if (semantic.avatarKind === "generated") {
          if (!entry.generation || entry.generation.prompt !== semantic.prompt || entry.generation.provider !== semantic.provider || entry.generation.model !== semantic.model || entry.generation.batchOrdinal !== semantic.batchOrdinal) {
            throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Generated photo provenance does not match its reservation"));
          }
        } else if (entry.generation) {
          throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Uploaded photo may not carry generated provenance"));
        }
        if (
          semantic.avatarKind === "uploaded"
          && (entry.mediaMimeType !== semantic.mediaMimeType
            || entry.mediaByteSize !== semantic.mediaByteSize
            || entry.mediaSha256 !== semantic.mediaSha256)
        ) {
          throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Uploaded photo bytes do not match their reservation"));
        }
        const result = await createOwnedPhotoEntryIdempotently(tx, {
          serverInstanceId: input.authority.serverInstanceId,
          ownerUserId: input.authority.ownerUserId,
          subjectKind: "agent",
          agentId: input.authority.agentId,
          avatarKind: entry.avatarKind,
          blobId: entry.blobId,
          source: input.source,
          origin: input.origin,
          operationId: input.operationId,
          requestFingerprint: operation.requestFingerprint,
          mediaMimeType: entry.mediaMimeType,
          mediaByteSize: entry.mediaByteSize,
          mediaSha256: entry.mediaSha256,
          generationPrompt: entry.generation?.prompt ?? null,
          generationProvider: entry.generation?.provider ?? null,
          generationModel: entry.generation?.model ?? null,
          generationBatchOrdinal: entry.generation?.batchOrdinal ?? null,
        });
        if (result.kind === "collision") throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Photo bytes are already owned by another operation"));
        created.push(result.entry);
      }
      const nextLibraryRevision = profile.avatarLibraryRevision + 1;
      await tx.update(profiles).set({ avatarLibraryRevision: nextLibraryRevision, updatedAt: new Date() }).where(eq(profiles.id, profile.id));
      const scope = scopeFor(input.authority, profile.avatarSelectionRevision, nextLibraryRevision);
      const value: AgentPhotoCreateResult = {
        operation: "create",
        entryIds: created.map((entry) => entry.id),
        entries: created.map(createResultEntry),
        scope,
      };
      // Bundle import composes its accepted non-photo mutation and canonical
      // selection here. Any failure rolls entries, revisions, receipts, and
      // the wider mutation back together; the coordinator then compensates
      // only the promoted bytes after proving this transaction did not land.
      await afterCreateInTransaction?.({ tx, result: value });
      await tx.update(photoLibraryOperations).set({
        state: "completed",
        result: { version: 1, ok: true, value },
        completedAt: new Date(),
      }).where(eq(photoLibraryOperations.id, operation.id));
      // A composed create+select transaction publishes the final selection
      // once after the outer commit; emitting the intermediate unselected
      // creation would duplicate profile.updated for one accepted import.
      return { value, publish: afterCreateInTransaction === undefined };
    });
    if (outcome.publish) await this.#finishCreate(outcome.value);
    return outcome.value;
  }

  /**
   * Terminally records a known pre-commit failure only while the caller still
   * owns the pending lease. A stale worker must never erase a newer worker's
   * reservation or receipt.
   */
  async failCreate(input: AgentPhotoCreateFailureInput): Promise<boolean> {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.leaseToken, "Photo creation lease token");
    if (!isStoredError(input.error)) {
      throw new AgentPhotoLibraryError(failure("invalid_photo_request", "Photo creation failure receipt is invalid"));
    }
    return this.#dependencies.db.transaction(async (tx) => {
      await this.#lockAndValidateAuthority(tx, input.authority);
      const [operation] = await tx.select().from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
      )).limit(1).for("update");
      if (!operation || operation.operationKind !== "create" || operation.state !== "pending" || operation.reservationLeaseToken !== input.leaseToken) return false;
      const updated = await tx.update(photoLibraryOperations).set({
        state: "failed",
        result: { version: 1, ok: false, error: input.error },
        completedAt: new Date(),
      }).where(and(
        eq(photoLibraryOperations.id, operation.id),
        eq(photoLibraryOperations.state, "pending"),
        eq(photoLibraryOperations.reservationLeaseToken, input.leaseToken),
      )).returning({ id: photoLibraryOperations.id });
      return updated.length === 1;
    });
  }

  /**
   * Re-reads only the durable, authorized operation state after a storage/DB
   * boundary failed. `not_committed` is the sole state that authorizes
   * compensating removal of final blobs; a DB error must propagate instead.
   */
  async inspectCreateCommitState(input: {
    readonly authority: AgentPhotoLibraryAuthority;
    readonly operationId: string;
    readonly leaseToken: string;
  }): Promise<AgentPhotoCreateCommitState> {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.leaseToken, "Photo creation lease token");
    return this.#dependencies.db.transaction(async (tx) => {
      await this.#lockAndValidateAuthority(tx, input.authority);
      const [operation] = await tx.select({
        operationKind: photoLibraryOperations.operationKind,
        state: photoLibraryOperations.state,
        reservationLeaseToken: photoLibraryOperations.reservationLeaseToken,
        result: photoLibraryOperations.result,
      }).from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
      )).limit(1).for("update");
      if (!operation) return { kind: "not_committed" };
      if (operation.operationKind !== "create") {
        throw new AgentPhotoLibraryError(failure("idempotency_mismatch", "Operation id is already bound to a different photo request"));
      }
      if (operation.state !== "pending") {
        const receipt = parseCreateReceipt(operation.result);
        return "operation" in receipt
          ? { kind: "committed", value: receipt }
          : { kind: "terminal_failure", error: receipt };
      }
      // The pending operation itself holds no committed entry. A mismatched
      // token belongs to a different worker and must not authorize cleanup.
      if (operation.reservationLeaseToken !== input.leaseToken) {
        throw new AgentPhotoLibraryError(failure("operation_incomplete", "Photo creation lease is no longer current", true));
      }
      const entries = await tx.select({ id: ownedPhotoEntries.id }).from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, input.authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, input.authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, input.authority.agentId),
        eq(ownedPhotoEntries.operationId, input.operationId),
      )).limit(1);
      if (entries.length > 0) {
        throw new AgentPhotoLibraryError(failure("photo_library_unavailable", "Photo creation state is inconsistent", true));
      }
      return { kind: "not_committed" };
    });
  }

  /**
   * Soft-delete an owned, non-current entry.  The original bytes remain intact
   * through the recovery window; collection is a separate, explicitly claimed
   * lifecycle after that window closes.
   */
  async delete(input: AgentPhotoDeleteInput): Promise<AgentPhotoEntryLifecycleResult> {
    this.#validateLifecycleInput(input);
    const fingerprint = this.#lifecycleFingerprint("delete", input);
    const outcome = await this.#dependencies.db.transaction(async (tx): Promise<TransactionOutcome> => {
      // Authority always locks Profile then its actor mirror.  Only afterwards
      // do we lock the exact entry, which is the shared mutation lock order.
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const replay = await this.#findReplay(tx, "delete", input, fingerprint);
      if (replay) return replay;

      const entry = await this.#lockOwnedEntry(tx, input.authority, input.entryId);
      if (!entry) {
        return this.#recordFailure(tx, "delete", input, fingerprint, failure(
          "photo_not_found", "The requested Agent photo is unavailable",
        ));
      }
      if (entry.deletedAt !== null) {
        return this.#recordFailure(tx, "delete", input, fingerprint, failure(
          "photo_deleted", "The requested Agent photo is already deleted",
        ));
      }
      if (this.#entryIsCurrent(profile.avatarRef, entry)) {
        return this.#recordFailure(tx, "delete", input, fingerprint, failure(
          "invalid_photo_request", "Select another Agent photo before deleting the current photo",
        ));
      }
      if (profile.avatarLibraryRevision >= MAX_TOKEN) {
        return this.#recordFailure(tx, "delete", input, fingerprint, failure(
          "photo_library_unavailable", "Agent photo revision capacity is exhausted",
        ));
      }
      const recoverableDeleted = await this.#recoverableDeletedCount(tx, input.authority, new Date());
      if (recoverableDeleted >= RECOVERABLE_DELETE_LIMIT) {
        return this.#recordFailure(tx, "delete", input, fingerprint, failure(
          "deleted_library_capacity_reached", "Delete recovery is full; restore or wait for an older deleted photo to expire",
        ));
      }
      const now = new Date();
      const nextLibraryRevision = profile.avatarLibraryRevision + 1;
      const updated = await tx.update(ownedPhotoEntries).set({
        deletedAt: now,
        purgeAfter: new Date(now.getTime() + RECOVERABLE_DELETE_MS),
        // A live entry cannot have an active GC claim, but clear defensively so
        // the lifecycle invariant is explicit in the durable update.
        gcClaimToken: null,
        gcClaimedAt: null,
      }).where(and(eq(ownedPhotoEntries.id, entry.id), isNull(ownedPhotoEntries.deletedAt))).returning({ id: ownedPhotoEntries.id });
      if (updated.length !== 1) throw new Error("Owned photo delete CAS failed while the entry row was locked");
      await this.#bumpLibraryRevision(tx, profile.id, profile.avatarLibraryRevision, nextLibraryRevision);
      const value: AgentPhotoEntryLifecycleResult = {
        operation: "delete",
        changed: true,
        entryId: entry.id,
        scope: scopeFor(input.authority, profile.avatarSelectionRevision, nextLibraryRevision),
      };
      await this.#recordSuccess(tx, "delete", input, fingerprint, value);
      return { kind: "success", value, publish: true };
    });
    return (await this.#finish(outcome)) as AgentPhotoEntryLifecycleResult;
  }

  /** Restore a recoverable entry without changing the current selection. */
  async restore(input: AgentPhotoRestoreInput): Promise<AgentPhotoEntryLifecycleResult> {
    this.#validateLifecycleInput(input);
    const fingerprint = this.#lifecycleFingerprint("restore", input);
    const outcome = await this.#dependencies.db.transaction(async (tx): Promise<TransactionOutcome> => {
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const replay = await this.#findReplay(tx, "restore", input, fingerprint);
      if (replay) return replay;

      const entry = await this.#lockOwnedEntry(tx, input.authority, input.entryId);
      if (!entry) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "photo_not_found", "The requested deleted Agent photo is unavailable",
        ));
      }
      const now = new Date();
      if (entry.deletedAt === null || entry.purgeAfter === null || entry.purgeAfter <= now) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "photo_deleted", "This Agent photo is no longer recoverable",
        ));
      }
      if (entry.gcClaimToken !== null || entry.gcClaimedAt !== null) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "photo_deleted", "This Agent photo is being collected and cannot be restored",
        ));
      }
      if (profile.avatarLibraryRevision >= MAX_TOKEN) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "photo_library_unavailable", "Agent photo revision capacity is exhausted",
        ));
      }
      if (!(await this.#dependencies.blobExists({
        entryId: entry.id,
        kind: entryAvatarKind(entry),
        blobId: entry.blobId,
        mediaMimeType: entry.mediaMimeType,
        mediaByteSize: entry.mediaByteSize,
        mediaSha256: entry.mediaSha256,
      }))) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "photo_blob_missing", "The deleted Agent photo bytes are no longer available",
        ));
      }
      const occupiedSlots = await this.#occupiedCreateSlots(tx, input.authority, now);
      if (occupiedSlots + 1 > ACTIVE_ENTRY_LIMIT) {
        return this.#recordFailure(tx, "restore", input, fingerprint, failure(
          "library_capacity_reached", "The Agent photo library is at capacity",
        ));
      }
      const nextLibraryRevision = profile.avatarLibraryRevision + 1;
      const restored = await tx.update(ownedPhotoEntries).set({
        deletedAt: null,
        purgeAfter: null,
        gcClaimToken: null,
        gcClaimedAt: null,
      }).where(and(
        eq(ownedPhotoEntries.id, entry.id),
        isNotNull(ownedPhotoEntries.deletedAt),
        gt(ownedPhotoEntries.purgeAfter, now),
        isNull(ownedPhotoEntries.gcClaimToken),
        isNull(ownedPhotoEntries.gcClaimedAt),
      )).returning({ id: ownedPhotoEntries.id });
      if (restored.length !== 1) throw new Error("Owned photo restore CAS failed while the entry row was locked");
      await this.#bumpLibraryRevision(tx, profile.id, profile.avatarLibraryRevision, nextLibraryRevision);
      const value: AgentPhotoEntryLifecycleResult = {
        operation: "restore",
        changed: true,
        entryId: entry.id,
        scope: scopeFor(input.authority, profile.avatarSelectionRevision, nextLibraryRevision),
      };
      await this.#recordSuccess(tx, "restore", input, fingerprint, value);
      return { kind: "success", value, publish: true };
    });
    return (await this.#finish(outcome)) as AgentPhotoEntryLifecycleResult;
  }

  async select(input: AgentPhotoSelectionInput): Promise<AgentPhotoSelectionResult> {
    const prepared = this.#prepareSelection(input);
    const outcome = await this.#dependencies.db.transaction((tx) =>
      this.#selectInTransaction(tx, input, prepared.expectedRevision, prepared.fingerprint));
    return (await this.#finish(outcome)) as AgentPhotoSelectionResult;
  }

  /**
   * Compose canonical selection into a caller-owned transaction. Failures
   * throw so the caller's wider mutation rolls back; publication is deferred
   * until that caller proves its outer transaction committed.
   */
  async selectInTransaction(
    tx: AgentPhotoLibraryTransaction,
    input: AgentPhotoSelectionInput,
  ): Promise<AgentPhotoSelectionTransactionResult> {
    const prepared = this.#prepareSelection(input);
    const outcome = await this.#selectInTransaction(
      tx,
      input,
      prepared.expectedRevision,
      prepared.fingerprint,
    );
    if (outcome.kind === "failure") throw new AgentPhotoLibraryError(outcome.error);
    return { value: outcome.value as AgentPhotoSelectionResult, publish: outcome.publish };
  }

  /** Call only after the transaction containing `selectInTransaction` commits. */
  async publishCommittedSelection(
    result: AgentPhotoSelectionTransactionResult,
  ): Promise<AgentPhotoSelectionResult> {
    return (await this.#finish({
      kind: "success",
      value: result.value,
      publish: result.publish,
    })) as AgentPhotoSelectionResult;
  }

  #prepareSelection(input: AgentPhotoSelectionInput): {
    expectedRevision: number;
    fingerprint: string;
  } {
    const expectedRevision = this.#validateCommonInput(input);
    if (input.target.kind === "entry") assertUuid(input.target.entryId, "Photo entry id");
    if (
      input.target.kind === "preset"
      && (input.target.presetId.length < 1 || input.target.presetId.length > 100)
    ) {
      throw new AgentPhotoLibraryError(failure(
        "invalid_photo_request",
        "Preset id must contain from 1 to 100 characters",
      ));
    }
    return { expectedRevision, fingerprint: requestFingerprint({
      fingerprintVersion: 1,
      authority: [
        input.authority.serverInstanceId,
        input.authority.viewerUserId,
        input.authority.ownerUserId,
        input.authority.agentId,
      ],
      expectedSelectionRevision: input.expectedSelectionRevision,
      operation: "select",
      origin: input.origin,
      target: canonicalTarget(input.target),
    }) };
  }

  async #selectInTransaction(
    tx: AgentPhotoLibraryTransaction,
    input: AgentPhotoSelectionInput,
    expectedRevision: number,
    fingerprint: string,
  ): Promise<TransactionOutcome> {
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const replay = await this.#findReplay(tx, "select", input, fingerprint);
      if (replay) return replay;

      const beforeEntry = await this.#resolveCurrentEntry(tx, input.authority, profile.avatarRef);

      if (profile.avatarSelectionRevision !== expectedRevision) {
        return this.#recordFailure(tx, "select", input, fingerprint, failure(
          "selection_conflict",
          "The Agent photo changed after this selection was opened",
          false,
          currentState(input.authority, profile, beforeEntry?.id ?? null),
        ));
      }
      if (profile.avatarSelectionRevision >= MAX_TOKEN || profile.avatarLibraryRevision >= MAX_TOKEN) {
        return this.#recordFailure(tx, "select", input, fingerprint, failure(
          "photo_library_unavailable",
          "Agent photo revision capacity is exhausted",
        ));
      }

      const target = await this.#resolveSelectionTarget(tx, input.authority, input.target);
      if (target.error) {
        return this.#recordFailure(tx, "select", input, fingerprint, target.error);
      }
      if (avatarRefEquals(profile.avatarRef, target.avatarRef)) {
        const value: AgentPhotoSelectionResult = {
          operation: "select",
          changed: false,
          currentAvatarRef: profile.avatarRef,
          currentEntryId: beforeEntry?.id ?? null,
          revisionId: null,
          scope: scopeFor(
            input.authority,
            profile.avatarSelectionRevision,
            profile.avatarLibraryRevision,
          ),
        };
        await this.#recordSuccess(tx, "select", input, fingerprint, value);
        return { kind: "success", value, publish: false };
      }

      const nextSelectionRevision = profile.avatarSelectionRevision + 1;
      const nextLibraryRevision = profile.avatarLibraryRevision + 1;
      const updated = await tx
        .update(profiles)
        .set({
          avatarRef: target.avatarRef,
          avatarSelectionRevision: nextSelectionRevision,
          avatarLibraryRevision: nextLibraryRevision,
          updatedAt: new Date(),
        })
        .where(and(
          eq(profiles.id, profile.id),
          eq(profiles.avatarSelectionRevision, expectedRevision),
        ))
        .returning({ id: profiles.id });
      if (updated.length !== 1) {
        throw new Error("Agent photo selection CAS failed while the profile row was locked");
      }
      const [revision] = await tx
        .insert(agentPhotoSelectionRevisions)
        .values({
          serverInstanceId: input.authority.serverInstanceId,
          ownerUserId: input.authority.ownerUserId,
          agentId: input.authority.agentId,
          revision: nextSelectionRevision,
          beforeAvatarRef: profile.avatarRef,
          afterAvatarRef: target.avatarRef,
          beforeEntryId: beforeEntry?.id ?? null,
          afterEntryId: target.entry?.id ?? null,
          actorUserId: input.authority.viewerUserId,
          origin: input.origin,
          operationId: input.operationId,
        })
        .returning({ id: agentPhotoSelectionRevisions.id });
      if (!revision) throw new Error("Agent photo selection revision was not created");

      const value: AgentPhotoSelectionResult = {
        operation: "select",
        changed: true,
        currentAvatarRef: target.avatarRef,
        currentEntryId: target.entry?.id ?? null,
        revisionId: revision.id,
        scope: scopeFor(input.authority, nextSelectionRevision, nextLibraryRevision),
      };
      await this.#recordSuccess(tx, "select", input, fingerprint, value);
      return { kind: "success", value, publish: true };
  }

  async undo(input: AgentPhotoUndoInput): Promise<AgentPhotoSelectionResult> {
    const expectedRevision = this.#validateCommonInput(input);
    assertUuid(input.revisionId, "Selection revision id");
    const fingerprint = requestFingerprint({
      fingerprintVersion: 1,
      authority: [
        input.authority.serverInstanceId,
        input.authority.viewerUserId,
        input.authority.ownerUserId,
        input.authority.agentId,
      ],
      expectedSelectionRevision: input.expectedSelectionRevision,
      operation: "undo",
      origin: input.origin,
      revisionId: input.revisionId,
    });

    const outcome = await this.#dependencies.db.transaction(async (tx): Promise<TransactionOutcome> => {
      const profile = await this.#lockAndValidateAuthority(tx, input.authority);
      const replay = await this.#findReplay(tx, "undo", input, fingerprint);
      if (replay) return replay;

      const currentEntry = await this.#resolveCurrentEntry(tx, input.authority, profile.avatarRef);

      if (profile.avatarSelectionRevision !== expectedRevision) {
        return this.#recordFailure(tx, "undo", input, fingerprint, failure(
          "undo_conflict",
          "A newer Agent photo selection has already committed",
          false,
          currentState(input.authority, profile, currentEntry?.id ?? null),
        ));
      }
      if (profile.avatarSelectionRevision >= MAX_TOKEN || profile.avatarLibraryRevision >= MAX_TOKEN) {
        return this.#recordFailure(tx, "undo", input, fingerprint, failure(
          "photo_library_unavailable",
          "Agent photo revision capacity is exhausted",
        ));
      }

      const [targetRevision] = await tx
        .select()
        .from(agentPhotoSelectionRevisions)
        .where(and(
          eq(agentPhotoSelectionRevisions.id, input.revisionId),
          eq(agentPhotoSelectionRevisions.serverInstanceId, input.authority.serverInstanceId),
          eq(agentPhotoSelectionRevisions.ownerUserId, input.authority.ownerUserId),
          eq(agentPhotoSelectionRevisions.agentId, input.authority.agentId),
        ))
        .limit(1)
        .for("update");
      if (!targetRevision) {
        return this.#recordFailure(tx, "undo", input, fingerprint, failure(
          "photo_not_found",
          "The requested Agent photo revision is unavailable",
        ));
      }
      if (targetRevision.revision !== profile.avatarSelectionRevision) {
        return this.#recordFailure(tx, "undo", input, fingerprint, failure(
          "undo_conflict",
          "That Agent photo revision is no longer current",
          false,
          currentState(input.authority, profile, currentEntry?.id ?? null),
        ));
      }
      if (!avatarRefEquals(profile.avatarRef, targetRevision.afterAvatarRef)) {
        throw new AgentPhotoLibraryError(failure(
          "photo_library_unavailable",
          "Current Agent photo does not match its selection revision",
          true,
        ));
      }
      const revisionCurrentEntryId = targetRevision.afterEntryId ?? null;
      if (revisionCurrentEntryId !== (currentEntry?.id ?? null)) {
        throw new AgentPhotoLibraryError(failure(
          "photo_library_unavailable",
          "Current Agent photo revision does not match its owned entry",
          true,
        ));
      }

      const restored = await this.#resolveRestoredRef(
        tx,
        input.authority,
        targetRevision.beforeAvatarRef,
        targetRevision.beforeEntryId,
      );
      if (restored.error) {
        return this.#recordFailure(tx, "undo", input, fingerprint, restored.error);
      }

      const nextSelectionRevision = profile.avatarSelectionRevision + 1;
      const nextLibraryRevision = profile.avatarLibraryRevision + 1;
      const updated = await tx
        .update(profiles)
        .set({
          avatarRef: targetRevision.beforeAvatarRef,
          avatarSelectionRevision: nextSelectionRevision,
          avatarLibraryRevision: nextLibraryRevision,
          updatedAt: new Date(),
        })
        .where(and(
          eq(profiles.id, profile.id),
          eq(profiles.avatarSelectionRevision, expectedRevision),
        ))
        .returning({ id: profiles.id });
      if (updated.length !== 1) {
        throw new Error("Agent photo undo CAS failed while the profile row was locked");
      }
      const [revision] = await tx
        .insert(agentPhotoSelectionRevisions)
        .values({
          serverInstanceId: input.authority.serverInstanceId,
          ownerUserId: input.authority.ownerUserId,
          agentId: input.authority.agentId,
          revision: nextSelectionRevision,
          beforeAvatarRef: profile.avatarRef,
          afterAvatarRef: targetRevision.beforeAvatarRef,
          beforeEntryId: currentEntry?.id ?? null,
          afterEntryId: restored.entry?.id ?? null,
          actorUserId: input.authority.viewerUserId,
          origin: input.origin,
          operationId: input.operationId,
        })
        .returning({ id: agentPhotoSelectionRevisions.id });
      if (!revision) throw new Error("Agent photo undo revision was not created");

      const value: AgentPhotoSelectionResult = {
        operation: "undo",
        changed: true,
        currentAvatarRef: targetRevision.beforeAvatarRef,
        currentEntryId: restored.entry?.id ?? null,
        revisionId: revision.id,
        scope: scopeFor(input.authority, nextSelectionRevision, nextLibraryRevision),
      };
      await this.#recordSuccess(tx, "undo", input, fingerprint, value);
      return { kind: "success", value, publish: true };
    });
    return (await this.#finish(outcome)) as AgentPhotoSelectionResult;
  }

  #validateCommonInput(input: AgentPhotoSelectionInput | AgentPhotoUndoInput): number {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.authority.serverInstanceId, "Server instance id");
    assertUuid(input.authority.viewerUserId, "Viewer user id");
    assertUuid(input.authority.ownerUserId, "Owner user id");
    assertUuid(input.authority.agentId, "Agent id");
    if (!selectionOrigins.has(input.origin)) {
      throw new AgentPhotoLibraryError(failure(
        "invalid_photo_request",
        "Agent photo selection origin is invalid",
      ));
    }
    return parseRevisionToken(input.expectedSelectionRevision);
  }

  #validateLifecycleInput(input: AgentPhotoEntryLifecycleInput): void {
    assertUuid(input.operationId, "Operation id");
    assertUuid(input.entryId, "Photo entry id");
    assertUuid(input.authority.serverInstanceId, "Server instance id");
    assertUuid(input.authority.viewerUserId, "Viewer user id");
    assertUuid(input.authority.ownerUserId, "Owner user id");
    assertUuid(input.authority.agentId, "Agent id");
    if (!selectionOrigins.has(input.origin)) {
      throw new AgentPhotoLibraryError(failure(
        "invalid_photo_request",
        "Agent photo lifecycle origin is invalid",
      ));
    }
  }

  #lifecycleFingerprint(kind: "delete" | "restore", input: AgentPhotoEntryLifecycleInput): string {
    return requestFingerprint({
      fingerprintVersion: 1,
      operation: kind,
      authority: [
        input.authority.serverInstanceId,
        input.authority.viewerUserId,
        input.authority.ownerUserId,
        input.authority.agentId,
      ],
      origin: input.origin,
      entryId: input.entryId,
    });
  }

  async #finish(outcome: TransactionOutcome): Promise<AgentPhotoMutationResult> {
    if (outcome.kind === "failure") throw new AgentPhotoLibraryError(outcome.error);
    if (outcome.publish && this.#dependencies.afterCommit) {
      try {
        await this.#dependencies.afterCommit(outcome.value);
      } catch (error) {
        // Publication is a post-commit projection. A delivery failure must not
        // turn an already-committed selection into a retryable mutation.
        logError("[agent-photo-library] post-commit publication failed", error);
        try {
          this.#dependencies.onAfterCommitError?.(error, outcome.value);
        } catch (observerError) {
          logError(
            "[agent-photo-library] post-commit error observer failed",
            observerError,
          );
        }
      }
    }
    return outcome.value;
  }

  async #finishCreate(result: AgentPhotoCreateResult): Promise<void> {
    if (!this.#dependencies.afterCreateCommit) return;
    try {
      await this.#dependencies.afterCreateCommit(result);
    } catch (error) {
      // Like selection publication, this is a post-commit projection: delivery
      // failure must not tell a caller to rerun the provider or write bytes.
      logError("[agent-photo-library] create post-commit publication failed", error);
      try {
        this.#dependencies.onAfterCommitError?.(error, result);
      } catch (observerError) {
        logError("[agent-photo-library] post-commit error observer failed", observerError);
      }
    }
  }

  async #lockAndValidateAuthority(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
  ) {
    return validateAgentPhotoLibraryAuthority(tx, authority, "mutation");
  }

  async #findReplay(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    kind: MutationKind,
    input: MutationInput,
    fingerprint: string,
  ): Promise<TransactionOutcome | null> {
    const [existing] = await tx
      .select({
        operationKind: photoLibraryOperations.operationKind,
        requestFingerprint: photoLibraryOperations.requestFingerprint,
        state: photoLibraryOperations.state,
        result: photoLibraryOperations.result,
      })
      .from(photoLibraryOperations)
      .where(and(
        eq(photoLibraryOperations.serverInstanceId, input.authority.serverInstanceId),
        eq(photoLibraryOperations.viewerUserId, input.authority.viewerUserId),
        eq(photoLibraryOperations.ownerUserId, input.authority.ownerUserId),
        eq(photoLibraryOperations.agentId, input.authority.agentId),
        eq(photoLibraryOperations.operationId, input.operationId),
      ))
      .limit(1);
    if (!existing) return null;
    if (existing.operationKind !== kind || existing.requestFingerprint !== fingerprint) {
      return {
        kind: "failure",
        error: failure(
          "idempotency_mismatch",
          "Operation id is already bound to a different photo request",
        ),
      };
    }
    if (existing.state === "pending") {
      throw new AgentPhotoLibraryError(failure(
        "operation_incomplete",
        "Photo operation receipt is incomplete",
        true,
      ));
    }
    const stored = parseStoredReceipt(existing.result);
    return stored.ok
      ? { kind: "success", value: stored.value, publish: false }
      : { kind: "failure", error: stored.error };
  }

  async #recordSuccess(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    kind: MutationKind,
    input: MutationInput,
    fingerprint: string,
    value: AgentPhotoMutationResult,
  ): Promise<void> {
    await tx.insert(photoLibraryOperations).values({
      serverInstanceId: input.authority.serverInstanceId,
      viewerUserId: input.authority.viewerUserId,
      ownerUserId: input.authority.ownerUserId,
      agentId: input.authority.agentId,
      operationId: input.operationId,
      operationKind: kind,
      requestFingerprint: fingerprint,
      state: "completed",
      result: storedSuccess(value),
      completedAt: new Date(),
    });
  }

  async #recordFailure(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    kind: MutationKind,
    input: MutationInput,
    fingerprint: string,
    error: StoredError,
  ): Promise<TransactionOutcome> {
    await tx.insert(photoLibraryOperations).values({
      serverInstanceId: input.authority.serverInstanceId,
      viewerUserId: input.authority.viewerUserId,
      ownerUserId: input.authority.ownerUserId,
      agentId: input.authority.agentId,
      operationId: input.operationId,
      operationKind: kind,
      requestFingerprint: fingerprint,
      state: "failed",
      result: storedFailure(error),
      completedAt: new Date(),
    });
    return { kind: "failure", error };
  }

  async #lockOwnedEntry(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    entryId: string,
  ): Promise<OwnedPhotoEntry | null> {
    const [entry] = await tx.select().from(ownedPhotoEntries).where(and(
      eq(ownedPhotoEntries.id, entryId),
      eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
      eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
      eq(ownedPhotoEntries.subjectKind, "agent"),
      eq(ownedPhotoEntries.agentId, authority.agentId),
    )).limit(1).for("update");
    return entry ?? null;
  }

  #entryIsCurrent(avatarRef: AvatarRef | null, entry: OwnedPhotoEntry): boolean {
    return currentCustomRef(avatarRef)
      && avatarRef.kind === entryAvatarKind(entry)
      && avatarRef.blobId === entry.blobId;
  }

  async #recoverableDeletedCount(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    now: Date,
  ): Promise<number> {
    const [result] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(ownedPhotoEntries)
      .where(and(
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
        isNotNull(ownedPhotoEntries.deletedAt),
        gt(ownedPhotoEntries.purgeAfter, now),
        isNull(ownedPhotoEntries.gcClaimToken),
        isNull(ownedPhotoEntries.gcClaimedAt),
      ));
    return Number(result?.count ?? 0);
  }

  /** Active entries plus live provider reservations, before restoring one. */
  async #occupiedCreateSlots(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    now: Date,
  ): Promise<number> {
    const [entryRows, reservationRows] = await Promise.all([
      tx.select({ count: sql<number>`count(*)::int` }).from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
        isNull(ownedPhotoEntries.deletedAt),
      )),
      tx.select({ count: sql<number>`coalesce(sum(${photoLibraryOperations.reservedSlots}), 0)::int` })
        .from(photoLibraryOperations)
        .where(and(
          eq(photoLibraryOperations.serverInstanceId, authority.serverInstanceId),
          eq(photoLibraryOperations.ownerUserId, authority.ownerUserId),
          eq(photoLibraryOperations.agentId, authority.agentId),
          eq(photoLibraryOperations.operationKind, "create"),
          eq(photoLibraryOperations.state, "pending"),
          gt(photoLibraryOperations.reservationExpiresAt, now),
        )),
    ]);
    return Number(entryRows[0]?.count ?? 0) + Number(reservationRows[0]?.count ?? 0);
  }

  async #bumpLibraryRevision(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    profileId: string,
    expectedLibraryRevision: number,
    nextLibraryRevision: number,
  ): Promise<void> {
    const updated = await tx.update(profiles).set({
      avatarLibraryRevision: nextLibraryRevision,
      updatedAt: new Date(),
    }).where(and(
      eq(profiles.id, profileId),
      eq(profiles.avatarLibraryRevision, expectedLibraryRevision),
    )).returning({ id: profiles.id });
    if (updated.length !== 1) throw new Error("Agent photo library revision CAS failed while the profile row was locked");
  }

  async #resolveCurrentEntry(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    avatarRef: AvatarRef | null,
  ): Promise<OwnedPhotoEntry | null> {
    if (!currentCustomRef(avatarRef)) return null;
    const [entry] = await tx
      .select()
      .from(ownedPhotoEntries)
      .where(and(
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
        eq(ownedPhotoEntries.avatarKind, avatarRef.kind),
        eq(ownedPhotoEntries.blobId, avatarRef.blobId),
      ))
      .limit(1)
      .for("update");
    if (!entry) {
      throw new AgentPhotoLibraryError(failure(
        "photo_not_found",
        "The current custom Agent photo has no owned library entry",
      ));
    }
    return entry;
  }

  async #resolveSelectionTarget(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    target: AgentPhotoSelectionTarget,
  ): Promise<{
    avatarRef: AvatarRef | null;
    entry: OwnedPhotoEntry | null;
    error?: StoredError;
  }> {
    if (target.kind === "clear") return { avatarRef: null, entry: null };
    if (target.kind === "preset") {
      if (!(await this.#dependencies.presetExists(target.presetId))) {
        return {
          avatarRef: null,
          entry: null,
          error: failure("photo_not_found", "The requested Agent photo is unavailable"),
        };
      }
      return { avatarRef: { kind: "preset", id: target.presetId }, entry: null };
    }
    const [entry] = await tx
      .select()
      .from(ownedPhotoEntries)
      .where(and(
        eq(ownedPhotoEntries.id, target.entryId),
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
      ))
      .limit(1)
      .for("update");
    if (!entry) {
      return {
        avatarRef: null,
        entry: null,
        error: failure("photo_not_found", "The requested Agent photo is unavailable"),
      };
    }
    const stateError = await this.#entryStateError(entry);
    if (stateError) return { avatarRef: null, entry: null, error: stateError };
    return {
      avatarRef: { kind: entryAvatarKind(entry), blobId: entry.blobId },
      entry,
    };
  }

  async #resolveRestoredRef(
    tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    authority: AgentPhotoLibraryAuthority,
    avatarRef: AvatarRef | null,
    expectedEntryId: string | null,
  ): Promise<{ entry: OwnedPhotoEntry | null; error?: StoredError }> {
    if (!currentCustomRef(avatarRef)) {
      if (expectedEntryId !== null) {
        throw new AgentPhotoLibraryError(failure(
          "photo_library_unavailable",
          "Preset or clear selection revision unexpectedly names an entry",
          true,
        ));
      }
      if (avatarRef?.kind === "preset" && !(await this.#dependencies.presetExists(avatarRef.id))) {
        return {
          entry: null,
          error: failure("photo_not_found", "The previous Agent photo is unavailable"),
        };
      }
      return { entry: null };
    }
    if (!expectedEntryId) {
      throw new AgentPhotoLibraryError(failure(
        "photo_library_unavailable",
        "Custom selection revision does not name its owned entry",
        true,
      ));
    }
    const [entry] = await tx
      .select()
      .from(ownedPhotoEntries)
      .where(and(
        eq(ownedPhotoEntries.id, expectedEntryId),
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
        eq(ownedPhotoEntries.avatarKind, avatarRef.kind),
        eq(ownedPhotoEntries.blobId, avatarRef.blobId),
      ))
      .limit(1)
      .for("update");
    if (!entry) {
      return {
        entry: null,
        error: failure("photo_not_found", "The previous Agent photo is unavailable"),
      };
    }
    const stateError = await this.#entryStateError(entry);
    return stateError ? { entry: null, error: stateError } : { entry };
  }

  async #entryStateError(entry: OwnedPhotoEntry): Promise<StoredError | null> {
    if (entry.deletedAt !== null || entry.gcClaimToken !== null || entry.gcClaimedAt !== null) {
      return failure("photo_deleted", "The requested Agent photo is deleted");
    }
    const present = await this.#dependencies.blobExists({
      entryId: entry.id,
      kind: entryAvatarKind(entry),
      blobId: entry.blobId,
      mediaMimeType: entry.mediaMimeType,
      mediaByteSize: entry.mediaByteSize,
      mediaSha256: entry.mediaSha256,
    });
    return present
      ? null
      : failure("photo_blob_missing", "The requested Agent photo bytes are missing");
  }
}
