import { validateChatSearchQuery } from "@/features/chat-search/chat-search-controller";
import type {
  RoomMessageSearchHit,
  RoomMessageSearchOptions,
  RoomMessageSearchPage,
} from "@nautilo/types";

const DEFAULT_DEBOUNCE_MS = 200;
const MAX_PAGES = 3;

export type RoomSearchScope = {
  serverId: string;
  roomId: string;
  viewerActorId: string;
  viewerEpoch: number;
};

export type RoomSearchStatus =
  | "idle"
  | "invalid"
  | "debouncing"
  | "loading"
  | "ready"
  | "empty"
  | "offline"
  | "error";

export type RoomSearchState = {
  scope: RoomSearchScope | null;
  query: string;
  status: RoomSearchStatus;
  hits: readonly RoomMessageSearchHit[];
  selectedIndex: number;
  selectedHit: RoomMessageSearchHit | null;
  hasOlder: boolean;
  canMoveNewer: boolean;
  loadingOlder: boolean;
  pageLimitReached: boolean;
  error: string | null;
};

export type RoomSearchFetcher = (
  scope: RoomSearchScope,
  options: RoomMessageSearchOptions,
  signal: AbortSignal,
) => Promise<RoomMessageSearchPage>;

export type RoomMessageSearchController = {
  getSnapshot(): Readonly<RoomSearchState>;
  subscribe(listener: () => void): () => void;
  setScope(scope: RoomSearchScope | null): void;
  setQuery(query: string): void;
  retry(): Promise<boolean>;
  moveOlder(): Promise<boolean>;
  moveNewer(): boolean;
  clear(): void;
  dispose(): void;
};

function sameScope(left: RoomSearchScope | null, right: RoomSearchScope | null): boolean {
  return left?.serverId === right?.serverId &&
    left?.roomId === right?.roomId &&
    left?.viewerActorId === right?.viewerActorId &&
    left?.viewerEpoch === right?.viewerEpoch;
}

function emptyState(scope: RoomSearchScope | null, query = ""): RoomSearchState {
  return {
    scope,
    query,
    status: "idle",
    hits: [],
    selectedIndex: -1,
    selectedHit: null,
    hasOlder: false,
    canMoveNewer: false,
    loadingOlder: false,
    pageLimitReached: false,
    error: null,
  };
}

function failure(error: unknown): Pick<RoomSearchState, "status" | "error"> {
  const message = error instanceof Error ? error.message : "";
  const offline = error instanceof TypeError || /network|offline|failed to fetch|load failed/i.test(message);
  return offline
    ? { status: "offline", error: "Check your connection, then try again." }
    : { status: "error", error: "Search could not be completed. Try again." };
}

function uniqueHits(pages: readonly RoomMessageSearchPage[]): RoomMessageSearchHit[] {
  const seen = new Set<string>();
  const hits: RoomMessageSearchHit[] = [];
  for (const page of pages) {
    for (const hit of page.hits) {
      if (seen.has(hit.messageId)) continue;
      seen.add(hit.messageId);
      hits.push(hit);
    }
  }
  return hits;
}

