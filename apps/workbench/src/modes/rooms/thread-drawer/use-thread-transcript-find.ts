import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createRoomHistoryAroundController } from "../../../adapters/room-history-around";
import { createRoomMessageSearchController } from "../../../adapters/room-search-state";
import type { RoomMessageSearchControls } from "../../../adapters/runtime-contexts";
import { restoreSessionMessages } from "../../../adapters/session-rehydrate";
import {
  createConversationNavigationController,
  returnConversationToLatest,
  waitForConversationCommit,
  waitForConversationTarget,
  type ConversationJumpOutcome,
  type ConversationJumpState,
} from "../../../components/conversation-navigation";
import {
  transitionConversationViewport,
  type ConversationViewportMode,
} from "../../../components/conversation-viewport";
import {
  createRoomFindActivationController,
  type RoomFindActivationState,
} from "../../../components/rooms/room-transcript-find-activation";
import {
  moveRoomFindSelection,
  reconcileRoomFindSelection,
  roomFindTotalLabel,
  type FindDirection,
  type RoomFindSelection,
} from "../../../components/rooms/room-transcript-find-navigation";
import type { TranscriptWindowHandle } from "../../../components/transcript-window";
import { apiClient } from "../../../lib/api";
import type { ThreadRoomAction, ThreadRoomControllerState, ThreadRoomMessage } from "./thread-room-controller";

