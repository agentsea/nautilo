/**
 * M088B — Artifact-aware workspace store for the `file` tool.
 *
 * Translates between the agent-facing logical artifact path and the
 * server-side DB-indexed `artifacts` row + physical storage location.
 *
 * Bytes live at `<artifactsRoot>/<artifactId>` where `artifactsRoot`
 * is the server-owned root (`getArtifactsRoot()`, default
 * `~/.nautilo/artifacts/`, override with `NAUTILO_ARTIFACTS_ROOT`).
 * Decoupled from any client-supplied workspace path: a Droplet
 * deployment mounts a persistent volume at the configured root and the
 * client's local filesystem layout is irrelevant.
 *
 * Logical paths are an entirely separate column on the `artifacts`
 * table — renames, moves, and shares update the row (or its
 * `artifact_namespaces` junction), not the disk layout.
 *
 * A file on disk without a matching DB row is invisible to the
 * `workspace` zone. The Phase 6 migrator relocates pre-M088B byte
 * locations + ingests legacy flat `~/Documents/Nautilo/` files; until
 * it runs, anything created before M088B is unreachable via the `file`
 * tool.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  agentDb,
  attachArtifactToNamespace,
  bumpArtifactRevision,
  findArtifactByPathForNamespaces,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  insertArtifact,
  listArtifactsForNamespaces,
  type Artifact,
} from "@nautilo/db";
import { withAgentTrustContext } from "../../store/trust-agent-db";
import { getArtifactsRoot } from "@nautilo/config";
import { warn } from "@nautilo/logger";
import type {
  AnchoredTextPatch,
  DocumentPatchAuthor,
  DocumentPatchEvent,
  WorkspaceArtifactChangedEvent,
  WorkspaceArtifactDeletedEvent,
  WorkspaceArtifactRenamedEvent,
} from "@nautilo/types";
import type { AnchoredEdit } from "./staged-patches";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  assertCanWriteArtifacts,
  envelopeMutableNamespaces,
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";

const STORAGE_URI_PREFIX = "file://";

export type WorkspaceArtifactBusEvent =
  | WorkspaceArtifactChangedEvent
  | WorkspaceArtifactRenamedEvent
  | WorkspaceArtifactDeletedEvent
  | DocumentPatchEvent;

export type WorkspaceArtifactRowApplyResult = {
  internalId: string;
  artifactId: string;
  path: string;
  revision: number | null;
  previousRevision: number | null;
};

export type WorkspaceArtifactCreationActor =
  | { kind: "human"; userId: string }
  | { kind: "agent"; agentId: string };

/** Reference-only facts for one newly committed Workspace Artifact. */
export type WorkspaceArtifactCreatedFact = {
  artifactInternalId: string;
  namespaceId: string;
  actor: WorkspaceArtifactCreationActor;
  occurrenceKey: string;
};

export type WorkspaceArtifactCreatedSink = (
  fact: WorkspaceArtifactCreatedFact,
) => void | Promise<void>;

function anchoredEditToPatch(edit: AnchoredEdit): AnchoredTextPatch {
  return {
    kind: "anchored_text",
    oldString: edit.oldString,
    newString: edit.newString,
    ...(edit.replaceAll !== undefined ? { replaceAll: edit.replaceAll } : {}),
    ...(edit.scope ? { scope: edit.scope } : {}),
  };
}

/**
 * Emit `document.patch.applied` for a successful workspace-artifact text
 * content write that used an anchored edit. No-op when `anchoredPatch` is
 * absent (binary / structural / full-rewrite fallbacks stay invalidation-only).
 */
export function emitWorkspaceArtifactDocumentPatchApplied(input: {
  rowInternalId: string;
  logicalPath: string;
  mimeType?: string | undefined;
  roomId?: string | undefined;
  previousRevision: number | null;
  previousSha256: string;
  newRevision: number | null;
  newSha256: string;
  patchId: string;
  anchoredPatch: AnchoredTextPatch;
  unifiedDiff: string;
  clientMutationId?: string | undefined;
  author: DocumentPatchAuthor;
  rebased: boolean;
  requestId?: string | undefined;
}): void {
  void input.unifiedDiff;
  const event: DocumentPatchEvent = {
    type: "document.patch.applied",
    target: {
      kind: "artifact",
      artifactInternalId: input.rowInternalId,
      path: input.logicalPath,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    },
    patchId: input.patchId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    revision: input.newRevision,
    sha256: input.newSha256,
    previousRevision: input.previousRevision,
    previousSha256: input.previousSha256,
    patch: input.anchoredPatch,
    author: input.author,
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    rebased: input.rebased,
  };
  emitWorkspaceArtifactEvent(event);
}

