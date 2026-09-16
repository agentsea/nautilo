/** A message-like record with a canonical persisted identifier. */
export interface IdentifiedMessage {
  id?: unknown;
}

/**
 * Overlay live arrivals onto a history snapshot.  History is authoritative for
 * ids it contains; live-only ids retain their arrival order at the end.
 */
export function mergeHydratedRoomMessages<T extends IdentifiedMessage>(
  hydrated: readonly T[],
  liveArrivals: readonly T[],
): readonly T[] {
  const hydratedIds = new Set(hydrated.map((message) => String(message.id)));
  const appendedIds = new Set(hydratedIds);
  const liveOnly: T[] = [];
  for (const message of liveArrivals) {
    const id = String(message.id);
    if (appendedIds.has(id)) continue;
    appendedIds.add(id);
    liveOnly.push(message);
  }
  return liveOnly.length === 0 ? hydrated : [...hydrated, ...liveOnly];
}

export interface RoomHydrationRequest {
  roomId: string | null;
  generation: number;
  liveSequenceAtStart: number;
}

export interface RoomLiveArrival<T extends IdentifiedMessage> {
  roomId: string;
  sequence: number;
  message: T;
}

/** A superseded request must never replace the active Room's transcript. */
export function isLatestRoomHydration(
  request: RoomHydrationRequest,
  latest: RoomHydrationRequest | null,
): boolean {
  return latest !== null &&
    latest.roomId === request.roomId &&
    latest.generation === request.generation;
}

/** Returns only arrivals from this room made after this request began. */
export function liveArrivalsSince<T extends IdentifiedMessage>(
  request: RoomHydrationRequest,
  arrivals: readonly RoomLiveArrival<T>[],
): readonly T[] {
  if (!request.roomId) return [];
  return arrivals
    .filter((arrival) =>
      arrival.roomId === request.roomId && arrival.sequence > request.liveSequenceAtStart,
    )
    .map((arrival) => arrival.message);
}
