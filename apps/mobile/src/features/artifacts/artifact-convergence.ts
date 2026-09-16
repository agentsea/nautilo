import type { WorkspaceArtifactEvent } from "@nautilo/api-client/browser";

export type ArtifactConvergenceEvent = WorkspaceArtifactEvent | { type: "reconnected" };
export type ViewerConvergenceAction = "none" | "reconcile" | "reload";

export function shouldRefreshFocusedArtifactList(event: ArtifactConvergenceEvent): boolean {
  return event.type === "reconnected" || event.type === "changed" || event.type === "renamed" || event.type === "deleted";
}

/** Fail closed during a local mutation: its durable completion/recovery owns the next canonical read. */
export function viewerConvergenceAction(
  event: ArtifactConvergenceEvent,
  artifactId: string | undefined,
  mutationBusy: boolean,
): ViewerConvergenceAction {
  if (!artifactId || mutationBusy) return "none";
  if (event.type === "reconnected") return "reload";
  if (event.type !== "changed" && event.type !== "renamed" && event.type !== "deleted") return "none";
  if (event.id !== artifactId) return "none";
  return event.type === "deleted" ? "reconcile" : "reload";
}

export function shouldExitAfterArtifactConvergence(kind: string): boolean {
  return kind === "auth_dead" || kind === "forbidden" || kind === "not_found";
}

/** A same-session focus return must re-read canonical state after an editor route closes. */
export function shouldPassivelyRefreshArtifactViewerOnFocus(
  previousSessionKey: string | undefined,
  currentSessionKey: string,
): boolean {
  return previousSessionKey === currentSessionKey;
}

/** Background convergence preserves a mounted viewer across transient transport failure. */
export function shouldInstallBackgroundArtifactResult(kind: string): boolean {
  return kind === "text" || kind === "file" || kind === "video" || kind === "unsupported" || kind === "too_large" || shouldExitAfterArtifactConvergence(kind);
}

/**
 * Passive lifecycle refresh keeps a mounted artifact through transient
 * failure. Explicit reconciliation also keeps it during the request, but its
 * completion must replace the UI with the canonical failure/success truth.
 */
export function shouldInstallArtifactConvergenceResult(
  mode: "passive" | "reconcile" | undefined,
  hasMountedResult: boolean,
  kind: string,
): boolean {
  return !hasMountedResult || mode !== "passive" || shouldInstallBackgroundArtifactResult(kind);
}
