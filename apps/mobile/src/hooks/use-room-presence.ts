import { useEffect, useRef, useState } from "react";
import { createRoomPresencePoller } from "@nautilo/api-client/browser";
import type { HumanPresenceStatus, RoomPresenceResponse } from "@nautilo/types";

import { getApiClient } from "@/lib/api";
import { appLifecycle, type AppLifecycle } from "@/platform/app-lifecycle";

export function roomPresenceScope(serverUrl: string | undefined, roomId: string, viewerActorId: string | null): string {
  return JSON.stringify([serverUrl, roomId, viewerActorId]);
}

/** An absent/failed response is unavailable, never an Offline assertion. */
export function humanStatusInRoom(snapshot: RoomPresenceResponse | null, actorId: string): HumanPresenceStatus | undefined {
  return snapshot?.members.find((member) => member.actorId === actorId)?.status;
}

export function humanPresenceLabel(status: HumanPresenceStatus | undefined): string {
  return status === "online" ? "Online" : status === "idle" ? "Idle" : status === "offline" ? "Offline" : "Status unavailable";
}

export function observeRoomPresence(options: {
  visible: boolean;
  serverUrl: string | undefined;
  roomId: string;
  viewerActorId: string | null;
  onChange: (snapshot: RoomPresenceResponse | null) => void;
  lifecycle?: AppLifecycle;
  load?: (signal: AbortSignal) => Promise<RoomPresenceResponse>;
}): () => void {
  const lifecycle = options.lifecycle ?? appLifecycle;
  const poller = createRoomPresencePoller({
    load: options.load ?? ((signal) => getApiClient(options.serverUrl!).getRoomPresence(options.roomId, { signal })),
    onChange: options.onChange,
  });
  const setActive = (state: string) => poller.setActive(
    options.visible && Boolean(options.serverUrl) && Boolean(options.viewerActorId) && state === "active",
  );
  const subscription = lifecycle.addEventListener("change", setActive);
  setActive(lifecycle.currentState());
  return () => {
    subscription.remove();
    poller.dispose();
  };
}

export function useRoomPresence(options: {
  visible: boolean;
  serverUrl: string | undefined;
  roomId: string;
  viewerActorId: string | null;
}): RoomPresenceResponse | null {
  const scope = roomPresenceScope(options.serverUrl, options.roomId, options.viewerActorId);
  const activation = useRef({ scope, visible: options.visible, revision: 0 });
  if (activation.current.scope !== scope || activation.current.visible !== options.visible) {
    activation.current = { scope, visible: options.visible, revision: activation.current.revision + 1 };
  }
  const revision = activation.current.revision;
  const [value, setValue] = useState<{ revision: number; snapshot: RoomPresenceResponse | null } | null>(null);
  useEffect(() => observeRoomPresence({
    ...options,
    onChange: (snapshot) => setValue({ revision, snapshot }),
  }), [scope, options.visible]);
  return options.visible && value?.revision === revision ? value.snapshot : null;
}
