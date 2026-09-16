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
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { EVENT_FEED_PAGE_SIZE, isEventFeedQuiet, type EventFeedPreference, type EventFeedItem, type EventFeedPage, type RoomDetailResponse } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useWsStateContext, type WsState } from "../adapters/runtime-contexts";
import { subscribeEventFeedChanged } from "./event-feed-change-bus";
import type { EventFeedHumanPresentation } from "./event-feed-presentation";
import { VISIBLE_SESSION_REFRESH_INTERVAL_MS } from "../lib/visible-session-refresh";
import { mergeUniqueEventFeedItems, reconcileEventFeedPages } from "./event-feed-state";

export type EventFeedFilter = "all" | "unread";
export type EventFeedCategory = "all" | "membership" | "artifacts";

const EVENT_TYPES_BY_CATEGORY = {
  membership: ["room.member_joined", "room.member_left"],
  artifacts: ["artifact.added", "artifact.shared"],
} as const;

interface MutationFailure {
  message: string;
  retry: () => Promise<void>;
}

export interface EventFeedContextValue {
  unreadCount: number | null;
  quietPreference: EventFeedPreference | null;
  quiet: boolean;
  preferenceError: string | null;
  savingPreference: boolean;
  setQuietPreference: (preference: EventFeedPreference) => Promise<boolean>;
  refresh: () => Promise<void>;
  events: readonly EventFeedItem[];
  filter: EventFeedFilter;
  setFilter: (filter: EventFeedFilter) => void;
  category: EventFeedCategory;
  setCategory: (category: EventFeedCategory) => void;
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  pendingNewEvents: boolean;
  showPendingNewEvents: () => void;
  setReadState: (eventId: string, read: boolean) => Promise<void>;
  markAllRead: () => Promise<void>;
  busyEventIds: ReadonlySet<string>;
  markingAllRead: boolean;
  mutationFailure: MutationFailure | null;
  clearMutationFailure: () => void;
  humansById: ReadonlyMap<string, EventFeedHumanPresentation>;
  roomsById: ReadonlyMap<string, RoomDetailResponse | null>;
  artifactsById: ReadonlyMap<string, ArtifactDto | null>;
  reauthorizeArtifact: (artifactId: string) => Promise<ArtifactDto | null>;
  viewerActorId: string | null;
  scrollTop: number;
  setScrollTop: (scrollTop: number) => void;
}

const EventFeedContext = createContext<EventFeedContextValue | null>(null);

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;
}

export function EventFeedProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const ws = useWsStateContext();
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const scopeKey = `${serverOrigin}:${auth.viewerGeneration}:${auth.viewer.sessionUserId ?? ""}`;
  return (
    <ScopedEventFeedProvider
      key={scopeKey}
      authenticatedHuman={isAuthenticatedHumanViewer(auth.viewer)}
      credentialGeneration={auth.credentialGeneration}
      viewerActorId={auth.viewer.sessionActorId}
      wsState={ws.state}
    >
      {children}
    </ScopedEventFeedProvider>
  );
}

