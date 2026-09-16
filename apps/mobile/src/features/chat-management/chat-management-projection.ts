import type { RoomDetailResponse } from "@nautilo/types";

export type RoomProjectionChange =
  | { kind: "renamed"; room: RoomDetailResponse }
  | { kind: "archived"; roomId: string; archived: boolean }
  | { kind: "left"; roomId: string };

export type RoomProjectionScope = {
  serverId: string;
  viewerActorId: string;
};

type ScopedListener = {
  scope: RoomProjectionScope;
  listener: (change: RoomProjectionChange) => void;
};

const listeners = new Set<ScopedListener>();

function sameScope(left: RoomProjectionScope, right: RoomProjectionScope): boolean {
  return left.serverId === right.serverId && left.viewerActorId === right.viewerActorId;
}

/** Exact-identity in-process fanout for independently mounted Mobile surfaces. */
export function publishRoomProjection(
  scope: RoomProjectionScope,
  change: RoomProjectionChange,
): void {
  for (const subscriber of listeners) {
    if (sameScope(subscriber.scope, scope)) subscriber.listener(change);
  }
}

export function subscribeRoomProjection(
  scope: RoomProjectionScope,
  listener: (change: RoomProjectionChange) => void,
): () => void {
  const subscriber = { scope, listener };
  listeners.add(subscriber);
  return () => listeners.delete(subscriber);
}