export function emitWorkspaceArtifactDocumentPatchFromAnchoredEdit(input: {
  rowInternalId: string;
  logicalPath: string;
  mimeType?: string | undefined;
  roomId?: string | undefined;
  previousRevision: number | null;
  previousSha256: string;
  newRevision: number | null;
  newSha256: string;
  patchId: string;
  anchoredEdit: AnchoredEdit;
  unifiedDiff: string;
  clientMutationId?: string | undefined;
  author: DocumentPatchAuthor;
  rebased: boolean;
  requestId?: string | undefined;
}): void {
  emitWorkspaceArtifactDocumentPatchApplied({
    ...input,
    anchoredPatch: anchoredEditToPatch(input.anchoredEdit),
  });
}

let workspaceArtifactEventSink: ((event: WorkspaceArtifactBusEvent) => void) | null = null;
let workspaceArtifactCreatedSink: WorkspaceArtifactCreatedSink | null = null;

export function setWorkspaceArtifactEventSink(
  sink: ((event: WorkspaceArtifactBusEvent) => void) | null,
): void {
  workspaceArtifactEventSink = sink;
}

export function setWorkspaceArtifactCreatedSink(
  sink: WorkspaceArtifactCreatedSink | null,
): void {
  workspaceArtifactCreatedSink = sink;
}

/**
 * Notify the server-owned creation adapter without coupling Artifact business
 * success to feed availability. This is also the shared seam used by other
 * canonical post-commit creation producers.
 */
export async function emitWorkspaceArtifactCreatedFact(
  fact: WorkspaceArtifactCreatedFact,
): Promise<void> {
  try {
    await workspaceArtifactCreatedSink?.(fact);
  } catch {
    try {
      warn("[artifact-store] artifact creation observer failed after commit");
    } catch {
      // Diagnostics are best effort too; the Artifact is already committed.
    }
  }
}

function emitWorkspaceArtifactEvent(event: WorkspaceArtifactBusEvent): void {
  workspaceArtifactEventSink?.(event);
}

/**
 * Metadata stamped onto a staged patch when the patch targets a
 * workspace artifact. The retained importer/editor compatibility path uses
 * this only to create an `artifacts` row (+ `artifact_namespaces` row) or
 * bump the revision of an existing row. Canonical D448 structural mutations
 * do not pass through this facade.
 *
 * Lives at `metadata.workspaceArtifact` on `StagedPatch.metadata` to
 * coexist with existing per-command metadata. Absent on every patch
 * outside the workspace artifact path (current/absolute zones).
 */
export interface WorkspaceArtifactPatchMeta {
  mode: "create" | "update";
  /** External string id (the `artifact_id` column) — stable across renames. */
  artifactId: string;
  /** Logical path BEFORE this op (for create: same as logical path after). */
  logicalPath: string;
  /** Target Namespace for create's junction insert or an existing update. */
  namespaceId: string;
  /** Physical storage location — `file://...`. Used to derive the disk path. */
  storageUri: string;
  /** Primary-key UUID of the existing row (absent on create). */
  rowId?: string;
  /** Best-effort mime type recorded at stage time. */
  mimeType?: string;
  /** Optional client-issued id used by editors to identify their own saves. */
  clientMutationId?: string;
  /** When true, emit `reloadRequired` on the legacy changed invalidation event. */
  reloadRequired?: boolean;
  /** D448 restore-time optimistic row guard, captured from the existing
   * Namespace-authorized artifact resolver. Undefined for legacy mutation
   * callers, which retain their established behavior. */
  expectedRevision?: number;
}

export type ArtifactResolution =
  | {
      ok: true;
      /** Existing row, or null when the logical path didn't resolve. */
      artifact: Artifact | null;
      /** Absolute filesystem path for bytes — derived from row or freshly minted. */
      physicalPath: string;
      /** Stable external id — either the row's or a freshly-minted UUID. */
      artifactId: string;
      /** `file://...` form of physicalPath. */
      storageUri: string;
      /** Validated logical path the agent supplied. */
      logicalPath: string;
    }
  | { ok: false; reason: string };

