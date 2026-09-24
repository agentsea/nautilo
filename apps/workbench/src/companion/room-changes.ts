import { createContext } from "react";
import type { ServerEvent } from "@nautilo/types";

/** Secondary Room views share the admitted runtime socket. History invalidation
 * remains metadata-only; live bodies must pass the runtime content owner first. */
export function createRoomChangeSource() {
  const listeners = new Set<(roomId: string) => void>();
  const roomViews = new Map<string, Set<(event: ServerEvent) => void>>();
  return {
    subscribeToRoom(roomId: string, listener: (event: ServerEvent) => void) {
      let views = roomViews.get(roomId);
      if (!views) roomViews.set(roomId, views = new Set());
      views.add(listener);
      return () => {
        views.delete(listener);
        if (!views.size && roomViews.get(roomId) === views) roomViews.delete(roomId);
      };
    },
    hasRoom(roomId: string | null) { return roomId !== null && roomViews.has(roomId); },
    /** Called only after the runtime's content admission boundary. */
    publishAdmittedEvent(roomId: string, event: ServerEvent) {
      for (const listener of roomViews.get(roomId) ?? []) listener(event);
    },
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
