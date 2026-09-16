/**
 * WebSocket connection state hook (D059 Phase 3.1 / D057 2a.10).
 *
 * Exposes the transport state (`"connecting" | "open" | "closed"`) plus
 * a derived `"disconnected-long"` (closed for > 5 seconds) so UI can
 * avoid showing "disconnected" flashes for sub-second reconnects.
 *
 * Backed by WsStateContext from NautiloRuntimeProvider. Consumers:
 *   - Footer connection segment
 *   - Disconnect banner
 *   - Composer gated-send
 *   - Prolonged-disconnect toast
 *
 * Why derived here and not in the provider: the 5-second threshold is a
 * UX concern, not a transport one. The provider stays a faithful mirror
 * of the transport; the UX layer adds the temporal smoothing.
 */

import { useEffect, useRef, useState } from "react";
import { useWsStateContext, type WsTransportState } from "../adapters/runtime-contexts";

export type WsStateFull = WsTransportState | "disconnected-long";

/** Threshold for promoting "closed" → "disconnected-long" (ms). Internal
 *  — the disconnect banner + prolonged-disconnect toast use their own
 *  hardcoded thresholds (5_000 / 30_000) from the vocabulary spec so
 *  they stay readable at call-site. */
const DISCONNECT_LONG_MS = 5_000;

export interface UseWsStateResult {
  /** Derived state including "disconnected-long" after DISCONNECT_LONG_MS. */
  state: WsStateFull;
  /** Milliseconds since we last saw "open". 0 while currently open. */
  disconnectedDuration: number;
}

/**
 * Subscribe to WS state. Re-renders on state changes AND every ~500ms
 * while disconnected (to animate the disconnectedDuration counter and
 * trigger the "disconnected-long" promotion at 5s).
 */
export function useWsState(): UseWsStateResult {
  const { state, lastOpenAt } = useWsStateContext();
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const firstNotOpenAtRef = useRef<number | null>(state === "open" ? null : Date.now());

  // While not-open, tick every 500ms so the UI sees disconnectedDuration
  // advance and the 5s / 30s thresholds fire predictably. No interval
  // while open so we don't churn renders for no reason.
  useEffect(() => {
    if (state === "open") {
      firstNotOpenAtRef.current = null;
      return;
    }
    if (firstNotOpenAtRef.current === null) {
      firstNotOpenAtRef.current = Date.now();
    }
    const id = setInterval(() => setTickNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state]);

  if (state === "open") {
    return { state: "open", disconnectedDuration: 0 };
  }

  // If we've connected before, measure from the last successful open.
  // If we have NEVER connected (server down at app launch), measure
  // from the first observed not-open state. The previous behavior
  // returned 0 forever when lastOpenAt was null, which meant a cold
  // launch with the server down only showed the red dot — no banner,
  // no prolonged toast.
  const disconnectedSince = lastOpenAt ?? firstNotOpenAtRef.current ?? tickNow;
  const disconnectedDuration = Math.max(0, tickNow - disconnectedSince);
  if (state === "closed" && disconnectedDuration > DISCONNECT_LONG_MS) {
    return { state: "disconnected-long", disconnectedDuration };
  }
  return { state, disconnectedDuration };
}
