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
import { useLocation, useNavigate } from "react-router-dom";
import type { RoomSummaryDto } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useCan } from "../hooks/use-can";
import { parseRouteRoomId, roomPath } from "../routes/room-route";
import {
  createRoomNavigationStorage,
  stableViewerKeyForStorage,
  type RoomNavStoredPayload,
} from "../rooms/room-navigation-storage";
import { mergeRoomSummariesWithMetadata, sortWorkbenchRooms } from "../rooms/room-navigation-merge";
import { resolveActiveRoom } from "../rooms/resolve-active-room";
import { roomsVisibleToViewer } from "../rooms/guest-room-visibility";
import type {
  ActiveRoomResolution,
  RoomNavigationAPI,
  RoomNavigationStatus,
  RoomNavigationTargetOptions,
  WorkbenchRoomSummary,
} from "../rooms/room-navigation-types";

const RoomNavigationContext = createContext<RoomNavigationAPI | null>(null);

const EMPTY_META: RoomNavStoredPayload = { version: 1, rooms: {} };

function applyRoomMeta(
  prev: RoomNavStoredPayload,
  roomId: string,
  patch: Partial<RoomNavStoredPayload["rooms"][string]>,
): RoomNavStoredPayload {
  const prior = prev.rooms[roomId] ?? {};
  return {
    ...prev,
    rooms: {
      ...prev.rooms,
      [roomId]: { ...prior, ...patch },
    },
  };
}

function nextTabOrder(payload: RoomNavStoredPayload): number {
  let max = -1;
  for (const meta of Object.values(payload.rooms)) {
    if (typeof meta.tabOrder === "number" && Number.isFinite(meta.tabOrder)) {
      max = Math.max(max, meta.tabOrder);
    }
  }
  return max + 1;
}

