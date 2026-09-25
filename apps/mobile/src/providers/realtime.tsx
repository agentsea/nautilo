// RealtimeProvider: the WS spine bound to the active server.
// Sits inside AuthProvider (needs useServers + useAuth). On active-server
// change (or sign-in) it tears down the old client and builds a new one for
// the active server's `wss://…/ws` — this is the "seamless switch": no
// forced re-login while the target server's refresh token is valid.
// AppState drives suspend/resume so backgrounded apps don't hold sockets.
// `onAuthRejected` (3 auth failures / dead refresh) → `signOut()` falls
// back to the sign-in gate; we do NOT loop reconnect. Rehydrate is exposed
// as `connectionState` for presentation. Semantic open/recovery revisions
// keep feature modules from mistaking the first connection for recovery.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createServerRealtime, type AuthRejectedReason } from "@/lib/realtime";
import { observeMobileHumanActivity } from "@/lib/human-activity";
import { createHumanActivityTracker } from "@nautilo/realtime-client";
import { emitAuthDead } from "@/lib/auth-events";
import {
  clearClientActionSession,
  installClientActionSession,
  withCurrentClientActionSession,
} from "@/lib/client-action-session";
import { serverIdFromUrl } from "@/lib/server-store";
import { appLifecycle } from "@/platform/app-lifecycle";
import { useAuth } from "@/providers/auth";
import {
  advanceRealtimeOpenState,
  initialRealtimeOpenState,
  settleRealtimeIdentityRefresh,
  visibleRealtimeOpenState,
} from "@/providers/realtime-open-state";
import { useServers } from "@/providers/server-registry";
import type { ServerEvent, VoicePlaybackEvent } from "@nautilo/types";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "open"
  | "closed";

type EventHandler = (event: ServerEvent) => void;

interface RealtimeValue {
  /** WS connection state for the active server; "idle" when no client. */
  connectionState: ConnectionState;
  /** Every successful open in the current authenticated Server scope. */
  openRevision: number;
  /** Opens that require canonical recovery: reconnects and stale first opens. */
  recoveryRevision: number;
  /** Fan-out subscription. Returns an unsubscribe. Handlers fire on every inbound ServerEvent. */
  subscribe: (handler: EventHandler) => () => void;
  subscribeVoice: (handler: (event: VoicePlaybackEvent) => void) => () => void;
  /** Send an outbound message. No-op when idle (no client). Buffered by the client during the auth handshake. */
  send: (message: Record<string, unknown>) => void;
  /** Stamp an ordinary request from this socket only; caller values are discarded. */
  withClientActionSession: <T extends Record<string, unknown>>(body: T) =>
    Omit<T, "clientActionSessionId"> & { clientActionSessionId?: string };
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { activeServer } = useServers();
  const { status, viewer, viewerState, refreshViewer } = useAuth();

  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [publishedOpenState, setPublishedOpenState] = useState(() => initialRealtimeOpenState(null));
  // Fan-out surface: feature modules subscribe here; the client's onEvent
  // dispatches to every registered handler. Ref-held so subscribe/unsubscribe
  // identity is stable across renders.
  const handlersRef = useRef<Set<EventHandler>>(new Set());
  const voiceHandlersRef = useRef(new Set<(event: VoicePlaybackEvent) => void>());
  // The current client. Closed + nulled on server switch / sign-out / unmount.
  const clientRef = useRef<ReturnType<typeof createServerRealtime> | null>(null);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const connectionGenerationRef = useRef(0);
  const connectionEventGenerationRef = useRef(0);
  const openStateRef = useRef(initialRealtimeOpenState(null));
  const viewerStateRef = useRef(viewerState);
  viewerStateRef.current = viewerState;
  const currentScopeId = activeServer && status === "signed-in"
    ? serverIdFromUrl(activeServer.serverUrl)
    : null;
  const currentScopeIdRef = useRef(currentScopeId);
  currentScopeIdRef.current = currentScopeId;
  const visibleOpenState = visibleRealtimeOpenState(publishedOpenState, currentScopeId);

