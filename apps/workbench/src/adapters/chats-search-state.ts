import type {
  ChatSearchOptions,
  ChatSearchPage,
  RoomMessageSearchCursor,
  RoomMessageSearchMode,
} from "@nautilo/types";
import type {
  ChatsSearchController,
  ChatsSearchFetcher,
  ChatsSearchScope,
  ChatsSearchState,
} from "./runtime-contexts";
import { normalizeRoomSearchQuery } from "./room-search-query";

const DEFAULT_DEBOUNCE_MS = 200;
const PAGE_CACHE_LIMIT = 3;

type RequestDescriptor = {
  cursor: RoomMessageSearchCursor | null;
  asOf: RoomMessageSearchCursor | null;
};

function sameCursor(
  left: RoomMessageSearchCursor | null,
  right: RoomMessageSearchCursor | null,
): boolean {
  return left?.createdAt === right?.createdAt && left?.messageId === right?.messageId;
}

function sameScope(left: ChatsSearchScope, right: ChatsSearchScope): boolean {
  return left.serverKey === right.serverKey &&
    left.viewerKey === right.viewerKey &&
    left.viewerGeneration === right.viewerGeneration;
}

function usableScope(scope: ChatsSearchScope): boolean {
  return Boolean(scope.serverKey && scope.viewerKey);
}

/**
 * D470's memory-only Chats-wide search controller. It owns bounded result
 * pages and request lifetimes, while React surfaces merely subscribe and issue
 * explicit query/page commands.
 */