function ScopedEventFeedProvider({
  authenticatedHuman,
  credentialGeneration,
  viewerActorId,
  wsState,
  children,
}: {
  authenticatedHuman: boolean;
  credentialGeneration: number;
  viewerActorId: string | null;
  wsState: WsState;
  children: ReactNode;
}) {
  const [events, setEvents] = useState<EventFeedItem[]>([]);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [pendingFirstPage, setPendingFirstPageState] = useState<EventFeedItem[] | null>(null);
  const pendingFirstPageRef = useRef(pendingFirstPage);
  pendingFirstPageRef.current = pendingFirstPage;
  const setPendingFirstPage = useCallback((value: EventFeedItem[] | null) => {
    pendingFirstPageRef.current = value;
    setPendingFirstPageState(value);
  }, []);
  const [filter, setFilterState] = useState<EventFeedFilter>("all");
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [category, setCategoryState] = useState<EventFeedCategory>("all");
  const categoryRef = useRef(category);
  categoryRef.current = category;
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [quietPreference, setQuietPreferenceState] = useState<EventFeedPreference | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);
  const savingPreferenceRef = useRef(false);
  const preferenceGenerationRef = useRef(0);
  const [now, setNow] = useState(Date.now);
  const quiet = quietPreference !== null && isEventFeedQuiet(quietPreference, now);
  const unreadCountRef = useRef(unreadCount);
  unreadCountRef.current = unreadCount;
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyEventIds, setBusyEventIds] = useState<ReadonlySet<string>>(new Set());
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [mutationFailure, setMutationFailure] = useState<MutationFailure | null>(null);
  const [humansById, setHumansById] = useState<ReadonlyMap<string, EventFeedHumanPresentation>>(new Map());
  const [roomsById, setRoomsById] = useState<ReadonlyMap<string, RoomDetailResponse | null>>(new Map());
  const [artifactsById, setArtifactsById] = useState<ReadonlyMap<string, ArtifactDto | null>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);

  const activeRef = useRef(true);
  const queryGenerationRef = useRef(0);
  const hydrationGenerationRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const queuedRefreshRef = useRef(false);
  const mutationTokenRef = useRef<object | null>(null);
  const requestTailRef = useRef<Promise<void>>(Promise.resolve());
  const loadingMoreRef = useRef(false);

  // One owner serializes reads and writes. A background response cannot undo
  // a confirmed mutation or move a pagination cursor behind a loaded page.
  const runRequest = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = requestTailRef.current.then(async () => {
      if (activeRef.current) await operation();
    });
    requestTailRef.current = next.catch(() => {});
    return next;
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      queryGenerationRef.current += 1;
      hydrationGenerationRef.current += 1;
    };
  }, []);

  // Chunk long deadlines using the existing visible-session refresh interval;
  // browser timeout overflow must never end a long snooze immediately.
  useEffect(() => {
    if (quietPreference?.mode !== "snoozed") return;
    let timer: number;
    const update = (): void => {
      const currentTime = Date.now();
      setNow(currentTime);
      const remaining = Date.parse(quietPreference.until) - currentTime;
      if (remaining > 0) timer = window.setTimeout(update, Math.min(remaining, VISIBLE_SESSION_REFRESH_INTERVAL_MS));
    };
    update();
    // Visibility/focus can fire while a timer is pending: keep one timer owner.
    const onActivation = (): void => { window.clearTimeout(timer); update(); };
    window.addEventListener("focus", onActivation);
    document.addEventListener("visibilitychange", onActivation);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onActivation);
      document.removeEventListener("visibilitychange", onActivation);
    };
  }, [quietPreference]);

  const refreshPreference = useCallback(async (): Promise<void> => {
    const generation = ++preferenceGenerationRef.current;
    try {
      const preference = await apiClient.getEventFeedPreference();
      if (!activeRef.current || generation !== preferenceGenerationRef.current) return;
      setQuietPreferenceState(preference);
      setNow(Date.now());
      setPreferenceError(null);
    } catch {
      if (activeRef.current && generation === preferenceGenerationRef.current) setPreferenceError("Could not refresh your Events preference.");
    }
  }, []);

  const setQuietPreference = useCallback(async (preference: EventFeedPreference): Promise<boolean> => {
    if (!authenticatedHuman || wsState !== "open" || savingPreferenceRef.current) return false;
    savingPreferenceRef.current = true;
    setSavingPreference(true);
    setPreferenceError(null);
    let saved = false;
    await runRequest(async () => {
      preferenceGenerationRef.current += 1;
      try {
        const result = await apiClient.setEventFeedPreference(preference);
        if (!activeRef.current) return;
        setQuietPreferenceState(result);
        setNow(Date.now());
        saved = true;
      } catch {
        // A lost response may follow a committed write. Reconcile before a
        // Human retries; never claim an optimistic save or replay automatically.
        await refreshPreference();
        if (activeRef.current) setPreferenceError("Could not confirm the change. Check your connection and try again.");
      } finally {
        savingPreferenceRef.current = false;
        if (activeRef.current) setSavingPreference(false);
      }
    });
    return saved;
  }, [authenticatedHuman, refreshPreference, runRequest, wsState]);

  const resolvePresentation = useCallback(async (
    sourceEvents: readonly EventFeedItem[],
    queryGeneration: number,
  ): Promise<void> => {
    const hydrationGeneration = ++hydrationGenerationRef.current;
    const roomIds = new Set<string>();
    const artifactIds = new Set<string>();
    for (const event of sourceEvents) {
      if (event.type === "room.member_joined" || event.type === "room.member_left") {
        roomIds.add(event.data.roomId);
      } else if (event.type === "artifact.added") {
        artifactIds.add(event.data.artifactId);
        roomIds.add(event.data.roomId);
      } else if (event.type === "artifact.shared") {
        artifactIds.add(event.data.artifactId);
        if (event.data.destination.kind === "room") roomIds.add(event.data.destination.roomId);
      }
    }
    const [humans, rooms, artifacts] = await Promise.all([
      apiClient.listDirectoryHumans().catch(() => []),
      Promise.all([...roomIds].map(async (roomId) => {
        try {
          return [roomId, await apiClient.getRoom(roomId)] as const;
        } catch {
          return [roomId, null] as const;
        }
      })),
      Promise.all([...artifactIds].map(async (artifactId) => {
        try {
          return [artifactId, await apiClient.getWorkspaceArtifact(artifactId)] as const;
        } catch {
          return [artifactId, null] as const;
        }
      })),
    ]);
    if (
      !activeRef.current
      || queryGenerationRef.current !== queryGeneration
      || hydrationGenerationRef.current !== hydrationGeneration
    ) return;
    setHumansById(new Map(humans.map((human) => [human.userId, human])));
    setRoomsById(new Map(rooms));
    setArtifactsById(new Map(artifacts));
  }, []);

  const performRefresh = useCallback(async (): Promise<void> => {
    if (!authenticatedHuman || wsState !== "open" || document.visibilityState === "hidden") return;
    const requestFilter = filterRef.current;
    const requestCategory = categoryRef.current;
    const queryGeneration = queryGenerationRef.current;
    const pageCount = Math.max(1, Math.ceil(eventsRef.current.length / EVENT_FEED_PAGE_SIZE));
    setRefreshing(true);
    setLoading(eventsRef.current.length === 0);
    try {
      const [firstPage, count] = await Promise.all([
        apiClient.listEventFeed({
          unreadOnly: requestFilter === "unread",
          ...(requestCategory === "all" ? {} : { types: [...EVENT_TYPES_BY_CATEGORY[requestCategory]] }),
        }),
        apiClient.getEventFeedUnreadCount(),
        refreshPreference(),
      ]);
      const pages: EventFeedPage[] = [firstPage];
      let cursor = firstPage.nextCursor;
      while (pages.length < pageCount && cursor !== null) {
        const page = await apiClient.listEventFeed({
          cursor,
          unreadOnly: requestFilter === "unread",
          ...(requestCategory === "all" ? {} : { types: [...EVENT_TYPES_BY_CATEGORY[requestCategory]] }),
        });
        pages.push(page);
        cursor = page.nextCursor;
      }
      if (
        !activeRef.current
        || filterRef.current !== requestFilter
        || categoryRef.current !== requestCategory
        || queryGenerationRef.current !== queryGeneration
      ) return;
      const reconciled = reconcileEventFeedPages(
        eventsRef.current,
        pages.flatMap((page) => page.events),
        requestFilter === "unread",
      );
      eventsRef.current = reconciled.events;
      setEvents(reconciled.events);
      setPendingFirstPage(reconciled.pending);
      // When new head rows push older loaded rows outside the refreshed window,
      // keep the continuation of those older rows until the next explicit load.
      if (!reconciled.retainedOlder) setNextCursor(cursor);
      setUnreadCount(count.unreadCount);
      setStale(false);
      setError(null);
      void resolvePresentation(
        reconciled.pending === null
          ? reconciled.events
          : mergeUniqueEventFeedItems(reconciled.pending, reconciled.events),
        queryGeneration,
      );
    } catch (cause) {
      if (!activeRef.current || queryGenerationRef.current !== queryGeneration) return;
      setStale(eventsRef.current.length > 0 || unreadCountRef.current !== null);
      setError(failureMessage(cause, "Could not refresh Events."));
    } finally {
      if (activeRef.current && queryGenerationRef.current === queryGeneration) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [authenticatedHuman, refreshPreference, resolvePresentation, setPendingFirstPage, wsState]);

  const performRefreshRef = useRef(performRefresh);
  performRefreshRef.current = performRefresh;

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current !== null) {
      queuedRefreshRef.current = true;
      return refreshPromiseRef.current;
    }
    const run = async (): Promise<void> => {
      do {
        queuedRefreshRef.current = false;
        await runRequest(() => performRefreshRef.current());
      } while (activeRef.current && queuedRefreshRef.current);
    };
    const promise = run().finally(() => {
      if (refreshPromiseRef.current === promise) refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = promise;
    return promise;
  }, [runRequest]);

  const setFilter = useCallback((next: EventFeedFilter) => {
    if (next === filterRef.current) return;
    queryGenerationRef.current += 1;
    hydrationGenerationRef.current += 1;
    filterRef.current = next;
    setFilterState(next);
    eventsRef.current = [];
    setEvents([]);
    setPendingFirstPage(null);
    setNextCursor(null);
    setError(null);
    setScrollTop(0);
  }, [setPendingFirstPage]);

  const setCategory = useCallback((next: EventFeedCategory) => {
    if (next === categoryRef.current) return;
    queryGenerationRef.current += 1;
    hydrationGenerationRef.current += 1;
    categoryRef.current = next;
    setCategoryState(next);
    eventsRef.current = [];
    setEvents([]);
    setPendingFirstPage(null);
    setNextCursor(null);
    setError(null);
    setScrollTop(0);
  }, [setPendingFirstPage]);

  useEffect(() => {
    if (authenticatedHuman && wsState === "open") void refresh();
  }, [authenticatedHuman, category, credentialGeneration, filter, refresh, wsState]);

  useEffect(() => subscribeEventFeedChanged(() => {
    // This content-free hint also covers access/rename/delete invalidation for
    // Artifacts already referenced by the retained feed. Blank current labels
    // synchronously and fence older hydration before asking the server to
    // authorize each reference again.
    hydrationGenerationRef.current += 1;
    setArtifactsById(new Map());
    if (authenticatedHuman && wsState === "open") void refresh();
  }), [authenticatedHuman, refresh, wsState]);

  // Reuse the established Workbench notification-state recovery policy:
  // reconcile once per minute only while authenticated, connected, and visible.
  useEffect(() => {
    if (!authenticatedHuman || wsState !== "open") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, VISIBLE_SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [authenticatedHuman, refresh, wsState]);

  useEffect(() => {
    if (!authenticatedHuman) return;
    const onActivation = (): void => {
      if (document.visibilityState === "visible" && wsState === "open") void refresh();
    };
    window.addEventListener("focus", onActivation);
    document.addEventListener("visibilitychange", onActivation);
    window.addEventListener("nautilo:admission-resumed", onActivation);
    return () => {
      window.removeEventListener("focus", onActivation);
      document.removeEventListener("visibilitychange", onActivation);
      window.removeEventListener("nautilo:admission-resumed", onActivation);
    };
  }, [authenticatedHuman, refresh, wsState]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loadingMoreRef.current || !authenticatedHuman || wsState !== "open") return;
    const cursor = nextCursor;
    const requestFilter = filterRef.current;
    const requestCategory = categoryRef.current;
    const queryGeneration = queryGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    await runRequest(async () => {
      try {
        if (queryGenerationRef.current !== queryGeneration) return;
        const page = await apiClient.listEventFeed({
          cursor,
          unreadOnly: requestFilter === "unread",
          ...(requestCategory === "all" ? {} : { types: [...EVENT_TYPES_BY_CATEGORY[requestCategory]] }),
        });
        if (!activeRef.current || queryGenerationRef.current !== queryGeneration) return;
        const merged = mergeUniqueEventFeedItems(eventsRef.current, page.events);
        eventsRef.current = merged;
        setEvents(merged);
        setNextCursor(page.nextCursor);
        setError(null);
        void resolvePresentation(mergeUniqueEventFeedItems(pendingFirstPageRef.current ?? [], merged), queryGeneration);
      } catch (cause) {
        if (activeRef.current && queryGenerationRef.current === queryGeneration) {
          setError(failureMessage(cause, "Could not load more Events."));
        }
      } finally {
        loadingMoreRef.current = false;
        if (activeRef.current) setLoadingMore(false);
      }
    });
  }, [authenticatedHuman, nextCursor, resolvePresentation, runRequest, wsState]);

  const setReadState = useCallback(async (eventId: string, read: boolean): Promise<void> => {
    if (!authenticatedHuman || mutationTokenRef.current !== null) return;
    const token = {};
    mutationTokenRef.current = token;
    setBusyEventIds(new Set([eventId]));
    setMutationFailure(null);
    await runRequest(async () => {
      try {
        await apiClient.setEventFeedReadState(eventId, read);
        if (!activeRef.current) return;
        // Reconcile list and badge from the server together. No local clock or
        // counter arithmetic can misrepresent another session's read mutation.
        await performRefreshRef.current();
      } catch (cause) {
        if (activeRef.current) setMutationFailure({
          message: failureMessage(cause, "Could not change this event's read state."),
          retry: () => setReadState(eventId, read),
        });
      } finally {
        if (activeRef.current && mutationTokenRef.current === token) {
          mutationTokenRef.current = null;
          setBusyEventIds(new Set());
        }
      }
    });
  }, [authenticatedHuman, runRequest]);

  const markAllRead = useCallback(async (): Promise<void> => {
    if (!authenticatedHuman || mutationTokenRef.current !== null) return;
    const token = {};
    mutationTokenRef.current = token;
    setMarkingAllRead(true);
    setMutationFailure(null);
    await runRequest(async () => {
      try {
        await apiClient.markAllEventFeedRead();
        if (!activeRef.current) return;
        await performRefreshRef.current();
      } catch (cause) {
        if (activeRef.current) setMutationFailure({
          message: failureMessage(cause, "Could not mark all Events as read."),
          retry: markAllRead,
        });
      } finally {
        if (activeRef.current && mutationTokenRef.current === token) {
          mutationTokenRef.current = null;
          setMarkingAllRead(false);
        }
      }
    });
  }, [authenticatedHuman, runRequest]);

  const showPendingNewEvents = useCallback(() => {
    const pending = pendingFirstPageRef.current;
    if (pending === null) return;
    const merged = mergeUniqueEventFeedItems(pending, eventsRef.current);
    eventsRef.current = merged;
    setEvents(merged);
    setPendingFirstPage(null);
    setScrollTop(0);
  }, [setPendingFirstPage]);

  const reauthorizeArtifact = useCallback(async (artifactId: string): Promise<ArtifactDto | null> => {
    const hydrationGeneration = hydrationGenerationRef.current;
    try {
      const artifact = await apiClient.getWorkspaceArtifact(artifactId);
      if (!activeRef.current || hydrationGenerationRef.current !== hydrationGeneration) return null;
      setArtifactsById((current) => {
        const next = new Map(current);
        next.set(artifactId, artifact);
        return next;
      });
      return artifact;
    } catch {
      if (!activeRef.current || hydrationGenerationRef.current !== hydrationGeneration) return null;
      setArtifactsById((current) => {
        const next = new Map(current);
        next.set(artifactId, null);
        return next;
      });
      return null;
    }
  }, []);

  const value = useMemo<EventFeedContextValue>(() => ({
    unreadCount,
    quietPreference,
    quiet,
    preferenceError,
    savingPreference,
    setQuietPreference,
    refresh,
    events,
    filter,
    setFilter,
    category,
    setCategory,
    connected: wsState === "open",
    loading,
    refreshing,
    stale,
    error,
    nextCursor,
    loadingMore,
    loadMore,
    pendingNewEvents: pendingFirstPage !== null,
    showPendingNewEvents,
    setReadState,
    markAllRead,
    busyEventIds,
    markingAllRead,
    mutationFailure,
    clearMutationFailure: () => setMutationFailure(null),
    humansById,
    roomsById,
    artifactsById,
    reauthorizeArtifact,
    viewerActorId,
    scrollTop,
    setScrollTop,
  }), [
    artifactsById, busyEventIds, category, error, events, filter, humansById, loadMore, loading, loadingMore,
    markAllRead, markingAllRead, mutationFailure, nextCursor, pendingFirstPage,
    reauthorizeArtifact, refresh, refreshing, roomsById, scrollTop, setCategory, setFilter, setReadState,
    showPendingNewEvents, stale, unreadCount, viewerActorId, wsState,
    quietPreference, quiet, preferenceError, savingPreference, setQuietPreference,
  ]);

  return <EventFeedContext.Provider value={value}>{children}</EventFeedContext.Provider>;
}

export function useEventFeed(): EventFeedContextValue {
  const value = useContext(EventFeedContext);
  if (value === null) throw new Error("useEventFeed must be used within EventFeedProvider");
  return value;
}