  // (Re)build the WS client whenever the active server changes (and the
  // user is signed in). Tear down + idle otherwise. The cleanup closes
  // the previous client BEFORE the next effect builds its replacement,
  // so server switches are atomic — no zombie sockets.
  useEffect(() => {
    if (!activeServer || status !== "signed-in") {
      connectionGenerationRef.current += 1;
      connectionEventGenerationRef.current += 1;
      clientRef.current?.close();
      clientRef.current = null;
      clearClientActionSession();
      connectionStateRef.current = "idle";
      openStateRef.current = initialRealtimeOpenState(null);
      setConnectionState("idle");
      setPublishedOpenState(initialRealtimeOpenState(null));
      return;
    }

    const serverId = currentScopeId!;
    const humanActivity = createHumanActivityTracker();
    const stopObservingActivity = observeMobileHumanActivity(() => humanActivity.recordInteraction());
    openStateRef.current = initialRealtimeOpenState(serverId);
    setPublishedOpenState(initialRealtimeOpenState(serverId));
    const generation = ++connectionGenerationRef.current;
    const isCurrent = () => connectionGenerationRef.current === generation
      && currentScopeIdRef.current === serverId;
    const client = createServerRealtime({
      baseUrl: activeServer.serverUrl,
      serverId,
      isIdle: () => humanActivity.isIdle(),
      onEvent: (event) => {
        if (!isCurrent()) return;
        // Fan-out: one bad subscriber must not kill the dispatch loop.
        handlersRef.current.forEach((h) => {
          try {
            h(event);
          } catch {
            /* isolated — subscriber error swallowed intentionally */
          }
        });
      },
      onVoiceEvent: (event) => {
        if (!isCurrent()) return;
        for (const handler of voiceHandlersRef.current) handler(event);
      },
      onControlEvent: (event) => {
        if (!isCurrent() || event.type !== "client.session.v1") return;
        installClientActionSession(event);
      },
      onStateChange: (s) => {
        if (!isCurrent()) return;
        const eventGeneration = ++connectionEventGenerationRef.current;
        if (s !== "open") {
          clearClientActionSession();
          setPublishedOpenState((current) => current.scopeId === serverId
            ? { ...current, settled: false }
            : current,
          );
        }
        const previous = connectionStateRef.current;
        connectionStateRef.current = s;
        if (previous !== "open" && s === "open") {
          const transition = advanceRealtimeOpenState(openStateRef.current, serverId, {
            viewerVerified: viewerStateRef.current === "verified",
          });
          openStateRef.current = transition.state;
          const isOpenCurrent = () => isCurrent()
            && connectionEventGenerationRef.current === eventGeneration
            && connectionStateRef.current === "open";
          const publishOpen = () => {
            if (!isOpenCurrent()) return;
            setPublishedOpenState(transition.state);
          };
          if (transition.needsIdentityRefresh) {
            // A verified first open needs no duplicate whoami. Reconnects and
            // stale cold starts repair identity first, then publish one settled
            // recovery boundary to downstream readers.
            setPublishedOpenState({ ...transition.state, settled: false });
            void settleRealtimeIdentityRefresh(refreshViewer, isOpenCurrent).then((settled) => {
              if (settled) publishOpen();
            });
          } else {
            publishOpen();
          }
        }
        setConnectionState(s);
      },
      onAuthRejected: (_reason: AuthRejectedReason) => {
        if (!isCurrent()) return;
        // Refresh dead or token rejected 3× — enter the same canonical
        // auth-dead transition as HTTP. No reconnect loop: AuthProvider flips
        // status and this effect tears the client down.
        emitAuthDead(serverId);
      },
    });
    clientRef.current = client;

    return () => {
      stopObservingActivity();
      if (isCurrent()) connectionGenerationRef.current += 1;
      connectionEventGenerationRef.current += 1;
      client.close();
      if (clientRef.current === client) clientRef.current = null;
      clearClientActionSession();
      connectionStateRef.current = "idle";
      setConnectionState("idle");
    };
  }, [activeServer, status, viewer?.userId, refreshViewer]);

  // AppState — suspend the socket on background/inactive, resume on active.
  // Independent of the client lifecycle above so it never re-creates the
  // client; it just calls suspend()/resume() on whatever client exists.
  useEffect(() => {
    const sub = appLifecycle.addEventListener("change", (state) => {
      const client = clientRef.current;
      if (!client) return;
      if (state === "active") client.resume();
      else client.suspend();
    });
    return () => sub.remove();
  }, []);

  const subscribe = useMemo<RealtimeValue["subscribe"]>(
    () => (handler) => {
      handlersRef.current.add(handler);
      return () => {
        handlersRef.current.delete(handler);
      };
    },
    [],
  );

  const subscribeVoice = useMemo<RealtimeValue["subscribeVoice"]>(() => handler => {
    voiceHandlersRef.current.add(handler);
    return () => { voiceHandlersRef.current.delete(handler); };
  }, []);

  const send = useMemo<RealtimeValue["send"]>(
    () => (message) => {
      // No-op when idle; the client buffers during the auth handshake.
      clientRef.current?.send(message);
    },
    [],
  );

  const withClientActionSession = useMemo<RealtimeValue["withClientActionSession"]>(
    () => (body) => withCurrentClientActionSession(body),
    [],
  );

  const value = useMemo<RealtimeValue>(
    () => ({
      connectionState,
      openRevision: visibleOpenState.openRevision,
      recoveryRevision: visibleOpenState.recoveryRevision,
      subscribe,
      subscribeVoice,
      send,
      withClientActionSession,
    }),
    [connectionState, visibleOpenState.openRevision, visibleOpenState.recoveryRevision, subscribe, subscribeVoice, send, withClientActionSession],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}
