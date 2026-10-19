import { useCallback, useEffect, useRef } from "react";
import { RECONNECT_RECONCILED_EVENT } from "./reconnect-toast";

/** One read at a time; hints during a read discard it and coalesce into a fresh read. */
export function useBolterStateReload(
  read: (current: () => boolean) => Promise<void>,
  capture: () => () => boolean,
) {
  const latest = useRef({ read, capture });
  latest.current = { read, capture };
  const revision = useRef(0);
  const pending = useRef(false);
  const active = useRef(true);
  const running = useRef<Promise<void> | null>(null);
  const reload = useCallback((): Promise<void> => {
    revision.current += 1;
    pending.current = true;
    if (running.current) return running.current;
    const work = (async () => {
      while (active.current && pending.current) {
        pending.current = false;
        const expectedRevision = revision.current;
        const scopeCurrent = latest.current.capture();
        await latest.current.read(() => active.current && expectedRevision === revision.current && scopeCurrent());
      }
    })();
    running.current = work;
    void work.finally(() => { if (running.current === work) running.current = null; });
    return work;
  }, []);
  useEffect(() => {
    active.current = true;
    const invalidate = () => { void reload(); };
    window.addEventListener("nautilo:bolter-state-changed", invalidate);
    window.addEventListener(RECONNECT_RECONCILED_EVENT, invalidate);
    return () => {
      active.current = false;
      pending.current = false;
      revision.current += 1;
      window.removeEventListener("nautilo:bolter-state-changed", invalidate);
      window.removeEventListener(RECONNECT_RECONCILED_EVENT, invalidate);
    };
  }, [reload]);
  return reload;
}
