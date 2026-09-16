import type { RoomSummaryDto } from "@nautilo/types";
import type { RoomNavStoredPayload } from "./room-navigation-storage";
import type { WorkbenchRoomSummary } from "./room-navigation-types";

export function mergeRoomSummariesWithMetadata(
  serverRooms: RoomSummaryDto[],
  stored: RoomNavStoredPayload,
): WorkbenchRoomSummary[] {
  return serverRooms.map((r) => {
    const meta = stored.rooms[r.id] ?? {};
    return {
      ...r,
      pinned: meta.pinned === true,
      tabOpen: meta.tabOpen === true && meta.closedTab !== true,
      closedTab: meta.closedTab === true,
      lastOpenedAt:
        typeof meta.lastOpenedAt === "number" && Number.isFinite(meta.lastOpenedAt)
          ? meta.lastOpenedAt
          : null,
      tabOrder:
        typeof meta.tabOrder === "number" && Number.isFinite(meta.tabOrder)
          ? meta.tabOrder
          : null,
    };
  });
}

function createdAtMs(room: WorkbenchRoomSummary): number {
  const t = Date.parse(room.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pinned first, then most recently opened locally, then server createdAt desc.
 */
export function sortWorkbenchRooms(rooms: WorkbenchRoomSummary[]): WorkbenchRoomSummary[] {
  return [...rooms].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const la = a.lastOpenedAt ?? 0;
    const lb = b.lastOpenedAt ?? 0;
    if (la !== lb) return lb - la;
    return createdAtMs(b) - createdAtMs(a);
  });
}
