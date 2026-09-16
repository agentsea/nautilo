import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import type {
  ImportantMessageArrivedEvent,
  NotificationLevel,
  NotificationStateResponse,
} from "@nautilo/types";
import { apiClient } from "../lib/api";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import {
  useNotificationRuntimeEventSource,
  useWsStateContext,
} from "../adapters/runtime-contexts";
import { desktopAPI } from "../lib/desktop";
import { buildImportantArrivalNotificationRequest } from "../lib/desktop-chat-notifications";
import {
  applyNotificationStateChange,
  createNotificationRefreshCoordinator,
  type NotificationRefreshCoordinator,
} from "./notification-state-store";
import { buildSubthreadsByAnchor } from "./notification-display";
import { useDrawer } from "../modes/rooms/thread-drawer/drawer-state";
import { roomPath } from "../routes/room-route";
import { VISIBLE_SESSION_REFRESH_INTERVAL_MS } from "../lib/visible-session-refresh";

export interface NotificationPreferenceMutationState {
  busy: boolean;
  error: string | null;
}

export interface WorkbenchNotificationState {
  snapshot: NotificationStateResponse | null;
  roomsById: ReadonlyMap<string, NotificationStateResponse["rooms"][number]>;
  subthreadsById: ReadonlyMap<
    string,
    NotificationStateResponse["subthreads"][number]
  >;
  subthreadsByAnchor: ReadonlyMap<
    string,
    NotificationStateResponse["subthreads"][number]
  >;
  defaultPreferenceMutation: NotificationPreferenceMutationState;
  roomPreferenceMutations: ReadonlyMap<
    string,
    NotificationPreferenceMutationState
  >;
  connected: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  latestAppliedGeneration: number;
  generatedAt: string | null;
  refresh: () => void;
  refreshAndWait: () => Promise<NotificationStateResponse | null>;
  setDefaultNotificationLevel: (level: NotificationLevel) => Promise<boolean>;
  setRoomNotificationPreference: (
    roomId: string,
    level: "inherit" | NotificationLevel,
  ) => Promise<boolean>;
  subscribeImportantArrivals: (
    listener: (event: ImportantMessageArrivedEvent) => void,
  ) => () => void;
}

const NotificationStateContext =
  createContext<WorkbenchNotificationState | null>(null);