export function RoomNavigationProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const can = useCan();
  const canInvokeAgents = can("invoke_agents");
  const location = useLocation();
  const navigate = useNavigate();
  const canConsumeRooms = isAuthenticatedHumanViewer(auth.viewer);
  const viewerKey = stableViewerKeyForStorage(auth.viewer);

  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";

  const storageApi = useMemo(
    () =>
      createRoomNavigationStorage({
        storage: typeof window !== "undefined" ? window.localStorage : null,
        origin,
        viewerKey,
      }),
    [origin, viewerKey],
  );

  const [serverRooms, setServerRooms] = useState<RoomSummaryDto[]>([]);
  const [clientMeta, setClientMeta] = useState<RoomNavStoredPayload>(EMPTY_META);
  const [status, setStatus] = useState<RoomNavigationStatus>("guest");
  const [roomListError, setRoomListError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [routeRecovery, setRouteRecovery] = useState<{
    roomId: string;
    phase: "checking" | "checked" | "failed";
  } | null>(null);

  const serverRoomsRef = useRef(serverRooms);
  serverRoomsRef.current = serverRooms;
  const recentlyClosedRoomIdRef = useRef<string | null>(null);
  const beforeActiveRoomChangeListenersRef = useRef(
    new Set<(nextRoomId: string | null) => void>(),
  );
  const registerBeforeActiveRoomChange = useCallback((
    listener: (nextRoomId: string | null) => void,
  ) => {
    beforeActiveRoomChangeListenersRef.current.add(listener);
    return () => {
      beforeActiveRoomChangeListenersRef.current.delete(listener);
    };
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadVisibleRooms = useCallback(async (): Promise<RoomSummaryDto[]> => {
    const initial = await apiClient.listRooms();
    const visible = roomsVisibleToViewer(initial.rooms, {
      viewerActorId: auth.viewer.sessionActorId,
      canInvokeAgents,
    });
    if (visible.length > 0) return visible;

    // Membership-changing fallback is wholly server-owned: the client neither
    // ranks public Rooms nor chooses an administrator from cached identity data.
    await apiClient.resolveLandingRoom();
    const landed = await apiClient.listRooms();
    return roomsVisibleToViewer(landed.rooms, {
      viewerActorId: auth.viewer.sessionActorId,
      canInvokeAgents,
    });
  }, [auth.viewer.sessionActorId, canInvokeAgents]);

  const updateClientMeta = useCallback(
    (fn: (prev: RoomNavStoredPayload) => RoomNavStoredPayload) => {
      setClientMeta((prev) => {
        const next = fn(prev);
        storageApi.save(next);
        return next;
      });
    },
    [storageApi],
  );

  const performRefreshRooms = useCallback(async (): Promise<boolean> => {
    if (!canConsumeRooms || auth.viewer.staleWhoami) return false;
    setRoomListError(null);
    try {
      const rooms = await loadVisibleRooms();
      if (!mountedRef.current) return false;
      setServerRooms(rooms);
      setStatus("ready");
      setLastLoadedAt(Date.now());
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      const message =
        err instanceof Error ? err.message : "Could not load rooms from the server.";
      setRoomListError(message);
      setStatus(serverRoomsRef.current.length > 0 ? "ready" : "error");
      return false;
    }
  }, [canConsumeRooms, auth.viewer.staleWhoami, loadVisibleRooms]);

  const refreshRooms = useCallback(async (): Promise<void> => {
    const succeeded = await performRefreshRooms();
    if (!succeeded) return;
    // A manual retry after an indeterminate route recovery is authoritative:
    // if the Room is still absent, the normal missing resolution may render.
    setRouteRecovery((current) =>
      current?.phase === "failed" ? { ...current, phase: "checked" } : current,
    );
  }, [performRefreshRooms]);

  useEffect(() => {
    if (!canConsumeRooms || auth.viewer.staleWhoami) return;
    const handler = (): void => {
      void refreshRooms();
    };
    window.addEventListener("nautilo:room-members-changed", handler);
    window.addEventListener("nautilo:room-catalog-changed", handler);
    window.addEventListener("nautilo:admission-resumed", handler);
    // Agent display names, handles, and avatars are projected into each Room
    // summary roster. A profile save can happen while the Room surface is
    // hidden behind Settings, so refreshing only the profile provider leaves
    // Explorer and the next-opened conversation rendering the old identity.
    // Re-read the authorized catalogue whenever profile identity changes.
    window.addEventListener("nautilo:profile-changed", handler);
    return () => {
      window.removeEventListener("nautilo:room-members-changed", handler);
      window.removeEventListener("nautilo:room-catalog-changed", handler);
      window.removeEventListener("nautilo:admission-resumed", handler);
      window.removeEventListener("nautilo:profile-changed", handler);
    };
  }, [canConsumeRooms, auth.viewer.staleWhoami, refreshRooms]);

  useEffect(() => {
    if (!canConsumeRooms) {
      setServerRooms([]);
      setClientMeta(EMPTY_META);
      setRoomListError(null);
      setStatus("guest");
      return;
    }

    // D301 — after a full restore / Logto realm replacement, Electron can
    // mount with a persisted last-known viewer while the desktop bearer is
    // still being rehydrated. That cached viewer is marked staleWhoami=true.
    // Fetching rooms during that window can legitimately hit the server as
    // guest and return an empty rooms list, making the user think their data
    // is gone. Wait for useAuth's successful whoami tick to flip staleWhoami
    // false, then fetch. The effect depends on staleWhoami, so it reruns
    // immediately once the fresh bearer/viewer is available.
    if (auth.viewer.staleWhoami) {
      setRoomListError(null);
      setStatus(serverRoomsRef.current.length > 0 ? "ready" : "loading");
      return;
    }

    const loaded = storageApi.load();
    setClientMeta(loaded);
    setServerRooms([]);

    let cancelled = false;
    void (async () => {
      setRoomListError(null);
      setStatus("loading");
      try {
        const rooms = await loadVisibleRooms();
        if (cancelled || !mountedRef.current) return;
        setServerRooms(rooms);
        setStatus("ready");
        setLastLoadedAt(Date.now());
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        const message =
          err instanceof Error ? err.message : "Could not load rooms from the server.";
        setRoomListError(message);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canConsumeRooms, auth.viewer.staleWhoami, viewerKey, storageApi, loadVisibleRooms]);

  const mergedSorted = useMemo(() => {
    const merged = mergeRoomSummariesWithMetadata(serverRooms, clientMeta);
    return sortWorkbenchRooms(merged);
  }, [serverRooms, clientMeta]);

  const routeRoomId = parseRouteRoomId(location.pathname);
  const routeRoomIsKnown =
    routeRoomId !== undefined && mergedSorted.some((room) => room.id === routeRoomId);

  // A server-authorized search result or deep link can arrive after the local
  // Room catalogue was loaded. Give that exact route one authoritative list
  // refresh before resolving it as missing; the per-route phase prevents an
  // absent/revoked Room from causing a retry loop.
  useEffect(() => {
    if (
      !canConsumeRooms ||
      auth.viewer.staleWhoami ||
      status !== "ready" ||
      routeRoomId === undefined ||
      routeRoomIsKnown ||
      routeRecovery?.roomId === routeRoomId
    ) {
      return;
    }

    setRouteRecovery({ roomId: routeRoomId, phase: "checking" });
    void performRefreshRooms().then((succeeded) => {
      if (!mountedRef.current) return;
      setRouteRecovery((current) =>
        current?.roomId === routeRoomId
          ? { roomId: routeRoomId, phase: succeeded ? "checked" : "failed" }
          : current,
      );
    });
  }, [
    canConsumeRooms,
    auth.viewer.staleWhoami,
    performRefreshRooms,
    routeRecovery?.roomId,
    routeRoomId,
    routeRoomIsKnown,
    status,
  ]);

  const activeResolution: ActiveRoomResolution = useMemo(() => {
    if (!canConsumeRooms || status === "loading") {
      return { kind: "none" };
    }
    if (
      routeRoomId !== undefined &&
      !routeRoomIsKnown &&
      (routeRecovery?.roomId !== routeRoomId || routeRecovery.phase !== "checked")
    ) {
      return { kind: "none" };
    }
    return resolveActiveRoom({
      routeRoomId,
      storedRoomId: clientMeta.lastActiveRoomId,
      rooms: mergedSorted,
      fallbackWhenRouteMissing: !canInvokeAgents,
    });
  }, [
    canConsumeRooms,
    status,
    routeRoomId,
    routeRoomIsKnown,
    routeRecovery,
    clientMeta.lastActiveRoomId,
    mergedSorted,
    canInvokeAgents,
  ]);

  const activeRoomId =
    activeResolution.kind === "selected" ? activeResolution.roomId : null;
  const activeRoom: WorkbenchRoomSummary | null =
    activeRoomId === null ? null : mergedSorted.find((r) => r.id === activeRoomId) ?? null;
  const notifyBeforeActiveRoomChange = useCallback((nextRoomId: string | null) => {
    if (nextRoomId === activeRoomId) return;
    for (const listener of beforeActiveRoomChangeListenersRef.current) {
      listener(nextRoomId);
    }
  }, [activeRoomId]);

  useEffect(() => {
    if (
      canInvokeAgents ||
      !routeRoomId ||
      activeResolution.kind !== "selected" ||
      activeResolution.roomId === routeRoomId
    ) return;
    void navigate(roomPath(activeResolution.roomId), { replace: true });
  }, [activeResolution, canInvokeAgents, navigate, routeRoomId]);

  useEffect(() => {
    if (activeResolution.kind !== "selected") return;
    const id = activeResolution.roomId;
    setClientMeta((prev) => {
      const prior = prev.rooms[id] ?? {};
      if (
        recentlyClosedRoomIdRef.current === id &&
        prior.closedTab === true &&
        prev.lastActiveRoomId !== id
      ) {
        return prev;
      }
      recentlyClosedRoomIdRef.current = null;
      if (
        prev.lastActiveRoomId === id &&
        prior.tabOpen === true &&
        prior.closedTab !== true
      ) {
        return prev;
      }
      const next = {
        ...applyRoomMeta(prev, id, {
          tabOpen: true,
          closedTab: false,
          lastOpenedAt: prior.lastOpenedAt ?? Date.now(),
          tabOrder: prior.tabOrder ?? nextTabOrder(prev),
        }),
        lastActiveRoomId: id,
      };
      storageApi.save(next);
      return next;
    });
  }, [activeResolution, storageApi]);

  useEffect(() => {
    if (!canConsumeRooms || status === "loading") return;
    const visibleOpenRoomIds = mergedSorted
      .filter((room) => (
        room.id === activeRoomId ||
        (!room.closedTab && (room.pinned || room.tabOpen))
      ))
      .map((room) => room.id);
    if (visibleOpenRoomIds.length === 0) return;

    setClientMeta((prev) => {
      let next = prev;
      let nextOrder = nextTabOrder(prev);
      let changed = false;
      for (const roomId of visibleOpenRoomIds) {
        if (typeof next.rooms[roomId]?.tabOrder === "number") continue;
        next = applyRoomMeta(next, roomId, { tabOrder: nextOrder });
        nextOrder += 1;
        changed = true;
      }
      if (changed) storageApi.save(next);
      return changed ? next : prev;
    });
  }, [activeRoomId, canConsumeRooms, mergedSorted, status, storageApi]);

  const setActiveRoom = useCallback(
    (roomId: string, options: RoomNavigationTargetOptions = {}) => {
      recentlyClosedRoomIdRef.current = null;
      notifyBeforeActiveRoomChange(roomId);
      void navigate(roomPath(roomId, options));
      updateClientMeta((prev) => ({
        ...applyRoomMeta(prev, roomId, {
          tabOpen: true,
          closedTab: false,
          lastOpenedAt: Date.now(),
          tabOrder: prev.rooms[roomId]?.tabOrder ?? nextTabOrder(prev),
        }),
        lastActiveRoomId: roomId,
      }));
    },
    [navigate, notifyBeforeActiveRoomChange, updateClientMeta],
  );

  const openTabForRoom = useCallback(
    (roomId: string) => {
      updateClientMeta((prev) =>
        applyRoomMeta(prev, roomId, {
          tabOpen: true,
          closedTab: false,
          tabOrder: prev.rooms[roomId]?.tabOrder ?? nextTabOrder(prev),
        }),
      );
    },
    [updateClientMeta],
  );

  const pinRoom = useCallback(
    (roomId: string) => {
      updateClientMeta((prev) =>
        applyRoomMeta(prev, roomId, {
          pinned: true,
          tabOpen: true,
          closedTab: false,
          tabOrder: prev.rooms[roomId]?.tabOrder ?? nextTabOrder(prev),
        }),
      );
    },
    [updateClientMeta],
  );

  const unpinRoom = useCallback(
    (roomId: string) => {
      updateClientMeta((prev) => applyRoomMeta(prev, roomId, { pinned: false }));
    },
    [updateClientMeta],
  );

  const closeTabForRoom = useCallback(
    (roomId: string) => {
      recentlyClosedRoomIdRef.current = roomId;
      updateClientMeta((prev) =>
        applyRoomMeta(prev, roomId, { pinned: false, tabOpen: false, closedTab: true }),
      );
    },
    [updateClientMeta],
  );

  const restoreClosedTabForRoom = useCallback(
    (roomId: string) => {
      updateClientMeta((prev) =>
        applyRoomMeta(prev, roomId, {
          tabOpen: true,
          closedTab: false,
          tabOrder: prev.rooms[roomId]?.tabOrder ?? nextTabOrder(prev),
        }),
      );
    },
    [updateClientMeta],
  );

  const createRoom = useCallback(
    async (label: string) => {
      const created = await apiClient.createRoom({ label });
      await refreshRooms();
      notifyBeforeActiveRoomChange(created.id);
      void navigate(roomPath(created.id));
      updateClientMeta((prev) => ({
        ...applyRoomMeta(prev, created.id, {
          tabOpen: true,
          closedTab: false,
          lastOpenedAt: Date.now(),
          tabOrder: nextTabOrder(prev),
        }),
        lastActiveRoomId: created.id,
      }));
    },
    [refreshRooms, navigate, notifyBeforeActiveRoomChange, updateClientMeta],
  );

  const renameRoom = useCallback(
    async (roomId: string, label: string) => {
      await apiClient.renameRoom(roomId, { label });
      await refreshRooms();
    },
    [refreshRooms],
  );

  const reorderOpenTabs = useCallback(
    (orderedRoomIds: string[]) => {
      updateClientMeta((prev) => {
        let next = prev;
        orderedRoomIds.forEach((roomId, index) => {
          next = applyRoomMeta(next, roomId, { tabOrder: index });
        });
        return next;
      });
    },
    [updateClientMeta],
  );

  const value = useMemo<RoomNavigationAPI>(
    () => ({
      rooms: mergedSorted,
      activeRoomId,
      activeRoom,
      activeResolution,
      status,
      roomListError,
      lastLoadedAt,
      refreshRooms,
      registerBeforeActiveRoomChange,
      setActiveRoom,
      createRoom,
      openTabForRoom,
      pinRoom,
      unpinRoom,
      closeTabForRoom,
      restoreClosedTabForRoom,
      reorderOpenTabs,
      renameRoom,
    }),
    [
      mergedSorted,
      activeRoomId,
      activeRoom,
      activeResolution,
      status,
      roomListError,
      lastLoadedAt,
      refreshRooms,
      registerBeforeActiveRoomChange,
      setActiveRoom,
      createRoom,
      openTabForRoom,
      pinRoom,
      unpinRoom,
      closeTabForRoom,
      restoreClosedTabForRoom,
      reorderOpenTabs,
      renameRoom,
    ],
  );

  return (
    <RoomNavigationContext.Provider value={value}>{children}</RoomNavigationContext.Provider>
  );
}

export function useRoomNavigation(): RoomNavigationAPI {
  const ctx = useContext(RoomNavigationContext);
  if (!ctx) {
    throw new Error("useRoomNavigation must be used within <RoomNavigationProvider>");
  }
  return ctx;
}
