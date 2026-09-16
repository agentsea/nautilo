import type { ActiveRoomResolution, WorkbenchRoomSummary } from "./room-navigation-types";

export interface ResolveActiveRoomInput {
  routeRoomId: string | undefined;
  storedRoomId: string | undefined;
  rooms: WorkbenchRoomSummary[];
  /** Restricted viewers must never remain on a suppressed personal-Agent URL. */
  fallbackWhenRouteMissing?: boolean;
}

/**
 * Canonical active-room derivation: route wins when present and valid; otherwise
 * last-active when still in the server list; otherwise first merged room.
 */
export function resolveActiveRoom(input: ResolveActiveRoomInput): ActiveRoomResolution {
  const { routeRoomId, storedRoomId, rooms, fallbackWhenRouteMissing = false } = input;
  const byId = new Map(rooms.map((r) => [r.id, r] as const));

  if (routeRoomId !== undefined && routeRoomId.length > 0) {
    if (byId.has(routeRoomId)) {
      return { kind: "selected", roomId: routeRoomId };
    }
    if (!fallbackWhenRouteMissing) {
      return { kind: "missing", roomId: routeRoomId };
    }
  }

  if (storedRoomId && byId.has(storedRoomId)) {
    return { kind: "selected", roomId: storedRoomId };
  }

  if (rooms.length > 0) {
    return { kind: "selected", roomId: rooms[0].id };
  }

  return { kind: "none" };
}
