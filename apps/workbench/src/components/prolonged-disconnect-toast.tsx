/**
 * Prolonged-disconnect toast (D057 2a.10 / D059 Phase 3.5.4).
 *
 * Progressive-disclosure escalation: the connection dot (§8.1) is always
 * visible; the footer offers recovery after 5s; THIS toast
 * fires after 30s with an actionable "Reload" button. Each level adds
 * urgency without blocking work on brief reconnect blips.
 *
 * State machine:
 *
 *   open ────────┐
 *     ▲          │ 30s still closed
 *     │          ▼
 *     │       show warning toast (duration: 0 — stays until reconnect)
 *     │ open  │
 *     └───────┤
 *             ▼
 *          dismiss warning; show brief success toast "Reconnected."
 *
 * Flap protection: a connection that oscillates open ↔ closed every
 * few seconds won't re-fire the warning toast on every cycle — the
 * 30s timer resets on reconnect but only re-arms when we go closed
 * again, and the "already shown" ref clears on open.
 *
 * Mounted once inside the workbench. No DOM of its own — renders null.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useToast } from "./toast";
import { useWsState } from "../hooks/use-ws-state";
import {
  getMaintenanceNoticeSnapshot,
  subscribeMaintenanceNotice,
} from "./maintenance-notice-state";

const PROLONGED_THRESHOLD_MS = 30_000;

export function ProlongedDisconnectToast() {
  const { state } = useWsState();
  const toast = useToast();
  const maintenance = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceNoticeSnapshot,
    getMaintenanceNoticeSnapshot,
  );

  // Track whether we've fired the warning for the CURRENT disconnect
  // episode. Prevents re-showing it on every state transition within
  // one long outage.
  const warningShownRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous state — so we only fire the success toast on a
  // disconnected → open transition, not on initial mount where state
  // is already "open".
  const prevStateRef = useRef<typeof state | null>(null);

  useEffect(() => {
    const prev = prevStateRef.current;

    // A planned replacement owns the connection story. Cancel its generic
    // escalation (and any warning it previously displayed) until the server
    // reports normal maintenance state again.
    if (maintenance.kind !== "normal") {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (warningShownRef.current) {
        toast.dismiss();
        warningShownRef.current = false;
      }
      prevStateRef.current = state;
      return;
    }

    // open → open at mount: no-op. Just record and bail.
    if (prev === null) {
      prevStateRef.current = state;
      return;
    }

    if (state === "open") {
      // Reconnected. Clear pending 30s timer + dismiss the prolonged
      // warning if it was visible + show a brief "Reconnected." toast.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (warningShownRef.current) {
        toast.dismiss();
        toast.show({
          variant: "success",
          message: "Reconnected.",
          duration: 2_000,
        });
        warningShownRef.current = false;
      }
    } else if (prev === "open") {
      // Fresh disconnect. Arm the 30s timer for the prolonged warning.
      // If we were ALREADY disconnected (prev === "closed" etc.), the
      // timer is already running or we've already shown.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (warningShownRef.current) return;
        // The timeout may run just after the maintenance store updates but
        // before React has run this effect to cancel it.
        if (getMaintenanceNoticeSnapshot().kind !== "normal") return;
        warningShownRef.current = true;
        toast.show({
          recovery: "connection",
          variant: "warning",
          title: "Connection issues",
          message: "Check your network or the server.",
          // Stay until dismiss / replaced. Disconnect isn't something
          // a timer should resolve; only a reconnect should.
          duration: 0,
          action: {
            label: "Reload",
            onClick: () => window.location.reload(),
          },
        });
      }, PROLONGED_THRESHOLD_MS);
    }

    prevStateRef.current = state;
  }, [maintenance.kind, state, toast]);

  // Cleanup on unmount so dev hot-reload doesn't leak the pending timer.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return null;
}
