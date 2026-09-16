import type { WorkspaceArtifactEvent } from "@nautilo/api-client/browser";
import type { AnchoredTextPatch, WorkspaceDocumentVersion } from "@nautilo/types";

/**
 * The editor only needs this narrow, committed subset.  It intentionally does
 * not recreate the legacy `document.patch.applied` envelope: the operation id
 * is the durable event identity and the before/after versions are the source
 * of truth.
 */
export type WorkspaceEditorSavePatchEvent = {
  /** The durable operation id is the patch identity for legacy editor state. */
  readonly patchId: string;
  readonly revision: number | null;
  readonly sha256: string;
  readonly previousRevision: number | null;
  readonly previousSha256: string;
  readonly patch: AnchoredTextPatch;
  readonly clientMutationId?: string;
  readonly rebased: boolean;
};

export function localFileCommittedMutationPath(event: WorkspaceArtifactEvent): string | null {
  if (event.type !== "document.mutation.committed") return null;
  const version = event.mutation === "delete" ? event.before : event.after;
  return version.identity.kind === "local_file" ? version.identity.canonicalPath : null;
}

export function localFileEditorSavePatchEvent(
  event: WorkspaceArtifactEvent,
): WorkspaceEditorSavePatchEvent | null {
  if (
    event.type !== "document.mutation.committed" ||
    event.mutation !== "update" ||
    event.before.identity.kind !== "local_file" ||
    event.after.identity.kind !== "local_file" ||
    !event.editorSave?.anchoredPatch
  ) return null;
  return {
    patchId: event.operationId,
    revision: null,
    sha256: event.after.sha256,
    previousRevision: null,
    previousSha256: event.before.sha256,
    patch: event.editorSave.anchoredPatch,
    ...(event.editorSave.clientMutationId ? { clientMutationId: event.editorSave.clientMutationId } : {}),
    rebased: event.outcome === "rebased",
  };
}

function workspaceVersionForEvent(
  event: WorkspaceArtifactEvent,
): WorkspaceDocumentVersion | null {
  if (event.type !== "document.mutation.committed") return null;
  const version = event.mutation === "delete" ? event.before : event.after;
  return version.identity.kind === "workspace_artifact"
    ? (version as WorkspaceDocumentVersion)
    : null;
}

export function workspaceArtifactEventId(event: WorkspaceArtifactEvent): string | null {
  if (event.type === "document.patch.applied") {
    return event.target.kind === "artifact" ? event.target.artifactInternalId : null;
  }
  if (event.type === "document.mutation.committed") {
    return workspaceVersionForEvent(event)?.identity.artifactId ?? null;
  }
  return event.id;
}

export function workspaceArtifactEventPath(event: WorkspaceArtifactEvent): string | null {
  if (event.type === "changed") return event.path;
  if (event.type === "document.patch.applied") {
    return event.target.kind === "artifact" ? event.target.path : null;
  }
  if (event.type === "document.mutation.committed") {
    return workspaceVersionForEvent(event)?.identity.logicalPath ?? null;
  }
  return null;
}

export function workspaceArtifactEventClientMutationId(
  event: WorkspaceArtifactEvent,
): string | undefined {
  if (event.type === "changed" || event.type === "document.patch.applied") {
    return event.clientMutationId;
  }
  return event.type === "document.mutation.committed"
    ? event.mutation === "update"
      ? event.editorSave?.clientMutationId
      : undefined
    : undefined;
}

export function isWorkspaceArtifactCommittedMutation(
  event: WorkspaceArtifactEvent,
): event is Extract<WorkspaceArtifactEvent, { type: "document.mutation.committed" }> {
  return event.type === "document.mutation.committed" && workspaceVersionForEvent(event) !== null;
}

/**
 * Convert only the durable editor-save delta into the narrow patch fields an
 * editor needs. Snapshot saves and other committed mutations deliberately
 * return null so callers take their safe full-resync path.
 */
export function workspaceEditorSavePatchEvent(
  event: WorkspaceArtifactEvent,
): WorkspaceEditorSavePatchEvent | null {
  if (
    event.type !== "document.mutation.committed" ||
    event.mutation !== "update" ||
    event.before.identity.kind !== "workspace_artifact" ||
    event.after.identity.kind !== "workspace_artifact" ||
    event.before.backendVersion.kind !== "artifact_revision" ||
    event.after.backendVersion.kind !== "artifact_revision" ||
    event.editorSave?.anchoredPatch === undefined
  ) {
    return null;
  }

  return {
    patchId: event.operationId,
    revision: event.after.backendVersion.revision,
    sha256: event.after.sha256,
    previousRevision: event.before.backendVersion.revision,
    previousSha256: event.before.sha256,
    patch: event.editorSave.anchoredPatch,
    ...(event.editorSave.clientMutationId
      ? { clientMutationId: event.editorSave.clientMutationId }
      : {}),
    rebased: event.outcome === "rebased",
  };
}
