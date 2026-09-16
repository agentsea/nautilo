/**
 * M259 — narrow consumption predicate for Room and Workspace Artifact UI.
 * A Role slug is not authentication. Both canonical Human and Actor ids must
 * be present; this deliberately does not change legacy `isVerified` semantics
 * for admin, device, tool, profile, or host surfaces.
 */
export function isAuthenticatedHumanViewer(viewer: {
  readonly sessionUserId: string | null;
  readonly sessionActorId: string | null;
}): boolean {
  return Boolean(viewer.sessionUserId && viewer.sessionActorId);
}