export function NotificationStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const auth = useAuth();
  const authenticatedHuman = isAuthenticatedHumanViewer(auth.viewer);
  const ws = useWsStateContext();
  const eventSource = useNotificationRuntimeEventSource();
  const [snapshot, setSnapshot] = useState<NotificationStateResponse | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestAppliedGeneration, setLatestAppliedGeneration] = useState(0);
  const [defaultPreferenceMutation, setDefaultPreferenceMutation] =
    useState<NotificationPreferenceMutationState>({
      busy: false,
      error: null,
    });
  const [roomPreferenceMutations, setRoomPreferenceMutations] = useState(
    new Map<string, NotificationPreferenceMutationState>(),
  );
  const snapshotRef = useRef<NotificationStateResponse | null>(null);
  const importantListenersRef = useRef(
    new Set<(event: ImportantMessageArrivedEvent) => void>(),
  );
  const coordinatorRef = useRef<NotificationRefreshCoordinator | null>(null);
  const defaultMutationTokenRef = useRef<object | null>(null);
  const roomMutationTokensRef = useRef(new Map<string, object>());
  const sessionKeyRef = useRef("");

  if (coordinatorRef.current === null) {
    coordinatorRef.current = createNotificationRefreshCoordinator({
      fetchState: () => apiClient.getNotificationState(),
      onApply: (next, generation) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setLatestAppliedGeneration(generation);
        setStale(false);
        setError(null);
      },
      onError: (cause) => {
        setStale(true);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not refresh notification state",
        );
      },
      onRefreshing: setRefreshing,
    });
  }

  const refresh = useCallback(() => {
    if (!authenticatedHuman || ws.state !== "open") return;
    void coordinatorRef.current?.request();
  }, [authenticatedHuman, ws.state]);
  const refreshAndWait = useCallback(() => {
    if (!authenticatedHuman || ws.state !== "open") {
      return Promise.resolve(null);
    }
    return coordinatorRef.current?.request() ?? Promise.resolve(null);
  }, [authenticatedHuman, ws.state]);

  const sessionKey = `${auth.viewerGeneration}:${auth.viewer.sessionUserId ?? ""}`;
  sessionKeyRef.current = sessionKey;
  useEffect(() => {
    coordinatorRef.current?.reset(sessionKey);
    snapshotRef.current = null;
    setSnapshot(null);
    setLatestAppliedGeneration(0);
    setStale(false);
    setError(null);
    defaultMutationTokenRef.current = null;
    roomMutationTokensRef.current.clear();
    setDefaultPreferenceMutation({ busy: false, error: null });
    setRoomPreferenceMutations(new Map());
  }, [authenticatedHuman, sessionKey]);

  useEffect(() => {
    if (authenticatedHuman && ws.state === "open") {
      void coordinatorRef.current?.request();
    }
  }, [authenticatedHuman, sessionKey, ws.state]);

  useEffect(() => {
    apiClient.setNotificationStateInvalidationHandler(refresh);
    return () => apiClient.setNotificationStateInvalidationHandler(null);
  }, [refresh]);

  useEffect(() => {
    window.addEventListener("nautilo:admission-resumed", refresh);
    return () => window.removeEventListener("nautilo:admission-resumed", refresh);
  }, [refresh]);

  useEffect(() => {
    return eventSource.subscribe((event) => {
      if (
        !authenticatedHuman ||
        event.userId !== auth.viewer.sessionUserId
      ) {
        return;
      }
      if (event.type === "notification.message.important") {
        for (const listener of importantListenersRef.current) listener(event);
        return;
      }
      const patched = applyNotificationStateChange(snapshotRef.current, event);
      if (patched.kind === "dirty") {
        void coordinatorRef.current?.request();
        return;
      }
      snapshotRef.current = patched.snapshot;
      setSnapshot(patched.snapshot);
    });
  }, [
    authenticatedHuman,
    auth.viewer.sessionUserId,
    eventSource,
  ]);

  useEffect(() => {
    if (!authenticatedHuman || ws.state !== "open") return;
    const timer = window.setInterval(refresh, VISIBLE_SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [authenticatedHuman, refresh, ws.state]);

  useEffect(() => {
    if (!authenticatedHuman) return;
    const onActivation = (): void => {
      if (
        document.visibilityState === "visible" &&
        ws.state === "open"
      ) {
        refresh();
      }
    };
    window.addEventListener("focus", onActivation);
    document.addEventListener("visibilitychange", onActivation);
    return () => {
      window.removeEventListener("focus", onActivation);
      document.removeEventListener("visibilitychange", onActivation);
    };
  }, [authenticatedHuman, refresh, ws.state]);

  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      importantListenersRef.current.clear();
    },
    [],
  );

  const subscribeImportantArrivals = useCallback(
    (listener: (event: ImportantMessageArrivedEvent) => void) => {
      importantListenersRef.current.add(listener);
      return () => {
        importantListenersRef.current.delete(listener);
      };
    },
    [],
  );
  const setDefaultNotificationLevel = useCallback(
    async (level: NotificationLevel): Promise<boolean> => {
      if (!authenticatedHuman || defaultMutationTokenRef.current) {
        return false;
      }
      const token = {};
      const requestSessionKey = sessionKey;
      defaultMutationTokenRef.current = token;
      setDefaultPreferenceMutation({ busy: true, error: null });
      try {
        await apiClient.setDefaultNotificationLevel(level);
        return requestSessionKey === sessionKeyRef.current;
      } catch (cause) {
        if (
          defaultMutationTokenRef.current === token &&
          requestSessionKey === sessionKeyRef.current
        ) {
          setDefaultPreferenceMutation({
            busy: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not save notification preference",
          });
        }
        return false;
      } finally {
        if (
          defaultMutationTokenRef.current === token &&
          requestSessionKey === sessionKeyRef.current
        ) {
          defaultMutationTokenRef.current = null;
          setDefaultPreferenceMutation((previous) => ({
            ...previous,
            busy: false,
          }));
        }
      }
    },
    [authenticatedHuman, sessionKey],
  );
  const setRoomNotificationPreference = useCallback(
    async (
      roomId: string,
      level: "inherit" | NotificationLevel,
    ): Promise<boolean> => {
      if (
        !authenticatedHuman ||
        !roomId ||
        roomMutationTokensRef.current.has(roomId)
      ) {
        return false;
      }
      const token = {};
      const requestSessionKey = sessionKey;
      roomMutationTokensRef.current.set(roomId, token);
      setRoomPreferenceMutations((previous) => {
        const next = new Map(previous);
        next.set(roomId, { busy: true, error: null });
        return next;
      });
      try {
        await apiClient.setRoomNotificationPreference(roomId, level);
        return requestSessionKey === sessionKeyRef.current;
      } catch (cause) {
        if (
          roomMutationTokensRef.current.get(roomId) === token &&
          requestSessionKey === sessionKeyRef.current
        ) {
          setRoomPreferenceMutations((previous) => {
            const next = new Map(previous);
            next.set(roomId, {
              busy: false,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Could not save Room notification preference",
            });
            return next;
          });
        }
        return false;
      } finally {
        if (
          roomMutationTokensRef.current.get(roomId) === token &&
          requestSessionKey === sessionKeyRef.current
        ) {
          roomMutationTokensRef.current.delete(roomId);
          setRoomPreferenceMutations((previous) => {
            const next = new Map(previous);
            const current = next.get(roomId);
            next.set(roomId, {
              busy: false,
              error: current?.error ?? null,
            });
            return next;
          });
        }
      }
    },
    [authenticatedHuman, sessionKey],
  );
  const roomsById = useMemo(
    () => new Map(snapshot?.rooms.map((room) => [room.roomId, room]) ?? []),
    [snapshot],
  );
  const subthreadsById = useMemo(
    () =>
      new Map(
        snapshot?.subthreads.map((subthread) => [
          subthread.roomId,
          subthread,
        ]) ?? [],
      ),
    [snapshot],
  );
  const subthreadsByAnchor = useMemo(
    () => buildSubthreadsByAnchor(snapshot),
    [snapshot],
  );
  const value = useMemo<WorkbenchNotificationState>(
    () => ({
      snapshot,
      roomsById,
      subthreadsById,
      subthreadsByAnchor,
      defaultPreferenceMutation,
      roomPreferenceMutations,
      connected: ws.state === "open",
      refreshing,
      stale,
      error,
      latestAppliedGeneration,
      generatedAt: snapshot?.generatedAt ?? null,
      refresh,
      refreshAndWait,
      setDefaultNotificationLevel,
      setRoomNotificationPreference,
      subscribeImportantArrivals,
    }),
    [
      error,
      defaultPreferenceMutation,
      latestAppliedGeneration,
      refresh,
      refreshAndWait,
      refreshing,
      roomPreferenceMutations,
      roomsById,
      snapshot,
      stale,
      subthreadsById,
      subthreadsByAnchor,
      setDefaultNotificationLevel,
      setRoomNotificationPreference,
      subscribeImportantArrivals,
      ws.state,
    ],
  );

  return (
    <NotificationStateContext.Provider value={value}>
      <ImportantArrivalDesktopBridge />
      {children}
    </NotificationStateContext.Provider>
  );
}

