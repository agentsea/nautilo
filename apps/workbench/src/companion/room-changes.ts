import { createContext } from "react";

/** Metadata-only invalidation from the one admitted runtime socket. Consumers
 * reload through canonical Room operations; no message bodies cross this seam. */
export function createRoomChangeSource() {
  const listeners = new Set<(roomId: string) => void>();
  return {
    subscribe(listener: (roomId: string) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(roomId: string) { for (const listener of listeners) listener(roomId); },
  };
}
export const RoomChangeSourceContext = createContext<ReturnType<typeof createRoomChangeSource> | null>(null);

export const companionHistoryEvents = new Set([
  "message.new", "message.updated", "message.deleted", "message.shadow_durable",
  "message.human_peer_shadow", "message.shared_agent_shadow", "message.shared_agent_output_shadow", "job.status", "job.dispatched",
]);