/**
 * Validate a logical artifact path — what the agent sees / supplies as
 * `args.path` on a `zone: "workspace"` call.
 *
 * Logical paths are slash-separated, relative, non-empty, free of `..`
 * segments and control chars. They are NOT filesystem paths — they're
 * just metadata. We still apply filesystem-like hygiene so the UI can
 * render them as a tree and so they can survive a future migration to
 * an object-store-backed surface.
 */
export function validateLogicalPath(rawPath: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "path is required" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawPath)) {
    return { ok: false, reason: "path contains control characters" };
  }
  if (path.isAbsolute(rawPath)) {
    return {
      ok: false,
      reason: `workspace artifact paths must be relative (got absolute ${rawPath.slice(0, 80)}); use zone="absolute" for filesystem paths`,
    };
  }
  const segments = rawPath.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { ok: false, reason: "path must contain at least one non-empty segment" };
  }
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "path may not contain '..' segments" };
  }
  if (segments.every((s) => s === ".")) {
    return { ok: false, reason: "path must contain at least one non-empty segment" };
  }
  return { ok: true, path: segments.join("/") };
}

function physicalPathForArtifactId(artifactId: string): string {
  return path.join(getArtifactsRoot(), artifactId);
}

function storageUriFromPhysicalPath(absolute: string): string {
  return `${STORAGE_URI_PREFIX}${absolute}`;
}

export function physicalPathFromStorageUri(storageUri: string): string | null {
  if (!storageUri.startsWith(STORAGE_URI_PREFIX)) return null;
  const rest = storageUri.slice(STORAGE_URI_PREFIX.length);
  if (!path.isAbsolute(rest)) return null;
  return rest;
}

export interface EnvelopeFacts {
  userId: string;
  /**
   * M127: `agentId` is preserved on the envelope facts for
   * `withAgentTrustContext` routing only. It is no longer a row-level
   * filter on `artifacts` (namespace membership is the sole content
   * boundary).
   */
  agentId: string;
  readableNamespaces: string[];
  mutableNamespaces: string[];
  writableNamespaces: string[];
}

/**
 * Pull the artifact-relevant fields out of a `MemoryAccessEnvelope`,
 * with an explicit not-supported error for scope-mode envelopes
 * (M088B reserves scope schema but does not implement scope behavior).
 */
export function envelopeFactsForArtifacts(
  envelope: MemoryAccessEnvelope | null | undefined,
): { ok: true; facts: EnvelopeFacts } | { ok: false; reason: string } {
  if (!envelope) {
    return {
      ok: false,
      reason:
        "Workspace artifact access requires an authenticated room/namespace context. " +
        "This call has no envelope — likely a guest path or an unconfigured test fixture.",
    };
  }
  if (isScopeMemoryEnvelope(envelope)) {
    return {
      ok: false,
      reason:
        "Artifact scope mode is not implemented yet; use namespace context or wait for M088 Phase 4.",
    };
  }
  const ownerId = envelope.ownerId;
  if (!ownerId || ownerId.length === 0) {
    return {
      ok: false,
      reason:
        "Workspace artifact access requires an authenticated speaker user id (envelope.ownerId).",
    };
  }
  return {
    ok: true,
    facts: {
      userId: ownerId,
      agentId: envelope.agentId,
      readableNamespaces: envelopeReadableNamespaces(envelope),
      mutableNamespaces: envelopeMutableNamespaces(envelope),
      writableNamespaces: envelopeWritableNamespaces(envelope),
    },
  };
}

/**
 * Look up the artifact for a write/edit/delete target by logical path.
 * Returns a resolution object: existing row + physical path when found,
 * or a fresh artifactId + physical path when the path is new and the
 * caller intends to create.
 *
 * `intent` controls behavior:
 *   - "read"   — must find an existing row in `readableNamespaces`.
 *   - "mutate" — must find an existing row in `mutableNamespaces`.
 *   - "create" — must NOT find an existing row; mints a new id/uri.
 *                Caller is expected to validate `writableNamespaces[0]`
 *                separately before calling.
 *   - "create_or_update" — finds row in `mutableNamespaces` if present,
 *                otherwise mints fresh id/uri suitable for create.
 *
 * Physical paths are minted via `getArtifactsRoot()` — no `workspaceRoot`
 * param. The server owns where bytes land.
 */