/** Memory-only Mobile D430 controller; transcript hydration remains elsewhere. */
export function createRoomMessageSearchController(args: {
  fetchPage: RoomSearchFetcher;
  debounceMs?: number;
}): RoomMessageSearchController {
  let disposed = false;
  let generation = 0;
  let state = emptyState(null);
  let pages: RoomMessageSearchPage[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRequest: AbortController | null = null;
  const listeners = new Set<() => void>();
  const debounceMs = args.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const emit = (): void => { for (const listener of listeners) listener(); };
  const replace = (next: RoomSearchState): void => { state = next; emit(); };
  const cancel = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    activeRequest?.abort();
    activeRequest = null;
  };
  const isCurrent = (requestGeneration: number, scope: RoomSearchScope, query: string): boolean =>
    !disposed && generation === requestGeneration && sameScope(state.scope, scope) && state.query === query;

  const fetchFirst = async (): Promise<boolean> => {
    const scope = state.scope;
    const normalized = validateChatSearchQuery(state.query);
    if (!scope || !normalized.ok || disposed) return false;
    const requestGeneration = generation;
    const requestQuery = state.query;
    const controller = new AbortController();
    activeRequest?.abort();
    activeRequest = controller;
    replace({ ...state, status: "loading", loadingOlder: false, error: null });
    try {
      const page = await args.fetchPage(scope, {
        roomId: scope.roomId,
        query: normalized.query,
        mode: "prefix",
        ignoreCase: true,
        limit: 20,
      }, controller.signal);
      if (!isCurrent(requestGeneration, scope, requestQuery)) return false;
      pages = [page];
      const hits = page.hits;
      replace({
        ...state,
        status: hits.length === 0 ? "empty" : "ready",
        hits,
        selectedIndex: hits.length > 0 ? 0 : -1,
        selectedHit: hits[0] ?? null,
        hasOlder: page.hasMoreOlder,
        canMoveNewer: false,
        loadingOlder: false,
        pageLimitReached: false,
        error: null,
      });
      return true;
    } catch (error) {
      if (!isCurrent(requestGeneration, scope, requestQuery) || controller.signal.aborted) return false;
      const failed = failure(error);
      pages = [];
      replace({ ...emptyState(scope, state.query), ...failed });
      return false;
    } finally {
      if (activeRequest === controller) activeRequest = null;
    }
  };

  const begin = (): void => {
    generation += 1;
    cancel();
    pages = [];
    const normalized = validateChatSearchQuery(state.query);
    const invalidError = normalized.ok ? "" : normalized.error;
    if (!state.scope || !normalized.ok) {
      replace({
        ...emptyState(state.scope, state.query),
        status: invalidError ? "invalid" : "idle",
        error: invalidError || null,
      });
      return;
    }
    replace({ ...emptyState(state.scope, state.query), status: "debouncing" });
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void fetchFirst();
    }, debounceMs);
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setScope(scope) {
      if (disposed || sameScope(state.scope, scope)) return;
      generation += 1;
      cancel();
      pages = [];
      replace(emptyState(scope));
    },
    setQuery(query) {
      if (disposed || state.query === query) return;
      state = { ...state, query };
      begin();
    },
    retry() {
      if (disposed) return Promise.resolve(false);
      generation += 1;
      cancel();
      pages = [];
      return fetchFirst();
    },
    async moveOlder() {
      if (disposed || state.loadingOlder || state.selectedIndex < 0) return false;
      if (state.selectedIndex + 1 < state.hits.length) {
        const selectedIndex = state.selectedIndex + 1;
        replace({
          ...state,
          selectedIndex,
          selectedHit: state.hits[selectedIndex] ?? null,
          canMoveNewer: true,
        });
        return true;
      }
      const scope = state.scope;
      const normalized = validateChatSearchQuery(state.query);
      const last = pages[pages.length - 1];
      if (!scope || !normalized.ok || !last?.hasMoreOlder || !last.nextOlderCursor || !last.asOf) return false;
      if (pages.length >= MAX_PAGES) {
        replace({ ...state, hasOlder: false, pageLimitReached: true });
        return false;
      }
      const requestGeneration = generation;
      const requestQuery = state.query;
      const controller = new AbortController();
      activeRequest = controller;
      replace({ ...state, loadingOlder: true, error: null });
      try {
        const page = await args.fetchPage(scope, {
          roomId: scope.roomId,
          query: normalized.query,
          mode: "prefix",
          ignoreCase: true,
          limit: 20,
          cursor: last.nextOlderCursor,
          asOf: last.asOf,
        }, controller.signal);
        if (!isCurrent(requestGeneration, scope, requestQuery)) return false;
        pages = [...pages, page];
        const hits = uniqueHits(pages);
        const selectedIndex = Math.min(state.selectedIndex + 1, hits.length - 1);
        const pageLimitReached = pages.length >= MAX_PAGES && page.hasMoreOlder;
        replace({
          ...state,
          status: "ready",
          hits,
          selectedIndex,
          selectedHit: hits[selectedIndex] ?? null,
          hasOlder: page.hasMoreOlder && !pageLimitReached,
          canMoveNewer: selectedIndex > 0,
          loadingOlder: false,
          pageLimitReached,
          error: null,
        });
        return true;
      } catch (error) {
        if (!isCurrent(requestGeneration, scope, requestQuery) || controller.signal.aborted) return false;
        const failed = failure(error);
        replace({ ...state, ...failed, loadingOlder: false });
        return false;
      } finally {
        if (activeRequest === controller) activeRequest = null;
      }
    },
    moveNewer() {
      if (disposed || state.loadingOlder || state.selectedIndex <= 0) return false;
      const selectedIndex = state.selectedIndex - 1;
      replace({
        ...state,
        status: "ready",
        selectedIndex,
        selectedHit: state.hits[selectedIndex] ?? null,
        canMoveNewer: selectedIndex > 0,
        error: null,
      });
      return true;
    },
    clear() {
      if (disposed || (state.query === "" && state.status === "idle")) return;
      state = { ...state, query: "" };
      begin();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancel();
      pages = [];
      state = emptyState(null);
      listeners.clear();
    },
  };
}