export function createChatsSearchController(args: {
  fetchPage: ChatsSearchFetcher;
  debounceMs?: number;
}): ChatsSearchController {
  let scope: ChatsSearchScope = { serverKey: null, viewerKey: null, viewerGeneration: 0 };
  let query = "";
  let mode: RoomMessageSearchMode = "prefix";
  let ignoreCase = true;
  let status: ChatsSearchState["status"] = "idle";
  let generation = 0;
  let frozenMessageAsOf: RoomMessageSearchCursor | null = null;
  let currentMessagePageIndex = 0;
  let error: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: {
    generation: number;
    pageIndex: number;
    controller: AbortController;
  } | null = null;
  let retryPageIndex: number | null = null;
  let disposed = false;
  const pages = new Map<number, ChatSearchPage>();
  const descriptors = new Map<number, RequestDescriptor>([[0, { cursor: null, asOf: null }]]);
  const listeners = new Set<() => void>();
  const debounceMs = args.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const emit = (): void => {
    if (disposed) return;
    for (const listener of listeners) listener();
  };
  const snapshot = (): ChatsSearchState => {
    const current = pages.get(currentMessagePageIndex);
    return {
      scope,
      query,
      mode,
      ignoreCase,
      status,
      generation,
      messageAsOf: frozenMessageAsOf,
      currentMessagePageIndex,
      pages: [...pages.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, page]) => ({ index, page })),
      conversations: current?.conversations ?? [],
      conversationsTruncated: current?.conversationsTruncated ?? false,
      messages: current?.messages ?? [],
      hasMoreOlderMessages:
        current?.hasMoreOlderMessages === true || descriptors.has(currentMessagePageIndex + 1),
      canLoadNewerMessages:
        currentMessagePageIndex > 0 && descriptors.has(currentMessagePageIndex - 1),
      error,
    };
  };
  const cancelDebounce = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
  };
  const abortInFlight = (): void => {
    inFlight?.controller.abort();
    inFlight = null;
  };
  const resetPages = (): void => {
    pages.clear();
    descriptors.clear();
    descriptors.set(0, { cursor: null, asOf: null });
    frozenMessageAsOf = null;
    currentMessagePageIndex = 0;
    retryPageIndex = null;
  };
  const invalidate = (): void => {
    generation += 1;
    cancelDebounce();
    abortInFlight();
    resetPages();
  };
  const requestIsCurrent = (
    requestGeneration: number,
    requestScope: ChatsSearchScope,
  ): boolean => !disposed && generation === requestGeneration && sameScope(scope, requestScope);
  const prunePages = (): void => {
    while (pages.size > PAGE_CACHE_LIMIT) {
      const candidate = [...pages.keys()]
        .filter((index) => index !== 0 && index !== currentMessagePageIndex)
        .sort((left, right) =>
          Math.abs(right - currentMessagePageIndex) - Math.abs(left - currentMessagePageIndex) ||
          left - right,
        )[0];
      if (candidate === undefined) return;
      pages.delete(candidate);
    }
  };
  const statusForPage = (page: ChatSearchPage): ChatsSearchState["status"] =>
    page.conversations.length === 0 && page.messages.length === 0 ? "empty" : "ready";

  const fetchIndex = async (pageIndex: number): Promise<boolean> => {
    const normalized = normalizeRoomSearchQuery(query);
    const descriptor = descriptors.get(pageIndex);
    if (
      disposed ||
      !usableScope(scope) ||
      !normalized.ok ||
      !descriptor ||
      inFlight?.generation === generation
    ) {
      return false;
    }
    if (pageIndex > 0 && (!descriptor.cursor || !descriptor.asOf)) return false;

    const requestGeneration = generation;
    const requestScope = scope;
    const options: ChatSearchOptions = pageIndex === 0
      ? { query: normalized.query, mode, ignoreCase }
      : {
          query: normalized.query,
          mode,
          ignoreCase,
          cursor: descriptor.cursor!,
          asOf: descriptor.asOf!,
        };
    const controller = new AbortController();
    status = "loading";
    error = null;
    retryPageIndex = null;
    inFlight = { generation: requestGeneration, pageIndex, controller };
    emit();

    try {
      const page = await args.fetchPage(options, controller.signal);
      if (!requestIsCurrent(requestGeneration, requestScope)) return false;
      if (pageIndex === 0) {
        frozenMessageAsOf = page.messageAsOf;
      } else if (!sameCursor(page.messageAsOf, descriptor.asOf)) {
        status = "error";
        error = "Search results changed; try the search again.";
        retryPageIndex = pageIndex;
        emit();
        return false;
      }

      pages.set(pageIndex, page);
      currentMessagePageIndex = pageIndex;
      if (
        page.hasMoreOlderMessages &&
        page.nextOlderMessageCursor &&
        page.messageAsOf
      ) {
        descriptors.set(pageIndex + 1, {
          cursor: page.nextOlderMessageCursor,
          asOf: page.messageAsOf,
        });
      } else {
        descriptors.delete(pageIndex + 1);
      }
      prunePages();
      status = statusForPage(page);
      error = null;
      retryPageIndex = null;
      emit();
      return true;
    } catch (caught) {
      if (!requestIsCurrent(requestGeneration, requestScope)) return false;
      if (controller.signal.aborted || (caught instanceof Error && caught.name === "AbortError")) {
        return false;
      }
      status = "error";
      error = "Search could not be completed.";
      retryPageIndex = pageIndex;
      emit();
      return false;
    } finally {
      if (inFlight?.controller === controller) inFlight = null;
    }
  };

  const beginSearch = (): void => {
    invalidate();
    const normalized = normalizeRoomSearchQuery(query);
    if (!usableScope(scope) || !normalized.ok) {
      error = normalized.ok ? "" : normalized.error;
      status = error ? "invalid" : "idle";
      emit();
      return;
    }
    status = "debouncing";
    error = null;
    emit();
    const scheduledGeneration = generation;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (generation === scheduledGeneration) void fetchIndex(0);
    }, debounceMs);
  };

  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setScope: (nextScope) => {
      if (sameScope(scope, nextScope)) return;
      scope = nextScope;
      query = "";
      invalidate();
      status = "idle";
      error = null;
      emit();
    },
    setQuery: (nextQuery) => {
      if (query === nextQuery) return;
      query = nextQuery;
      beginSearch();
    },
    setMode: (nextMode) => {
      if (mode === nextMode) return;
      mode = nextMode;
      beginSearch();
    },
    setIgnoreCase: (nextIgnoreCase) => {
      if (ignoreCase === nextIgnoreCase) return;
      ignoreCase = nextIgnoreCase;
      beginSearch();
    },
    loadOlderMessages: async () => {
      const index = currentMessagePageIndex + 1;
      if (inFlight?.generation === generation || !descriptors.has(index)) return false;
      const cached = pages.get(index);
      if (cached) {
        currentMessagePageIndex = index;
        status = statusForPage(cached);
        error = null;
        emit();
        return true;
      }
      return fetchIndex(index);
    },
    loadNewerMessages: async () => {
      const index = currentMessagePageIndex - 1;
      if (index < 0 || inFlight?.generation === generation || !descriptors.has(index)) return false;
      const cached = pages.get(index);
      if (cached) {
        currentMessagePageIndex = index;
        status = statusForPage(cached);
        error = null;
        emit();
        return true;
      }
      return fetchIndex(index);
    },
    retry: () => retryPageIndex === null ? Promise.resolve(false) : fetchIndex(retryPageIndex),
    clear: () => {
      if (query.length === 0 && status === "idle") return;
      query = "";
      beginSearch();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelDebounce();
      abortInFlight();
      resetPages();
      listeners.clear();
    },
  };
}