export async function resolveWorkspaceArtifact(params: {
  logicalPath: string;
  facts: EnvelopeFacts;
  intent: "read" | "mutate" | "create" | "create_or_update";
}): Promise<ArtifactResolution> {
  const { logicalPath, facts, intent } = params;

  // Choose the namespace set for the lookup based on intent. Reads
  // use the wider readable set; mutations + create + create_or_update
  // use the strict mutable set for existence checks.
  const lookupNamespaces =
    intent === "read" ? facts.readableNamespaces : facts.mutableNamespaces;

  const existing = await withAgentTrustContext(
    { userId: facts.userId, agentId: facts.agentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      return findArtifactByPathForNamespaces(
        {
          path: logicalPath,
          readableNamespaceIds: lookupNamespaces,
        },
        conn,
      );
    },
  );

  if (existing) {
    if (intent === "create") {
      return {
        ok: false,
        reason: `An artifact already exists at workspace path "${logicalPath}". Use update intent or pick a different path.`,
      };
    }
    const physical = physicalPathFromStorageUri(existing.storageUri);
    if (!physical) {
      return {
        ok: false,
        reason: `Artifact ${existing.artifactId} has unrecognized storage_uri scheme; M088B only handles file:// URIs.`,
      };
    }
    if (intent !== "read") {
      await assertCanWriteArtifacts({
        humanUserId: facts.userId,
        artifactId: existing.id,
      });
    }
    return {
      ok: true,
      artifact: existing,
      physicalPath: physical,
      artifactId: existing.artifactId,
      storageUri: existing.storageUri,
      logicalPath,
    };
  }

  if (intent === "read" || intent === "mutate") {
    return {
      ok: false,
      reason: `No workspace artifact found at "${logicalPath}" within your accessible namespaces.`,
    };
  }

  const namespaceId = facts.writableNamespaces[0];
  if (namespaceId === undefined) {
    return {
      ok: false,
      reason:
        "no writable namespace for new workspace artifacts. Open a room with namespace write access before creating one.",
    };
  }
  await assertCanWriteArtifacts({
    humanUserId: facts.userId,
    namespaceId,
  });

  // create or create_or_update — mint fresh identifiers under the
  // server-owned artifact root.
  const artifactId = crypto.randomUUID();
  const physicalPath = physicalPathForArtifactId(artifactId);
  return {
    ok: true,
    artifact: null,
    physicalPath,
    artifactId,
    storageUri: storageUriFromPhysicalPath(physicalPath),
    logicalPath,
  };
}

/**
 * D448 — re-resolve a history row's artifact identity through the same
 * Namespace/trust context as normal Workspace mutation. Unlike the normal
 * logical-path resolver, this permits a soft-deleted row solely so its own
 * authorized history can restore it. It is not a discovery API.
 */
export async function resolveWorkspaceArtifactForRestore(params: {
  artifactInternalId: string;
  facts: EnvelopeFacts;
}): Promise<ArtifactResolution> {
  const existing = await withAgentTrustContext(
    { userId: params.facts.userId, agentId: params.facts.agentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      return findArtifactByInternalIdForNamespacesIncludingDeleted(
        {
          internalId: params.artifactInternalId,
          mutableNamespaceIds: params.facts.mutableNamespaces,
        },
        conn,
      );
    },
  );
  if (!existing) {
    return { ok: false, reason: "Workspace history target is no longer mutable in this Namespace context." };
  }
  const physicalPath = physicalPathFromStorageUri(existing.storageUri);
  if (!physicalPath) {
    return { ok: false, reason: `Artifact ${existing.artifactId} has unrecognized storage_uri scheme; Workspace restore requires file:// storage.` };
  }
  await assertCanWriteArtifacts({
    humanUserId: params.facts.userId,
    artifactId: existing.id,
  });
  return {
    ok: true,
    artifact: existing,
    physicalPath,
    artifactId: existing.artifactId,
    storageUri: existing.storageUri,
    logicalPath: existing.path,
  };
}

/**
 * Enumerate artifacts visible in the envelope's readable Namespace set
 * for the current agent. Used by `list` and `grep` on workspace zone.
 */
