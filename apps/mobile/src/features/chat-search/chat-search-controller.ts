import type {
  ChatSearchConversationHit,
  ChatSearchMessageHit,
  ChatSearchOptions,
  ChatSearchPage,
  RoomMessageSearchCursor,
} from "@nautilo/types";

const DEFAULT_DEBOUNCE_MS = 200;
const MAX_QUERY_CHARS = 256;
const MAX_TERMS = 16;
const MAX_MESSAGE_PAGES = 3;
const NAVIGATION_GUARD_MS = 750;

export type ChatSearchScope = {
  serverId: string;
  viewerActorId: string;
  /** Changes when Auth refreshes the signed-in viewer, even for the same Actor. */
  viewerEpoch: number;
};

export type ChatSearchStatus =
  | "idle"
  | "invalid"
  | "debouncing"
  | "loading"
  | "ready"
  | "empty"
  | "offline"
  | "error";

export type ChatSearchState = {
  scope: ChatSearchScope | null;
  query: string;
  status: ChatSearchStatus;
  conversations: readonly ChatSearchConversationHit[];
  conversationsTruncated: boolean;
  messages: readonly ChatSearchMessageHit[];
  hasMoreOlderMessages: boolean;
  pageLimitReached: boolean;
  loadingOlder: boolean;
  error: string | null;
};

export type ChatSearchFetcher = (
  scope: ChatSearchScope,
  options: ChatSearchOptions,
  signal: AbortSignal,
) => Promise<ChatSearchPage>;

export type ChatSearchController = {
  getSnapshot(): Readonly<ChatSearchState>;
  subscribe(listener: () => void): () => void;
  setScope(scope: ChatSearchScope | null): void;
  setQuery(query: string): void;
  retry(): Promise<boolean>;
  loadOlder(): Promise<boolean>;
  claimNavigation(key: string): boolean;
  /** Bounded local convergence after a catalogue mutation; never refetches. */
  applyRoomProjection(change: { roomId: string; label?: string; removed?: boolean }): void;
  dispose(): void;
};

type CachedPage = {
  messages: readonly ChatSearchMessageHit[];
  asOf: RoomMessageSearchCursor | null;
  nextOlderCursor: RoomMessageSearchCursor | null;
  hasMoreOlder: boolean;
};

function sameScope(left: ChatSearchScope | null, right: ChatSearchScope | null): boolean {
  return left?.serverId === right?.serverId &&
    left?.viewerActorId === right?.viewerActorId &&
    left?.viewerEpoch === right?.viewerEpoch;
}

export function validateChatSearchQuery(
  value: string,
): { ok: true; query: string } | { ok: false; error: string } {
  const query = value.trim();
  if (query.length === 0) return { ok: false, error: "" };
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: "Search queries must be at most 256 characters." };
  }
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) {
    return { ok: false, error: "Enter a search term containing letters or numbers." };
  }
  if (terms.length > MAX_TERMS) {
    return { ok: false, error: "Search queries may contain at most 16 terms." };
  }
  return { ok: true, query };
}

function errorKind(error: unknown): { status: "offline" | "error"; message: string } {
  const message = error instanceof Error ? error.message : "";
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : null;
  const looksOffline =
    error instanceof TypeError ||
    status === 0 ||
    /network|offline|failed to fetch|load failed|connection/i.test(message);
  if (looksOffline) {
    return {
      status: "offline",
      message: "Check your connection, then try again.",
    };
  }
  return {
    status: "error",
    message: status === 401
      ? "Your session ended. Sign in again."
      : "Search could not be completed. Try again.",
  };
}

function emptyState(scope: ChatSearchScope | null, query = ""): ChatSearchState {
  return {
    scope,
    query,
    status: "idle",
    conversations: [],
    conversationsTruncated: false,
    messages: [],
    hasMoreOlderMessages: false,
    pageLimitReached: false,
    loadingOlder: false,
    error: null,
  };
}