function ImportantArrivalDesktopBridge() {
  const auth = useAuth();
  const authenticatedHuman = isAuthenticatedHumanViewer(auth.viewer);
  const {
    snapshot,
    subthreadsById,
    subscribeImportantArrivals,
    refreshAndWait,
  } = useNotificationState();
  const drawer = useDrawer();
  const navigate = useNavigate();
  const previousDesktopSessionActiveRef = useRef<boolean | null>(null);
  const publicationRef = useRef({
    sessionKey: "",
    epoch: "",
    generation: 0,
    blockedUntilEmpty: true,
  });
  const publicationSessionKey =
    `${auth.viewerGeneration}:${auth.viewer.sessionUserId ?? ""}`;
  if (publicationRef.current.sessionKey !== publicationSessionKey) {
    publicationRef.current = {
      sessionKey: publicationSessionKey,
      epoch:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      generation: 0,
      blockedUntilEmpty: true,
    };
  }
  if (snapshot === null) publicationRef.current.blockedUntilEmpty = false;

  useEffect(() => {
    const activeSession = desktopAPI?.activeSession;
    if (!activeSession) {
      return;
    }
    return activeSession.onStateChange(({ active }) => {
      const wasActive = previousDesktopSessionActiveRef.current;
      previousDesktopSessionActiveRef.current = active;
      if (active && wasActive === false) void refreshAndWait();
    });
  }, [refreshAndWait]);

  useEffect(
    () =>
      subscribeImportantArrivals((event) => {
        const request = buildImportantArrivalNotificationRequest(event);
        if (!request) return;
        void desktopAPI?.notifications
          ?.showImportantMessage(request)
          .catch(() => {});
      }),
    [subscribeImportantArrivals],
  );

  useEffect(() => {
    const publishSummary = desktopAPI?.notifications?.publishSummary;
    if (
      typeof publishSummary !== "function" ||
      snapshot === null ||
      publicationRef.current.blockedUntilEmpty ||
      !authenticatedHuman
    ) {
      return;
    }
    publicationRef.current.generation += 1;
    void publishSummary({
      epoch: publicationRef.current.epoch,
      generation: publicationRef.current.generation,
      generatedAt: snapshot.generatedAt,
      unreadCount: snapshot.totals.unreadCount,
      importantUnreadCount: snapshot.totals.importantUnreadCount,
    }).catch(() => {});
  }, [authenticatedHuman, publicationSessionKey, snapshot]);

  useEffect(() => {
    const subscribe = desktopAPI?.notifications?.onNavigate;
    if (typeof subscribe !== "function") return;
    return subscribe((target) => {
      if (
        !target ||
        typeof target.topLevelRoomId !== "string" ||
        target.topLevelRoomId.trim().length === 0
      ) {
        return;
      }
      const topLevelRoomId = target.topLevelRoomId.trim();
      const subthreadRoomId =
        typeof target.subthreadRoomId === "string"
          ? target.subthreadRoomId.trim()
          : "";

      drawer.close();
      void navigate(roomPath(topLevelRoomId));
      if (!subthreadRoomId || subthreadRoomId === topLevelRoomId) return;

      const openResolvedChild = (
        candidate:
          | NotificationStateResponse["subthreads"][number]
          | undefined,
      ): boolean => {
        if (!candidate || candidate.parentRoomId !== topLevelRoomId) {
          return false;
        }
        drawer.open({
          kind: "thread",
          parentRoomId: topLevelRoomId,
          subthreadRoomId,
          anchorMessageId: candidate.anchorMessageId,
        });
        return true;
      };

      if (openResolvedChild(subthreadsById.get(subthreadRoomId))) return;
      void refreshAndWait().then((reconciled) => {
        const candidate = reconciled?.subthreads.find(
          (subthread) => subthread.roomId === subthreadRoomId,
        );
        openResolvedChild(candidate);
      });
    });
  }, [drawer, navigate, refreshAndWait, subthreadsById]);

  return null;
}

/** @public Workbench notification consumers attach here. */
export function useNotificationState(): WorkbenchNotificationState {
  const value = useContext(NotificationStateContext);
  if (value === null) {
    throw new Error(
      "useNotificationState must be used within <NotificationStateProvider>",
    );
  }
  return value;
}
