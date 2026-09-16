import type {
  RoomNotificationChangedEvent,
  RoomSummaryDto,
} from "@nautilo/types";

export type ApplyNotificationUnreadResult =
  | { kind: "unchanged"; rooms: RoomSummaryDto[] }
  | { kind: "patched"; rooms: RoomSummaryDto[] }
  | { kind: "unknown-positive"; rooms: RoomSummaryDto[] };

/**
 * Project the canonical viewer-scoped notification event onto Mobile's
 * existing top-level chat-list unread dot. Subthread events do not own a
 * separate row in this surface.
 */
export function applyNotificationUnread(
  rooms: RoomSummaryDto[],
  event: RoomNotificationChangedEvent,
): ApplyNotificationUnreadResult {
  if (event.roomId !== event.topLevelRoomId) {
    return { kind: "unchanged", rooms };
  }

  const index = rooms.findIndex((room) => room.id === event.topLevelRoomId);
  if (index < 0) {
    return event.roomOwnUnreadCount > 0
      ? { kind: "unknown-positive", rooms }
      : { kind: "unchanged", rooms };
  }

  const room = rooms[index];
  if (room.unreadCount === event.roomOwnUnreadCount) {
    return { kind: "unchanged", rooms };
  }

  const next = [...rooms];
  next[index] = { ...room, unreadCount: event.roomOwnUnreadCount };
  return { kind: "patched", rooms: next };
}
