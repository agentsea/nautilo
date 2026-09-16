import { isExactTaskId } from "./task-detail-state";

/** Origin is only a no-history destination hint; it never participates in Task authority. */
export function taskDetailBackTarget(originRoomId: string | null): "/(drawer)/(tabs)" | { pathname: "/chat/[roomId]"; params: { roomId: string } } {
  return isExactTaskId(originRoomId)
    ? { pathname: "/chat/[roomId]", params: { roomId: originRoomId } }
    : "/(drawer)/(tabs)";
}
