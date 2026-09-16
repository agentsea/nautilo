import type { RoomSummaryDto } from "@nautilo/types";

const GENERATED_PRIVATE_ROOM_LABEL = /^owner\s*·\s*genie$/i;

/**
 * Replace only the legacy generated one-to-one label with the actual
 * counterpart identity. Explicitly renamed rooms remain untouched.
 */
export function roomTabDisplayLabel(
  room: Pick<RoomSummaryDto, "label" | "type" | "memberCount" | "roster">,
  viewerActorId: string | null | undefined,
): string {
  if (
    room.type !== "private" ||
    room.memberCount !== 2 ||
    !GENERATED_PRIVATE_ROOM_LABEL.test(room.label)
  ) {
    return room.label;
  }
  const counterpart = room.roster?.find((member) => member.actorId !== viewerActorId);
  return counterpart?.displayName?.trim() || room.label;
}

/**
 * D106 - default label for POST /api/rooms from the New Chat (+) action.
 * Deterministic given `nowMs` so tests stay stable.
 */
export function defaultNewChatLabel(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `New chat ${y}-${m}-${day}`;
}

/**
 * Rooms shown as local tabs. Durable server Rooms stay in the Rooms panel until
 * opened, pinned, or active; the tab rail no longer treats every server Room as
 * open by default after legacy session promotion.
 */
export function selectRoomsForTabStrip<
  T extends {
    id: string;
    pinned: boolean;
    tabOpen: boolean;
    closedTab: boolean;
    tabOrder?: number | null;
    lastOpenedAt?: number | null;
  },
>(rooms: readonly T[], activeRoomId?: string | null): T[] {
  const activeRoom =
    activeRoomId !== undefined && activeRoomId !== null && activeRoomId.length > 0
      ? rooms.find((r) => r.id === activeRoomId)
      : undefined;
  const open = rooms.filter(
    (r) => r.id === activeRoomId || (!r.closedTab && (r.pinned || r.tabOpen)),
  );

  if (activeRoom && !open.some((r) => r.id === activeRoom.id)) {
    open.push(activeRoom);
  }

  return [...open].sort((a, b) => {
    const ao = a.tabOrder;
    const bo = b.tabOrder;
    if (typeof ao === "number" && typeof bo === "number" && ao !== bo) return ao - bo;
    if (typeof ao === "number" && typeof bo !== "number") return -1;
    if (typeof ao !== "number" && typeof bo === "number") return 1;

    const la = a.lastOpenedAt ?? 0;
    const lb = b.lastOpenedAt ?? 0;
    if (la !== lb) return lb - la;
    return 0;
  });
}

export function moveRoomIdBeforeTarget(
  orderedRoomIds: readonly string[],
  draggedRoomId: string,
  targetRoomId: string,
): string[] {
  if (draggedRoomId === targetRoomId) return [...orderedRoomIds];
  const withoutDragged = orderedRoomIds.filter((id) => id !== draggedRoomId);
  const targetIdx = withoutDragged.indexOf(targetRoomId);
  if (targetIdx < 0) return [...orderedRoomIds];
  return [
    ...withoutDragged.slice(0, targetIdx),
    draggedRoomId,
    ...withoutDragged.slice(targetIdx),
  ];
}

/**
 * Visible tab order includes `closingId`. Returns an adjacent tab id, or null if none.
 */
export function pickNeighborTabId(
  orderedVisibleTabs: readonly { id: string }[],
  closingId: string,
): string | null {
  const idx = orderedVisibleTabs.findIndex((t) => t.id === closingId);
  if (idx < 0) {
    return orderedVisibleTabs[0]?.id ?? null;
  }
  return orderedVisibleTabs[idx + 1]?.id ?? orderedVisibleTabs[idx - 1]?.id ?? null;
}
