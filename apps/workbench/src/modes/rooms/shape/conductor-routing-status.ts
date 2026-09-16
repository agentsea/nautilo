import { useEffect, useRef, useState } from "react";

/** D299 — transient Conductor routing lifecycle for room chrome. */
export type ConductorRoutingDetail = {
  roomId: string;
  userActorId: string;
  state: "deciding" | "settled";
};

const CONDUCTOR_ROUTING_SAFETY_MS = 10_000;

/** Pure reducer for unit tests — whether the viewer should see "Routing…". */
export function routingDecidingAfterEvent(
  current: boolean,
  detail: ConductorRoutingDetail,
  roomId: string | null,
  viewerActorId: string | null,
): boolean {
  if (!roomId || !viewerActorId) return false;
  if (detail.roomId !== roomId || detail.userActorId !== viewerActorId) return current;
  return detail.state === "deciding";
}

/**
 * Tracks `conductor.routing` deciding state for the active room + viewer.
 * Clears on `settled` or a safety timeout so a missed settled event cannot
 * stick forever.
 */
export function useConductorRoutingDeciding(
  roomId: string | null,
  viewerActorId: string | null,
): boolean {
  const [deciding, setDeciding] = useState(false);
  const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSafety = (): void => {
    if (safetyRef.current != null) {
      clearTimeout(safetyRef.current);
      safetyRef.current = null;
    }
  };

  useEffect(() => {
    setDeciding(false);
    clearSafety();
  }, [roomId, viewerActorId]);

  useEffect(() => {
    const onRouting = (ev: Event): void => {
      const detail = (ev as CustomEvent<ConductorRoutingDetail>).detail;
      if (!detail) return;
      setDeciding((prev) => {
        const next = routingDecidingAfterEvent(prev, detail, roomId, viewerActorId);
        if (next) {
          clearSafety();
          safetyRef.current = setTimeout(() => setDeciding(false), CONDUCTOR_ROUTING_SAFETY_MS);
        } else if (detail.state === "settled") {
          clearSafety();
        }
        return next;
      });
    };
    window.addEventListener("nautilo:conductor-routing", onRouting);
    return () => {
      window.removeEventListener("nautilo:conductor-routing", onRouting);
      clearSafety();
    };
  }, [roomId, viewerActorId]);

  return deciding;
}
