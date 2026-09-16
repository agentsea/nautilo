/**
 * M134 Phase 0 — per-(room, bot) LangGraph `thread_id`.
 *
 * In multi-agent group rooms each bot must keep independent checkpoint
 * state, so we partition the room's single `graph_thread_id` into one
 * id per bot. DMs (exactly 1 human + 1 agent) keep using the room-level
 * `rooms.graph_thread_id` and never call this helper.
 *
 * `agentId` is the `agents.id` of the bot (the agent, not the actor).
 */
export function botThreadId(roomId: string, agentId: string): string {
  return `room:${roomId}:bot:${agentId}`;
}
