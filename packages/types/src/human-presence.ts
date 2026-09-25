/** Human availability on the serving instance, derived from authenticated chat sockets. */
export type HumanPresenceStatus = "online" | "idle" | "offline";

export interface RoomPresenceResponse {
  members: Array<{ actorId: string; status: HumanPresenceStatus }>;
}
