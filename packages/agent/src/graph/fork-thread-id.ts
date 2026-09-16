/**
 * M085 — fork checkpoint threads use `${parentGraphThreadId}:fork:${turnId}[:suffix]`.
 * Room membership and transcript rows stay keyed by the parent (canonical room graph thread).
 */
export function parentGraphThreadIdFromForkCheckpoint(threadId: string): string {
  const marker = ":fork:";
  const i = threadId.indexOf(marker);
  if (i === -1) return threadId;
  return threadId.slice(0, i);
}

/**
 * M137 follow-up — resolve the **canonical room graph thread** (`room:<id>`)
 * from any room-scoped thread/lane id, tolerating the Conductor's per-user /
 * per-bot suffixes AND `:fork:` checkpoints:
 *   `room:<id>`                                   → `room:<id>`
 *   `room:<id>:bot:<agentId>`                     → `room:<id>`
 *   `room:<id>:user:<actor>:bot:<agentId>`        → `room:<id>`
 *   `room:<id>:fork:<turnId>[:bot:<agentId>]`     → `room:<id>`
 *
 * Membership / authorization checks key on the room (stored
 * `rooms.graph_thread_id = room:<id>`), so a multi-agent bot-laned thread
 * must collapse to this before the lookup — otherwise the exact-match
 * `findRoomIdByGraphThreadIdForUser` returns null and the resume route 403s
 * (every approval/prove-it reply in a multi-agent room). Non-room threads
 * (e.g. `app:default`) fall back to fork-stripping unchanged.
 */
export function roomGraphThreadFromLaneThread(threadId: string): string {
  const m = /^room:([0-9a-f-]{36})(?::|$)/i.exec(threadId);
  if (m) return `room:${m[1]}`;
  return parentGraphThreadIdFromForkCheckpoint(threadId);
}
