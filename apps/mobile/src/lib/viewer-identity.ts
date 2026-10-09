import type { WhoamiResponse } from "@nautilo/types";

import type { CachedViewer } from "./viewer-cache";

export function viewerFromWhoami(whoami: WhoamiResponse): CachedViewer | null {
  if (!whoami.sessionUserId || !whoami.sessionActorId) return null;
  const displayName = whoami.displayName?.trim() || whoami.handle?.trim();
  return {
    userId: whoami.sessionUserId,
    actorId: whoami.sessionActorId,
    ...(whoami.handle?.trim() ? { handle: whoami.handle.trim() } : {}),
    ...(displayName ? { displayName } : {}),
    capabilities: whoami.capabilities,
    ...(whoami.features?.roomDiscoverability === true
      ? { roomDiscoverability: true }
      : {}),
  };
}
