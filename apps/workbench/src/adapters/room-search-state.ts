import type {
  RoomMessageSearchCursor,
  RoomMessageSearchMode,
  RoomMessageSearchOptions,
  RoomMessageSearchPage,
} from "@nautilo/types";
import type {
  RoomMessageSearchController,
  RoomMessageSearchFetcher,
  RoomMessageSearchState,
} from "./runtime-contexts";
import { normalizeRoomSearchQuery } from "./room-search-query";

const DEFAULT_DEBOUNCE_MS = 200;
const PAGE_CACHE_LIMIT = 3;

type RequestDescriptor = {
  cursor: RoomMessageSearchCursor | null;
  asOf: RoomMessageSearchCursor | null;
};

function sameCursor(left: RoomMessageSearchCursor | null, right: RoomMessageSearchCursor | null): boolean {
  return left?.createdAt === right?.createdAt && left?.messageId === right?.messageId;
}

/**
 * D430's memory-only search controller. It knows nothing about React, transcript
 * messages, telemetry, or persistence: the runtime supplies the active Room
 * guard and observes snapshots through subscribe().
 */
export function createRoomMessageSearchController(args: {
  fetchPage: RoomMessageSearchFetcher;
  debounceMs?: number;
  getActiveRoomId?: () => string | null;
}): RoomMessageSearchController {
  let roomId: string | null = null;
  let query = "";
  let mode: RoomMessageSearchMode = "prefix";
  let ignoreCase = true;
  let status: RoomMessageSearchState["status"] = "idle";
  let generation = 0;
  let frozenAsOf: RoomMessageSearchCursor | null = null;
  let currentPageIndex = 0;
  let error: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: { generation: number; token: object } | null = null;
  const pages = new Map<number, RoomMessageSearchPage>();
  const descriptors = new Map<number, RequestDescriptor>([[0, { cursor: null, asOf: null }]]);
  const listeners = new Set<() => void>();
  const debounceMs = args.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const emit = (): void => { for (const listener of listeners) listener(); };
  const snapshot = (): RoomMessageSearchState => {
    const current = pages.get(currentPageIndex);
    return {
      roomId, query, mode, ignoreCase, status, generation, asOf: frozenAsOf, currentPageIndex,
      pages: [...pages.entries()].sort(([a], [b]) => a - b).map(([index, page]) => ({ index, page })),
      hits: current?.hits ?? [],
      hasMoreOlder: current?.hasMoreOlder === true || descriptors.has(currentPageIndex + 1),
      canLoadNewer: currentPageIndex > 0 && descriptors.has(currentPageIndex - 1),
      error,
    };
  };
  const cancelDebounce = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
  };
  const resetPages = (): void => {
    pages.clear(); descriptors.clear(); descriptors.set(0, { cursor: null, asOf: null });
    frozenAsOf = null; currentPageIndex = 0;
  };
  const currentRequest = (requestGeneration: number, requestRoomId: string): boolean =>
    generation === requestGeneration && roomId === requestRoomId &&
    (args.getActiveRoomId?.() ?? requestRoomId) === requestRoomId;
  const prunePages = (): void => {
    while (pages.size > PAGE_CACHE_LIMIT) {
      const candidate = [...pages.keys()]
        .filter((index) => index !== 0 && index !== currentPageIndex)
        .sort((a, b) => Math.abs(b - currentPageIndex) - Math.abs(a - currentPageIndex) || a - b)[0];
      if (candidate === undefined) return;
      pages.delete(candidate);
    }
  };

  const fetchIndex = async (pageIndex: number): Promise<boolean> => {
    const requestRoomId = roomId;
    const normalized = normalizeRoomSearchQuery(query);
    const descriptor = descriptors.get(pageIndex);
    if (!requestRoomId || !normalized.ok || !descriptor || inFlight?.generation === generation) return false;
    if (pageIndex > 0 && (!descriptor.cursor || !descriptor.asOf)) return false;
    const requestGeneration = generation;
    const requestMode = mode;
    const requestIgnoreCase = ignoreCase;
    const requestQuery = normalized.query;
    const options: RoomMessageSearchOptions = pageIndex === 0
      ? { roomId: requestRoomId, query: requestQuery, mode: requestMode, ignoreCase: requestIgnoreCase }
      : { roomId: requestRoomId, query: requestQuery, mode: requestMode, ignoreCase: requestIgnoreCase, cursor: descriptor.cursor!, asOf: descriptor.asOf! };
    status = "loading"; error = null; emit();
    const token = {};
    const promise = (async (): Promise<boolean> => {
      try {
        const page = await args.fetchPage(options);
        if (!currentRequest(requestGeneration, requestRoomId)) return false;
        if (pageIndex === 0) frozenAsOf = page.asOf;
        else if (!sameCursor(page.asOf, descriptor.asOf)) {
          status = "error"; error = "Search results changed; try the search again."; emit(); return false;
        }
        pages.set(pageIndex, page); currentPageIndex = pageIndex;
        if (page.hasMoreOlder && page.nextOlderCursor && page.asOf) {
          descriptors.set(pageIndex + 1, { cursor: page.nextOlderCursor, asOf: page.asOf });
        } else descriptors.delete(pageIndex + 1);
        prunePages(); status = page.hits.length === 0 ? "empty" : "ready"; error = null; emit(); return true;
      } catch {
        if (!currentRequest(requestGeneration, requestRoomId)) return false;
        status = "error"; error = "Search could not be completed."; emit(); return false;
      } finally {
        if (inFlight?.token === token) inFlight = null;
      }
    })();
    inFlight = { generation: requestGeneration, token };
    return promise;
  };
  const beginSearch = (): void => {
    generation += 1; cancelDebounce(); resetPages();
    const normalized = normalizeRoomSearchQuery(query);
    if (!roomId || !normalized.ok) {
      error = normalized.ok ? "" : normalized.error; status = error ? "invalid" : "idle"; emit(); return;
    }
    status = "debouncing"; error = null; emit();
    debounceTimer = setTimeout(() => { debounceTimer = null; void fetchIndex(0); }, debounceMs);
  };
  return {
    getSnapshot: snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    // A Room switch never carries a previous Room's query forward. This both
    // prevents an unintended request against the new Room and makes every
    // transcript-find session visibly scoped to the Room where it was opened.
    setRoomId: (next) => {
      if (roomId === next) return;
      roomId = next;
      query = "";
      generation += 1;
      cancelDebounce();
      resetPages();
      error = null;
      status = "idle";
      emit();
    },
    setQuery: (next) => { if (query !== next) { query = next; beginSearch(); } },
    setMode: (next) => { if (mode !== next) { mode = next; beginSearch(); } },
    setIgnoreCase: (next) => { if (ignoreCase !== next) { ignoreCase = next; beginSearch(); } },
    loadOlder: async () => {
      const index = currentPageIndex + 1;
      if (inFlight?.generation === generation || !descriptors.has(index)) return false;
      if (pages.has(index)) { currentPageIndex = index; status = "ready"; emit(); return true; }
      return fetchIndex(index);
    },
    loadNewer: async () => {
      const index = currentPageIndex - 1;
      if (index < 0 || inFlight?.generation === generation || !descriptors.has(index)) return false;
      if (pages.has(index)) { currentPageIndex = index; status = "ready"; emit(); return true; }
      return fetchIndex(index);
    },
    clear: () => { if (query.length !== 0 || status !== "idle") { query = ""; beginSearch(); } },
    dispose: () => { cancelDebounce(); listeners.clear(); },
  };
}
