import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import type { ActiveRoomResolution } from "../rooms/room-navigation-types";

export function resolveComposerMessageAttachmentRoomId(input: {
  viewer: {
    readonly sessionUserId: string | null;
    readonly sessionActorId: string | null;
  };
  activeResolution: ActiveRoomResolution;
  directHumanInteractionBlocked: boolean;
}): string | null {
  if (
    input.directHumanInteractionBlocked ||
    !isAuthenticatedHumanViewer(input.viewer) ||
    input.activeResolution.kind !== "selected"
  ) {
    return null;
  }

  return input.activeResolution.roomId;
}
