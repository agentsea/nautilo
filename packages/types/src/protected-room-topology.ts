/** Product Room kinds supported by topology-neutral protected Message paths.
 * Subthreads resolve their top-level authority before using this classification.
 * This does not replace the exact-private legacy planner or authorize access Rooms.
 */
export const PROTECTED_TOP_LEVEL_ROOM_KINDS = ["private", "group", "open"] as const;

export function isProtectedTopLevelRoomKind(
  kind: string,
): kind is typeof PROTECTED_TOP_LEVEL_ROOM_KINDS[number] {
  return PROTECTED_TOP_LEVEL_ROOM_KINDS.some((supported) => supported === kind);
}