export interface ThreadTranscriptViewportApi {
  isAtBottom: () => boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

interface UseThreadTranscriptFindOptions {
  roomId: string;
  state: ThreadRoomControllerState;
  dispatch: (action: ThreadRoomAction) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  transcriptHandleRef: RefObject<TranscriptWindowHandle | null>;
  viewportApiRef: RefObject<ThreadTranscriptViewportApi | null>;
}

/** Child-Room composition of D430's existing search, history, and navigation primitives. */
export function useThreadTranscriptFind({
  roomId,
  state,
  dispatch,
  viewportRef,
  transcriptHandleRef,
  viewportApiRef,
}: UseThreadTranscriptFindOptions) {
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  const stateRef = useRef(state);
  stateRef.current = state;

  const searchControllerRef = useRef<ReturnType<typeof createRoomMessageSearchController> | null>(null);
  if (!searchControllerRef.current) {
    searchControllerRef.current = createRoomMessageSearchController({
      fetchPage: (options) => apiClient.searchRoomMessages(options),
      getActiveRoomId: () => roomIdRef.current,
    });
  }
  const searchController = searchControllerRef.current;
  const [searchState, setSearchState] = useState(searchController.getSnapshot);
  useEffect(
    () => searchController.subscribe(() => setSearchState(searchController.getSnapshot())),
    [searchController],
  );
  const search = useMemo<RoomMessageSearchControls>(() => ({
    ...searchState,
    setQuery: searchController.setQuery,
    setMode: searchController.setMode,
    setIgnoreCase: searchController.setIgnoreCase,
    loadOlder: searchController.loadOlder,
    loadNewer: searchController.loadNewer,
    clear: searchController.clear,
  }), [searchController, searchState]);
  const searchRef = useRef(search);
  searchRef.current = search;

  const aroundControllerRef = useRef<ReturnType<typeof createRoomHistoryAroundController> | null>(null);
  if (!aroundControllerRef.current) {
    aroundControllerRef.current = createRoomHistoryAroundController({
      fetchPage: (options) => apiClient.getRoomMessagesAround(options),
      getActiveRoomId: () => roomIdRef.current,
      isMessageLoaded: (messageId) => stateRef.current.runtimeMessages.some(
        (message) => String(message.id) === messageId,
      ),
      onPage: (page) => {
        const messages: ThreadRoomMessage[] = page.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.sourceUserId ? { sourceUserId: message.sourceUserId } : {}),
          ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
          ...(message.replyToMessageId !== undefined
            ? { replyToMessageId: message.replyToMessageId }
            : {}),
        }));
        dispatch({
          type: "history.aroundMerged",
          roomId: roomIdRef.current,
          messages,
          runtimeMessages: restoreSessionMessages(page.messages),
        });
      },
    });
  }
  const aroundController = aroundControllerRef.current;

  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<RoomFindSelection | null>(null);
  const [boundaryMessage, setBoundaryMessage] = useState<string | null>(null);
  const [activationState, setActivationState] = useState<RoomFindActivationState>({ state: "idle" });
  const [jumpState, setJumpState] = useState<ConversationJumpState>({ state: "idle" });
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [viewportMode, setViewportMode] = useState<ConversationViewportMode>("following");
  const [viewportReadyRoomId, setViewportReadyRoomId] = useState(roomId);
  const followingLiveEdge = viewportReadyRoomId === roomId &&
    (viewportMode === "following" || viewportMode === "returning");
  const awayFromLatest = viewportMode === "reader-away" || viewportMode === "target-pinned";
  const onViewportAtBottomChange = useCallback((
    atLiveEdge: boolean,
    origin: "layout" | "human" = "layout",
  ) => {
    setViewportMode((mode) =>
      transitionConversationViewport(mode, { type: "viewport-observed", atLiveEdge, origin }));
  }, []);
  const openRef = useRef(open);
  openRef.current = open;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const previousGenerationRef = useRef(search.generation);
  const openerRef = useRef<HTMLElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const navigationControllerRef = useRef<ReturnType<typeof createConversationNavigationController> | null>(null);
  if (!navigationControllerRef.current) {
    navigationControllerRef.current = createConversationNavigationController({
      getActiveRoomId: () => roomIdRef.current,
      materializeById: (messageId) => transcriptHandleRef.current?.materializeById(messageId) ?? false,
      loadHistoryAround: (messageId) => aroundController.load(messageId),
      waitForCommit: waitForConversationCommit,
      scrollAndFocus: async (messageId, focusTarget) => {
        const findTarget = (): HTMLElement | null =>
          viewportRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) ?? null;
        let target = findTarget();
        if (!target && viewportRef.current) {
          target = await waitForConversationTarget({
            findTarget,
            subscribe: (notify) => {
              const observer = new MutationObserver(notify);
              observer.observe(viewportRef.current!, { childList: true, subtree: true });
              return () => observer.disconnect();
            },
            setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
            clearFallback: (handle) => clearTimeout(handle),
          });
        }
        if (!target) {
          transcriptHandleRef.current?.releaseMaterializedTarget(messageId);
          return false;
        }
        target.scrollIntoView({ behavior: "auto", block: "center" });
        if (focusTarget) target.focus({ preventScroll: true });
        transcriptHandleRef.current?.releaseMaterializedTarget(messageId);
        return true;
      },
      onState: setJumpState,
      onCompleted: (messageId) => {
        setViewportMode((mode) =>
          transitionConversationViewport(mode, { type: "target-navigation" }));
        setHighlightedMessageId(messageId);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
      },
    });
  }
  const navigationController = navigationControllerRef.current;

  const activationControllerRef = useRef<ReturnType<typeof createRoomFindActivationController> | null>(null);
  if (!activationControllerRef.current) {
    activationControllerRef.current = createRoomFindActivationController({
      jumpToMessage: navigationController.jumpToMessage,
      isCurrent: (request) => openRef.current &&
        request.roomId === roomIdRef.current &&
        request.generation === searchRef.current.generation &&
        request.messageId === selectionRef.current?.messageId,
      onState: setActivationState,
    });
  }
  const activationController = activationControllerRef.current;

  useEffect(() => {
    searchController.setRoomId(roomId);
    aroundController.setRoomId(roomId);
    setOpen(false);
    setSelection(null);
    setBoundaryMessage(null);
    setViewportMode((mode) =>
      transitionConversationViewport(mode, {
        type: "room-switch",
        restoredAtLiveEdge: true,
      }));
    setViewportReadyRoomId(roomId);
    navigationController.supersede();
    activationController.supersede();
  }, [activationController, aroundController, navigationController, roomId, searchController]);

  useEffect(() => () => {
    searchController.dispose();
    aroundController.dispose();
    navigationController.supersede();
    activationController.supersede();
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, [activationController, aroundController, navigationController, searchController]);

  useEffect(() => {
    const previousGeneration = previousGenerationRef.current;
    const queryChanged = previousGeneration !== search.generation;
    setSelection((current) => reconcileRoomFindSelection({
      previousGeneration,
      generation: search.generation,
      query: search.query,
      selection: current,
      search,
    }));
    previousGenerationRef.current = search.generation;
    setBoundaryMessage(null);
    if (queryChanged) activationController.supersede();
  }, [activationController, search]);

  useEffect(() => {
    if (!open || !selection || jumpState.state === "loading") return;
    void activationController.activate({
      roomId,
      generation: search.generation,
      messageId: selection.messageId,
    });
  }, [activationController, jumpState.state, open, roomId, search.generation, selection]);

  const openFind = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    const current = searchRef.current;
    setSelection((selected) => reconcileRoomFindSelection({
      previousGeneration: current.generation,
      generation: current.generation,
      query: current.query,
      selection: selected,
      search: current,
    }));
    setBoundaryMessage(null);
    setOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    activationController.supersede();
    setOpen(false);
    setSelection(null);
    setBoundaryMessage(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  }, [activationController]);
  const move = useCallback(async (direction: FindDirection): Promise<void> => {
    const result = await moveRoomFindSelection({
      selection: selectionRef.current,
      direction,
      getSearch: () => searchRef.current,
    });
    if (result.kind === "selected") {
      setSelection(result.selection);
      setBoundaryMessage(null);
    } else if (result.kind === "boundary") {
      setBoundaryMessage(result.direction === "older"
        ? "No older search results."
        : "No newer search results.");
    }
  }, []);
  const retryActivation = useCallback(() => {
    const selected = selectionRef.current;
    if (!selected) return;
    void activationController.retry({
      roomId: roomIdRef.current,
      generation: searchRef.current.generation,
      messageId: selected.messageId,
    });
  }, [activationController]);
  const jumpToMessage = useCallback(
    (messageId: number): Promise<ConversationJumpOutcome> => navigationController.jumpToMessage(messageId),
    [navigationController],
  );
  const returnToLatest = useCallback(() => {
    setViewportMode((mode) =>
      transitionConversationViewport(mode, { type: "return-to-latest" }));
    returnConversationToLatest({
      supersede: navigationController.supersede,
      followTail: () => transcriptHandleRef.current?.followTail(),
      clearNavigation: () => {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setHighlightedMessageId(null);
      },
      scheduleTailScroll: () => {
        const api = viewportApiRef.current;
        if (!api) {
          onViewportAtBottomChange(false);
          return;
        }
        api.scrollToBottom("instant");
        requestAnimationFrame(() => onViewportAtBottomChange(api.isAtBottom()));
      },
    });
  }, [navigationController, onViewportAtBottomChange, transcriptHandleRef, viewportApiRef]);

  return {
    search,
    open,
    openFind,
    closeFind,
    selection,
    totalLabel: roomFindTotalLabel({ selection, search }),
    move,
    boundaryMessage,
    activationState,
    retryActivation,
    jumpToMessage,
    returnToLatest,
    onViewportAtBottomChange,
    followingLiveEdge,
    awayFromLatest,
    jumpState,
    highlightedMessageId,
  };
}
