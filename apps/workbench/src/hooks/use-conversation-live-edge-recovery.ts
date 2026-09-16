import { useLayoutEffect, type RefObject } from "react";
import { isConversationViewportAtPhysicalLiveEdge } from "../components/conversation-viewport";

/** Reconcile stale away chrome even when the viewport store stays at `true`. */
export function useConversationLiveEdgeRecovery({
  viewportRef,
  readerAway,
  visitId,
  onAtBottomChange,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  readerAway: boolean;
  visitId: number;
  onAtBottomChange: (atBottom: boolean) => void;
}): void {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!readerAway || !viewport) return;
    let active = true;
    const reconcile = (): void => {
      // Restoring can set reader-away between the store's bottom observation
      // and its scheduled tail scroll. That scroll need not change the store
      // again. Geometry may clear away state, but must never invent it.
      if (active && viewportRef.current === viewport &&
        isConversationViewportAtPhysicalLiveEdge(viewport)) {
        onAtBottomChange(true);
      }
    };
    const observer = new ResizeObserver(reconcile);
    observer.observe(viewport);
    viewport.addEventListener("scroll", reconcile);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    reconcile();
    return () => {
      active = false;
      observer.disconnect();
      viewport.removeEventListener("scroll", reconcile);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [readerAway, onAtBottomChange, viewportRef, visitId]);
}
