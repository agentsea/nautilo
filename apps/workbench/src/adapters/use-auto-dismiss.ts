import { useEffect, useRef } from "react";

/**
 * D323 — re-arming auto-dismiss timer.
 *
 * When `rearmKey` is truthy, schedules `onExpire()` after `ttlMs`. The timer
 * re-arms whenever `rearmKey` changes (so a new snapshot/turn resets the
 * countdown) and is always cleared on change/unmount, so a stale timer can
 * never fire against a newer value. `onExpire` is held in a ref, so passing
 * a fresh inline callback each render does NOT churn the timer.
 *
 * Single-caller seam (used only by `NautiloRuntimeProvider` for the fallback
 * status pill) — extracted from the inline effect purely so the timer
 * behavior is unit-testable without rendering the full runtime provider.
 */
export function useAutoDismiss(
  rearmKey: unknown,
  onExpire: () => void,
  ttlMs: number,
): void {
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!rearmKey) return;
    const timer = setTimeout(() => onExpireRef.current(), ttlMs);
    return () => clearTimeout(timer);
  }, [rearmKey, ttlMs]);
}
