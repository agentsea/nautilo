import type { ServerEvent } from "@nautilo/types";

/** Reuse the private feed hint, not a content broadcast or a new durable event. */
export function createArtifactFeedInvalidator(deps: {
  recipients: (artifactId: string) => Promise<readonly string[]>;
  changed: (userId: string) => void;
}) {
  return async (event: ServerEvent): Promise<void> => {
    // Ordinary content saves already have their own Workspace invalidation and
    // cannot change cached feed labels or access. Only the canonical access
    // bridge marks a generic change as requiring feed re-authorization.
    if (event.type === "workspace.artifact.changed" && event.reloadRequired !== true) return;
    if (event.type !== "workspace.artifact.changed" && event.type !== "workspace.artifact.deleted"
      && event.type !== "workspace.artifact.renamed") return;
    try {
      for (const userId of await deps.recipients(event.id)) {
        try { deps.changed(userId); } catch { /* Other recipients still receive their hint. */ }
      }
    } catch { /* Existing reconciliation cadence recovers a lost hint. */ }
  };
}
