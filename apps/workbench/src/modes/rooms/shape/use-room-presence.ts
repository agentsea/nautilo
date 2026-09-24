import { useEffect, useState } from "react";
import { createRoomPresencePoller } from "@nautilo/api-client/browser";
import type { HumanPresenceStatus } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { addAuthTransitionListener } from "../../../lib/auth-transition";

const EMPTY: ReadonlyMap<string, HumanPresenceStatus> = new Map();

export function useRoomPresence(
  roomId: string,
  viewerActorId: string,
  enabled = true,
): ReadonlyMap<string, HumanPresenceStatus> {
  // Workbench API is same-origin; switching servers replaces the whole renderer.
  const server = typeof window === "undefined" ? "" : window.location.origin;
  const key = JSON.stringify([server, viewerActorId, roomId]);
  const [state, setState] = useState<{ key: string; statuses: ReadonlyMap<string, HumanPresenceStatus> }>();
  useEffect(() => {
    if (!enabled || !viewerActorId) {
      setState(undefined);
      return;
    }
    const poller = createRoomPresencePoller({
      load: (signal) => apiClient.getRoomPresence(roomId, { signal }),
      onChange: (snapshot) => setState({
        key,
        statuses: snapshot ? new Map(snapshot.members.map((m) => [m.actorId, m.status])) : EMPTY,
      }),
    });
    let signedOut = false;
    const onVisibility = () => poller.setActive(!signedOut && document.visibilityState !== "hidden");
    const stopAuthListener = addAuthTransitionListener((detail) => {
      if (detail.reason === "credential-refreshed") return;
      signedOut = detail.reason === "signed-out";
      // Fence even a sign-out/sign-in of the same actor before props can converge.
      poller.setActive(false);
      onVisibility();
    });
    const onMembership = (event: Event) => {
      if ((event as CustomEvent<{ roomId?: string }>).detail?.roomId === roomId) poller.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("nautilo:room-members-changed", onMembership);
    onVisibility();
    return () => {
      poller.dispose();
      stopAuthListener();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("nautilo:room-members-changed", onMembership);
    };
  }, [enabled, key, roomId, viewerActorId]);
  return enabled && state?.key === key ? state.statuses : EMPTY;
}