function uniqueMessages(pages: readonly CachedPage[]): ChatSearchMessageHit[] {
  const seen = new Set<string>();
  const messages: ChatSearchMessageHit[] = [];
  for (const page of pages) {
    for (const message of page.messages) {
      const key = `${message.roomId}:${message.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
    }
  }
  return messages;
}

/**
 * Memory-only Mobile controller for D470 Search all chats. It owns no durable
 * cache and never fans out by Room: every page is one `searchChats` request.
 */
export function createChatSearchController(args: {
  fetchPage: ChatSearchFetcher;
  debounceMs?: number;
  navigationGuardMs?: number;
}): ChatSearchController {
  let disposed = false;
  let generation = 0;
  let state = emptyState(null);
  let pages: CachedPage[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRequest: AbortController | null = null;
  let navigationClaim: string | null = null;
  let navigationTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const debounceMs = args.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const navigationGuardMs = args.navigationGuardMs ?? NAVIGATION_GUARD_MS;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const replace = (next: ChatSearchState): void => {
    state = next;
    emit();
  };
  const cancelPending = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    activeRequest?.abort();
    activeRequest = null;
  };
  const clearNavigationClaim = (): void => {
    if (navigationTimer !== null) clearTimeout(navigationTimer);
    navigationTimer = null;
    navigationClaim = null;
  };
  const current = (
    requestGeneration: number,
    requestScope: ChatSearchScope,
    requestQuery: string,
  ): boolean =>
    !disposed &&
    generation === requestGeneration &&
    sameScope(state.scope, requestScope) &&
    state.query === requestQuery;

  const fetchFirstPage = async (): Promise<boolean> => {
    const scope = state.scope;
    const normalized = validateChatSearchQuery(state.query);
    if (disposed || !scope || !normalized.ok) return false;
    const requestGeneration = generation;
    const requestQuery = state.query;
    const controller = new AbortController();
    activeRequest?.abort();
    activeRequest = controller;
    replace({ ...state, status: "loading", loadingOlder: false, error: null });
    try {
      const page = await args.fetchPage(
        scope,
        { query: normalized.query, mode: "prefix", ignoreCase: true, limit: 20 },
        controller.signal,
      );
      if (!current(requestGeneration, scope, requestQuery)) return false;
      pages = [{
        messages: page.messages,
        asOf: page.messageAsOf,
        nextOlderCursor: page.nextOlderMessageCursor,
        hasMoreOlder: page.hasMoreOlderMessages,
      }];
      const empty = page.conversations.length === 0 && page.messages.length === 0;
      replace({
        ...state,
        status: empty ? "empty" : "ready",
        conversations: page.conversations,
        conversationsTruncated: page.conversationsTruncated,
        messages: page.messages,
        hasMoreOlderMessages: page.hasMoreOlderMessages,
        pageLimitReached: false,
        loadingOlder: false,
        error: null,
      });
      return true;
    } catch (error) {
      if (!current(requestGeneration, scope, requestQuery) || controller.signal.aborted) {
        return false;
      }
      const failure = errorKind(error);
      replace({
        ...state,
        status: failure.status,
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        hasMoreOlderMessages: false,
        pageLimitReached: false,
        loadingOlder: false,
        error: failure.message,
      });
      return false;
    } finally {
      if (activeRequest === controller) activeRequest = null;
    }
  };

  const beginSearch = (): void => {
    generation += 1;
    cancelPending();
    pages = [];
    clearNavigationClaim();
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
    replace({
      ...emptyState(state.scope, state.query),
      status: "debouncing",
    });
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void fetchFirstPage();
    }, debounceMs);
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setScope(scope) {
      if (disposed || sameScope(state.scope, scope)) return;
      generation += 1;
      cancelPending();
      pages = [];
      clearNavigationClaim();
      replace(emptyState(scope));
    },
    setQuery(query) {
      if (disposed || state.query === query) return;
      state = { ...state, query };
      beginSearch();
    },
    retry() {
      if (disposed) return Promise.resolve(false);
      generation += 1;
      cancelPending();
      pages = [];
      clearNavigationClaim();
      return fetchFirstPage();
    },
    async loadOlder() {
      const scope = state.scope;
      const normalized = validateChatSearchQuery(state.query);
      const lastPage = pages[pages.length - 1];
      if (
        disposed ||
        !scope ||
        !normalized.ok ||
        state.loadingOlder ||
        pages.length >= MAX_MESSAGE_PAGES ||
        !lastPage?.hasMoreOlder ||
        !lastPage.nextOlderCursor ||
        !lastPage.asOf
      ) {
        if (pages.length >= MAX_MESSAGE_PAGES && lastPage?.hasMoreOlder) {
          replace({ ...state, pageLimitReached: true, hasMoreOlderMessages: false });
        }
        return false;
      }
      const requestGeneration = generation;
      const requestQuery = state.query;
      const controller = new AbortController();
      activeRequest = controller;
      replace({ ...state, loadingOlder: true, error: null });
      try {
        const page = await args.fetchPage(scope, {
          query: normalized.query,
          mode: "prefix",
          ignoreCase: true,
          limit: 20,
          cursor: lastPage.nextOlderCursor,
          asOf: lastPage.asOf,
        }, controller.signal);
        if (!current(requestGeneration, scope, requestQuery)) return false;
        pages = [...pages, {
          messages: page.messages,
          asOf: page.messageAsOf,
          nextOlderCursor: page.nextOlderMessageCursor,
          hasMoreOlder: page.hasMoreOlderMessages,
        }];
        const pageLimitReached = pages.length >= MAX_MESSAGE_PAGES && page.hasMoreOlderMessages;
        replace({
          ...state,
          status: "ready",
          conversations: page.conversations,
          conversationsTruncated: page.conversationsTruncated,
          messages: uniqueMessages(pages),
          hasMoreOlderMessages: page.hasMoreOlderMessages && !pageLimitReached,
          pageLimitReached,
          loadingOlder: false,
          error: null,
        });
        return true;
      } catch (error) {
        if (!current(requestGeneration, scope, requestQuery) || controller.signal.aborted) {
          return false;
        }
        const failure = errorKind(error);
        replace({
          ...state,
          status: failure.status,
          loadingOlder: false,
          error: failure.message,
        });
        return false;
      } finally {
        if (activeRequest === controller) activeRequest = null;
      }
    },
    claimNavigation(key) {
      if (disposed || !key || navigationClaim !== null) return false;
      navigationClaim = key;
      navigationTimer = setTimeout(() => {
        navigationTimer = null;
        navigationClaim = null;
      }, navigationGuardMs);
      return true;
    },
    applyRoomProjection(change) {
      if (disposed) return;
      const conversations = change.removed
        ? state.conversations.filter((hit) => hit.room.id !== change.roomId)
        : state.conversations.map((hit) =>
          hit.room.id === change.roomId && change.label !== undefined
            ? { ...hit, room: { ...hit.room, label: change.label } }
            : hit,
        );
      const messages = change.removed
        ? state.messages.filter((hit) => hit.roomId !== change.roomId && hit.parentRoomId !== change.roomId)
        : state.messages.map((hit) => {
          if (change.label === undefined) return hit;
          if (hit.roomId === change.roomId) return { ...hit, roomLabel: change.label };
          if (hit.parentRoomId === change.roomId) return { ...hit, parentRoomLabel: change.label };
          return hit;
        });
      if (conversations === state.conversations && messages === state.messages) return;
      replace({ ...state, conversations, messages });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelPending();
      pages = [];
      clearNavigationClaim();
      state = emptyState(null);
      listeners.clear();
    },
  };
}
