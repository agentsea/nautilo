export type RoomVisibility = "private" | "external" | "public";

export type RoomVisibilityFields =
  | { kind: "private" }
  | { kind: "open"; discoverable: boolean };

export function canUseExternalRoomVisibility(
  viewerState: string,
  roomDiscoverability: boolean | undefined,
): boolean {
  return viewerState === "verified" && roomDiscoverability === true;
}

/** Map the human-facing choice onto the server's room access contract. */
export function roomVisibilityFields(
  visibility: RoomVisibility,
  externalSupported: boolean,
): RoomVisibilityFields | null {
  if (visibility === "private") return { kind: "private" };
  if (visibility === "external" && !externalSupported) return null;
  return { kind: "open", discoverable: visibility === "public" };
}