export async function listWorkspaceArtifacts(
  facts: EnvelopeFacts,
  options?: { pathPrefix?: string; limit?: number },
): Promise<Artifact[]> {
  return withAgentTrustContext(
    { userId: facts.userId, agentId: facts.agentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      return listArtifactsForNamespaces(
        {
          readableNamespaceIds: facts.readableNamespaces,
          ...(options?.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
          ...(options?.limit ? { limit: options.limit } : {}),
        },
        conn,
      );
    },
  );
}

/**
 * Apply the row-level side-effect of a successful `apply_patch` on a
 * workspace-artifact stage. Called by `apply-patch.ts` AFTER the
 * filesystem operation has succeeded. `create` mode also writes the
 * `artifact_namespaces` junction row pinning the new artifact to the
 * envelope's `writableNamespaces[0]` (carried on `meta.namespaceId`).
 */
export async function applyWorkspaceArtifactRowChange(
  meta: WorkspaceArtifactPatchMeta,
  computedSize: number,
  userId: string,
  /**
   * M127: `agentId` is no longer carried on `WorkspaceArtifactPatchMeta`
   * (row-level Memory/Artifact scope is namespace-only). It is still
   * required here for `withAgentTrustContext` so RLS GUCs are set
   * correctly during the artifacts INSERT + junction attach.
   */
  agentId: string,
  /** Explicit null suppresses user-visible creation for internal producers. */
  actor: WorkspaceArtifactCreationActor | null,
): Promise<WorkspaceArtifactRowApplyResult | null> {
  const committed = await withAgentTrustContext({ userId, agentId }, async (tx) => {
    const conn = tx as unknown as typeof agentDb;

    switch (meta.mode) {
      case "create": {
        // M033 Phase 6 — client-generated UUID (no INSERT...RETURNING).
        // Under the narrow `nautilo_agent` role, RETURNING re-runs the
        // SELECT policy on the freshly-inserted row, which requires an
        // `artifact_namespaces` junction we haven't created yet. Same
        // pattern as `memory-store.saveMemory`.
        // D448 may allocate a UUID before byte reconciliation so the linked
        // history row can identify a create. It is still an ordinary opaque
        // row id; Namespace attachment below remains the authority check.
        const internalId = meta.rowId ?? crypto.randomUUID();
        const created = await insertArtifact(
          {
            internalId,
            artifactId: meta.artifactId,
            path: meta.logicalPath,
            storageUri: meta.storageUri,
            size: computedSize,
            ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
          },
          conn,
        );
        await attachArtifactToNamespace(
          {
            artifactId: created.id,
            namespaceId: meta.namespaceId,
          },
          conn,
        );
        const event: WorkspaceArtifactChangedEvent = {
          type: "workspace.artifact.changed",
          id: created.id,
          artifactId: created.artifactId,
          path: created.path,
          ...(meta.reloadRequired ? { reloadRequired: true } : {}),
        };
        return {
          event,
          createdFact: actor
            ? ({
                artifactInternalId: created.id,
                namespaceId: meta.namespaceId,
                actor,
                occurrenceKey: `artifact.added:create:${created.id}`,
              } satisfies WorkspaceArtifactCreatedFact)
            : null,
          result: {
            internalId: created.id,
            artifactId: created.artifactId,
            path: created.path,
            revision: created.revision,
            previousRevision: null,
          },
        };
      }
      case "update": {
        if (!meta.rowId) {
          throw new Error(
            `[artifact-store] update mode requires rowId; got undefined for artifactId=${meta.artifactId}`,
          );
        }
        const updated = await bumpArtifactRevision(
          {
            id: meta.rowId,
            size: computedSize,
            ...(meta.mimeType !== undefined && meta.mimeType.length > 0
              ? { mimeType: meta.mimeType }
              : {}),
          },
          conn,
        );
        if (updated) {
          const event: WorkspaceArtifactChangedEvent = {
            type: "workspace.artifact.changed",
            id: updated.id,
            artifactId: updated.artifactId,
            path: updated.path,
            ...(meta.clientMutationId ? { clientMutationId: meta.clientMutationId } : {}),
            ...(meta.reloadRequired ? { reloadRequired: true } : {}),
          };
          return {
            event,
            createdFact: null,
            result: {
              internalId: updated.id,
              artifactId: updated.artifactId,
              path: updated.path,
              revision: updated.revision,
              previousRevision: updated.revision === null ? null : updated.revision - 1,
            },
          };
        }
        return { event: null, createdFact: null, result: null };
      }
    }
  });

  // `withAgentTrustContext` resolves only after its transaction commits.
  // Consumers authorize and invalidate through separate DB connections, so
  // publishing from inside the callback can make a newly inserted artifact
  // invisible to both SSE delivery and list-generation invalidation.
  if (committed.createdFact) {
    await emitWorkspaceArtifactCreatedFact(committed.createdFact);
  }
  if (committed.event) {
    emitWorkspaceArtifactEvent(committed.event);
  }
  return committed.result;
}
