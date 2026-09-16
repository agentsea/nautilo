import type { ServerEvent } from "@nautilo/types";

/** Events that can change which Rooms appear in the viewer's catalogue. */
export function shouldRefreshRoomCatalogueForEvent(event: ServerEvent): boolean {
  return event.type === "room.catalog.changed" || event.type === "room_members_changed";
}

/** A recovery revision represents a transport gap or stale first-open repair. */
export function shouldRefreshRoomCatalogueOnRecovery(
  previous: number,
  current: number,
): boolean {
  return current > previous;
}
