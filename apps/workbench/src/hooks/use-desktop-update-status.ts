/**
 * D103 — renderer projection for the desktop updater.
 *
 * This deliberately treats the optional preload bridge as an enhancement.
 * Browser builds and already-installed older desktop versions stay hidden;
 * bridge failures never disturb the workbench. The only command is a
 * zero-argument request for main to open its native update UI.
 */

import { useCallback, useEffect, useState } from "react";
import { desktopAPI, type DesktopUpdateStatus } from "../lib/desktop";

const HIDDEN_UPDATE_STATUS: DesktopUpdateStatus = { kind: "hidden" };

export interface DesktopUpdateAffordance {
  status: DesktopUpdateStatus;
  open: () => void;
}

export function useDesktopUpdateStatus(): DesktopUpdateAffordance {
  const [status, setStatus] = useState<DesktopUpdateStatus>(HIDDEN_UPDATE_STATUS);

  useEffect(() => {
    const updates = desktopAPI?.updates;
    if (
      !updates ||
      typeof updates.getStatus !== "function" ||
      typeof updates.onStatus !== "function"
    ) {
      return;
    }

    let active = true;
    let receivedPush = false;
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = updates.onStatus((nextStatus) => {
        receivedPush = true;
        if (active) setStatus(nextStatus);
      });
    } catch {
      // An older or partial preload bridge must leave the indicator hidden.
      return;
    }

    try {
      void updates
        .getStatus()
        .then((initialStatus) => {
          // A pushed update is newer than an in-flight initial snapshot.
          if (active && !receivedPush) setStatus(initialStatus);
        })
        .catch(() => {
          // The update affordance is optional and failures are intentionally quiet.
        });
    } catch {
      // Defensive compatibility for an older/preload bridge that throws before
      // it can return its promised initial status.
    }

    return () => {
      active = false;
      try {
        unsubscribe?.();
      } catch {
        // Cleanup must not turn a stale/older bridge into a renderer error.
      }
    };
  }, []);

  const open = useCallback(() => {
    const openNativeUpdateUi = desktopAPI?.updates?.open;
    if (typeof openNativeUpdateUi !== "function") return;
    try {
      void Promise.resolve(openNativeUpdateUi()).catch(() => {
        // Main owns native error handling. Keep the workbench non-blocking.
      });
    } catch {
      // Feature detection also protects against an older/preload bridge throw.
    }
  }, []);

  return { status, open };
}
