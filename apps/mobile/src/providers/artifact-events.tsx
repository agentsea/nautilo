import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { getApiClient } from "@/lib/api";
import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";
import { serverIdFromUrl } from "@/lib/server-store";
import { appLifecycle } from "@/platform/app-lifecycle";
import {
  beginArtifactEventLifecycleRecovery,
  shouldCloseArtifactEventStreamForLifecycleRecovery,
  shouldRefreshArtifactEventToken,
  settleArtifactEventStart,
  startArtifactEventSubscription,
  type ArtifactEvent,
} from "@/providers/artifact-events-seam";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
type ArtifactEventHandler = (event: ArtifactEvent) => void;

type ArtifactEventsValue = { subscribe: (handler: ArtifactEventHandler) => () => void };
const ArtifactEventsContext = createContext<ArtifactEventsValue | null>(null);

/**
 * One authenticated SSE subscription for the active signed-in server. It is a
 * transport/fan-out seam only: screens still fetch canonical artifact state.
 */
export function ArtifactEventsProvider({ children }: { children: React.ReactNode }) {
  const { activeServer } = useServers();
  const { status } = useAuth();
  const handlersRef = useRef(new Set<ArtifactEventHandler>());
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let unsubscribe: (() => void) | undefined;
    const current = (): boolean => generationRef.current === generation;
    const dispatch = (event: ArtifactEvent): void => {
      if (!current()) return;
      for (const handler of handlersRef.current) {
        try { handler(event); } catch { /* isolated subscriber */ }
      }
    };
    if (!activeServer || status !== "signed-in") return () => { generationRef.current += 1; };

    const server = activeServer;
    const serverId = serverIdFromUrl(server.serverUrl);
    let refreshedAfterUnauthorized = false;
    let startInFlight = false;
    let lifecycleRecoveryUsed = false;
    let pendingUnauthorizedRebind = false;
    let pendingTransportClose = false;
    const start = (forceRefresh: boolean): void => {
      if (!current() || startInFlight || unsubscribe) return;
      startInFlight = true;
      void startArtifactEventSubscription({
        client: getApiClient(server.serverUrl),
        getToken: () => ensureValidToken(serverId, server.serverUrl, { forceRefresh }),
        isCurrent: current,
        onAuthDead: () => emitAuthDead(serverId),
        dispatch,
        onOpen: (reconnected) => {
          // A fresh-token rebind is also a convergence boundary even though it
          // is the first open of its replacement EventSource.
          if (forceRefresh && !reconnected) dispatch({ type: "reconnected" });
        },
        onError: ({ status: errorStatus }) => {
          // Its URL contains the token, so only an explicit 401 earns one
          // fresh-token replacement; unknown failures never force auth work.
          if (shouldRefreshArtifactEventToken(refreshedAfterUnauthorized, current(), errorStatus)) {
            refreshedAfterUnauthorized = true;
            if (startInFlight) {
              pendingUnauthorizedRebind = true;
              return;
            }
            unsubscribe?.();
            unsubscribe = undefined;
            start(true);
            return;
          }
          // RN-SSE does not restart an XHR `onerror` with status 0. The client
          // maps that to undefined; close it without auth work so the one
          // lifecycle recovery can create a fresh ordinary stream.
          if (shouldCloseArtifactEventStreamForLifecycleRecovery(errorStatus)) {
            if (startInFlight) {
              pendingTransportClose = true;
              return;
            }
            unsubscribe?.();
            unsubscribe = undefined;
          }
        },
      }).then((stop) => {
        startInFlight = false;
        if (!current()) { stop?.(); return; }
        const settled = settleArtifactEventStart(pendingUnauthorizedRebind, pendingTransportClose);
        pendingUnauthorizedRebind = false;
        pendingTransportClose = false;
        if (settled === "refresh-token") {
          stop?.();
          start(true);
          return;
        }
        if (settled === "wait-for-lifecycle") {
          stop?.();
          return;
        }
        unsubscribe = stop;
      });
    };
    start(false);
    // A startup transport failure has no polling retry. The next foreground
    // lifecycle transition earns one ordinary (non-forced) subscription
    // attempt for this active-server generation.
    const appStateSubscription = appLifecycle.addEventListener("change", (next) => {
      const recovery = beginArtifactEventLifecycleRecovery({
        nextAppState: next,
        alreadyUsed: lifecycleRecoveryUsed,
        startInFlight,
        hasSubscription: unsubscribe !== undefined,
        current: current(),
      });
      if (!recovery) return;
      lifecycleRecoveryUsed = true;
      // The status-0/startup gap may have lost lifecycle frames. Invalidate
      // once before the ordinary re-open; this does not refresh credentials.
      dispatch({ type: "reconnected" });
      start(recovery.forceRefresh);
    });
    return () => {
      generationRef.current += 1;
      appStateSubscription.remove();
      unsubscribe?.();
    };
  }, [activeServer, status]);

  const value = useMemo<ArtifactEventsValue>(() => ({
    subscribe: (handler) => {
      handlersRef.current.add(handler);
      return () => handlersRef.current.delete(handler);
    },
  }), []);
  return <ArtifactEventsContext.Provider value={value}>{children}</ArtifactEventsContext.Provider>;
}

export function useArtifactEvents(): ArtifactEventsValue {
  const value = useContext(ArtifactEventsContext);
  if (!value) throw new Error("useArtifactEvents must be used within ArtifactEventsProvider");
  return value;
}
