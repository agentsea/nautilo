/**
 * Reconnect-reconciled toast (ISSUE-D145 §F).
 *
 * Effect-only component. Listens for the `nautilo:reconnect-reconciled`
 * window event that NautiloRuntimeProvider dispatches AFTER a
 * post-reconnect rehydrate has resolved successfully — never on the
 * raw WS open transition itself, because a premature toast lies (the
 * server might be up but we haven't reconciled yet).
 *
 * Lives in this layer because `useToast()` is only available below
 * `<ToastProvider>`, which mounts INSIDE NautiloRuntimeProvider. The
 * runtime can't call useToast directly; it dispatches the event and
 * this component translates it into a toast.
 *
 * Distinct from `ProlongedDisconnectToast`'s success branch: that one
 * only fires after the 30s "Connection issues" warning has shown.
 * This one fires on every real reconnect, including short outages.
 * No flap protection beyond "rehydrate must succeed" because the
 * reconcile won't complete during a flap; the user only sees the
 * toast when work has actually been recovered.
 */

import { useEffect } from "react";
import { useToast } from "./toast";
import { hasPendingServerUpgradeNotice } from "./server-upgrade-notice";
import { getMaintenanceNoticeSnapshot } from "./maintenance-notice-state";

export const RECONNECT_RECONCILED_EVENT = "nautilo:reconnect-reconciled";

export function ReconnectToast() {
  const toast = useToast();
  useEffect(() => {
    const handler = (): void => {
      if (getMaintenanceNoticeSnapshot().kind !== "normal") return;
      if (hasPendingServerUpgradeNotice()) return;
      toast.show({
        variant: "success",
        title: "Reconnected",
        message: "Caught up.",
        duration: 2_000,
      });
    };
    window.addEventListener(RECONNECT_RECONCILED_EVENT, handler);
    return () => window.removeEventListener(RECONNECT_RECONCILED_EVENT, handler);
  }, [toast]);
  return null;
}
