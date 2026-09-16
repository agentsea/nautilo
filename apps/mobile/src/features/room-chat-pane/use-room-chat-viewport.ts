import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ViewToken,
} from "react-native";

import {
  createRoomChatViewportState,
  isAtInvertedLiveEdge,
  isRoomChatViewportAway,
  isViewportAtLiveEdge,
  leadingInsertedKeys,
  maySettleLatestReturn,
  nextLatestScrollCommand,
  reduceRoomChatViewport,
} from "@/features/room-chat-pane/viewport-state";
import type { ChatItem } from "@/lib/messages";

type RoomChatViewportOptions = {
  scopeKey: string;
  renderItems: readonly ChatItem[];
  keyExtractor: (item: ChatItem) => string;
  listRef: RefObject<FlatList<ChatItem> | null>;
  latestRequest: {
    id: number;
    origin: "control" | "local-send";
    awaitContentCommit: boolean;
  };
  onHumanReachedLiveEdge: () => void;
};

const VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 1,
} as const;

const MAINTAIN_VISIBLE_CONTENT_POSITION = {
  minIndexForVisible: 0,
  // In an inverted chat, native offset zero is the newest edge. RN 0.86 keeps
  // the first visible stable child fixed while away and follows within this
  // threshold without a JS scroll writer on each streamed token.
  autoscrollToTopThreshold: 24,
} as const;

// Inverted row zero grows toward the reader without changing its origin.
// Anchor the next native child instead: its origin moves by that growth, so
// native MVCP compensates in the same mount, including during momentum.
// The list's persistent footer supplies that child for a one-row transcript.
const MAINTAIN_READER_POSITION = { minIndexForVisible: 1 } as const;

/**
 * The native adapter deliberately owns viewport state only. Room messages,
 * realtime reconciliation, tools, and navigation remain in the existing
 * controller; @assistant-ui/react-native is not installed and would introduce
 * a second runtime/store boundary for this screen.
 */
export function useRoomChatViewport({
  scopeKey,
  renderItems,
  keyExtractor,
  listRef,
  latestRequest,
  onHumanReachedLiveEdge,
}: RoomChatViewportOptions) {
  const [state, dispatch] = useReducer(
    reduceRoomChatViewport,
    scopeKey,
    createRoomChatViewportState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const currentOffsetRef = useRef(0);
  const [nativeGeometry, setNativeGeometry] = useState<{
    scopeKey: string;
    atLiveEdge: boolean;
  } | null>(null);
  const nativeGeometryRef = useRef(nativeGeometry);
  nativeGeometryRef.current = nativeGeometry;
  // Mounting/remounting creates a fresh offset-zero list. Do not replay a
  // request that was already issued while this viewport did not exist.
  const appliedLatestRequestIdRef = useRef(latestRequest.id);
  const humanScrollActiveRef = useRef(false);
  const humanScrollResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnSettlementFrameRef = useRef<number | null>(null);
  const returnProbeFinalFrameRef = useRef<number | null>(null);
  const pendingReturnRef = useRef<{
    requestId: number;
    origin: "control" | "local-send";
    contentCommitted: boolean;
  } | null>(null);
  const visibleAnchorKeyRef = useRef<string | null>(null);
  const previousRowsRef = useRef<{ scopeKey: string; keys: string[] }>({
    scopeKey,
    keys: renderItems.map(keyExtractor),
  });
  const callbacksRef = useRef({ onHumanReachedLiveEdge });
  callbacksRef.current = { onHumanReachedLiveEdge };

  useEffect(() => {
    const keys = renderItems.map(keyExtractor);
    const previous = previousRowsRef.current;
    if (previous.scopeKey !== scopeKey) {
      previousRowsRef.current = { scopeKey, keys };
      visibleAnchorKeyRef.current = null;
      currentOffsetRef.current = 0;
      pendingReturnRef.current = null;
      if (returnSettlementFrameRef.current != null) {
        cancelAnimationFrame(returnSettlementFrameRef.current);
        returnSettlementFrameRef.current = null;
      }
      if (returnProbeFinalFrameRef.current != null) {
        cancelAnimationFrame(returnProbeFinalFrameRef.current);
        returnProbeFinalFrameRef.current = null;
      }
      // A request belongs to the scope in which it was issued. Consume the
      // current id without replaying that prior Room's return in this one.
      appliedLatestRequestIdRef.current = latestRequest.id;
      setNativeGeometry((current) => current?.scopeKey === scopeKey ? current : null);
      dispatch({ type: "scope-changed", scopeKey });
      return;
    }

    const inserted = new Set(leadingInsertedKeys(previous.keys, keys));
    if (inserted.size > 0) {
      dispatch({
        type: "new-visible-messages",
        hasActivity: true,
        messageKeys: renderItems.flatMap((item) => {
          if (item.kind !== "message") return [];
          const key = keyExtractor(item);
          return inserted.has(key) ? [key] : [];
        }),
      });
    }
    previousRowsRef.current = { scopeKey, keys };
  }, [keyExtractor, latestRequest.id, renderItems, scopeKey]);

  useEffect(() => () => {
    if (humanScrollResetTimerRef.current) clearTimeout(humanScrollResetTimerRef.current);
    if (returnSettlementFrameRef.current != null) {
      cancelAnimationFrame(returnSettlementFrameRef.current);
    }
    if (returnProbeFinalFrameRef.current != null) {
      cancelAnimationFrame(returnProbeFinalFrameRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const command = nextLatestScrollCommand({
      appliedRequestId: appliedLatestRequestIdRef.current,
      request: latestRequest,
      hasRows: renderItems.length > 0,
    });
    if (!command) return;
    appliedLatestRequestIdRef.current = command.requestId;
    pendingReturnRef.current = {
      requestId: command.requestId,
      origin: command.origin,
      contentCommitted: !latestRequest.awaitContentCommit,
    };
    dispatch({ type: "return-requested", origin: command.origin });
    if (!latestRequest.awaitContentCommit) {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      if (
        nativeGeometryRef.current?.scopeKey === scopeKey &&
        nativeGeometryRef.current.atLiveEdge
      ) {
        pendingReturnRef.current = null;
        dispatch({ type: "return-arrived" });
      }
    }
  }, [
    latestRequest.awaitContentCommit,
    latestRequest.id,
    latestRequest.origin,
    listRef,
    renderItems.length,
    scopeKey,
  ]);

  const recordNativeGeometry = useCallback((atLiveEdge: boolean) => {
    setNativeGeometry((current) =>
      current?.scopeKey === scopeKey && current.atLiveEdge === atLiveEdge
        ? current
        : { scopeKey, atLiveEdge },
    );
  }, [scopeKey]);

  const onViewableItemsChanged = useCallback((info: {
    viewableItems: ViewToken<ChatItem>[];
  }) => {
    const anchor = info.viewableItems
      .filter((token) => token.isViewable && token.index != null)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))[0]?.item;
    visibleAnchorKeyRef.current = anchor ? keyExtractor(anchor) : null;
  }, [keyExtractor]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    currentOffsetRef.current = offsetY;
    const atLiveEdge = isAtInvertedLiveEdge(offsetY);
    recordNativeGeometry(atLiveEdge);
    const mode = stateRef.current.mode;

    const pendingReturn = pendingReturnRef.current;
    if (pendingReturn && maySettleLatestReturn({
      origin: pendingReturn.origin,
      contentCommitted: pendingReturn.contentCommitted,
      nativeAtLiveEdge: atLiveEdge,
    })) {
      if (returnSettlementFrameRef.current != null) {
        cancelAnimationFrame(returnSettlementFrameRef.current);
        returnSettlementFrameRef.current = null;
      }
      pendingReturnRef.current = null;
      dispatch({ type: "return-arrived" });
      return;
    }

    if (atLiveEdge) {
      if (
        humanScrollActiveRef.current &&
        (mode === "reader-away" || mode === "target-pinned")
      ) {
        dispatch({ type: "reader-reached-live-edge" });
        callbacksRef.current.onHumanReachedLiveEdge();
      }
      return;
    }

    if (humanScrollActiveRef.current) {
      dispatch({
        type: "reader-scrolled-away",
        anchorKey: visibleAnchorKeyRef.current,
      });
    }
  }, [recordNativeGeometry]);

  const onScrollBeginDrag = useCallback(() => {
    if (humanScrollResetTimerRef.current) clearTimeout(humanScrollResetTimerRef.current);
    humanScrollActiveRef.current = true;
  }, []);

  const onMomentumScrollBegin = useCallback(() => {
    // Programmatic return/search animations also emit momentum callbacks.
    // Only extend an interaction that began with a Human drag.
    if (!humanScrollActiveRef.current) return;
    if (humanScrollResetTimerRef.current) clearTimeout(humanScrollResetTimerRef.current);
  }, []);

  const onScrollEndDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScroll(event);
    if (humanScrollResetTimerRef.current) clearTimeout(humanScrollResetTimerRef.current);
    humanScrollResetTimerRef.current = setTimeout(() => {
      humanScrollActiveRef.current = false;
    }, 400);
  }, [onScroll]);

  const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScroll(event);
    humanScrollActiveRef.current = false;
  }, [onScroll]);

  const pinTarget = useCallback((anchorKey: string) => {
    dispatch({ type: "target-navigation", anchorKey });
  }, []);

  const onContentSizeChange = useCallback(() => {
    // Default inverted-list offset is zero. Treat the first native layout as
    // the initial geometry observation. Layout never changes follow intent,
    // but its last measured offset still gates read truth and recovery UI.
    const atLiveEdge = isAtInvertedLiveEdge(currentOffsetRef.current);
    recordNativeGeometry(atLiveEdge);
    const pendingReturn = pendingReturnRef.current;
    if (pendingReturn?.origin === "local-send" && !pendingReturn.contentCommitted) {
      pendingReturnRef.current = { ...pendingReturn, contentCommitted: true };
      // This callback is the first proof that the optimistic/persisted local
      // row reached native layout. Settle the same one-shot request only now,
      // after inverted MVCP has finished preserving the historical anchor.
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      if (returnSettlementFrameRef.current != null) {
        cancelAnimationFrame(returnSettlementFrameRef.current);
      }
      const requestId = pendingReturn.requestId;
      returnSettlementFrameRef.current = requestAnimationFrame(() => {
        returnSettlementFrameRef.current = null;
        const stillPending = pendingReturnRef.current;
        if (
          stillPending?.requestId !== requestId ||
          !stillPending.contentCommitted
        ) return;
        // A distinct one-pixel live-edge probe forces a real onScroll even if
        // Fabric already sits at offset zero and treats another zero as a
        // no-op. Only that measured event settles; the following frame snaps
        // the imperceptible probe back to exact zero.
        listRef.current?.scrollToOffset({ offset: 1, animated: false });
        returnProbeFinalFrameRef.current = requestAnimationFrame(() => {
          returnProbeFinalFrameRef.current = null;
          if (
            previousRowsRef.current.scopeKey !== scopeKey ||
            appliedLatestRequestIdRef.current !== requestId
          ) return;
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        });
      });
      return;
    }
  }, [listRef, recordNativeGeometry]);

  const atLiveEdge = isViewportAtLiveEdge({
    currentScopeKey: scopeKey,
    stateScopeKey: state.scopeKey,
    geometryScopeKey: nativeGeometry?.scopeKey ?? null,
    nativeAtLiveEdge: nativeGeometry?.atLiveEdge ?? false,
    mode: state.mode,
  });
  return useMemo(() => ({
    state,
    atLiveEdge,
    // Native layout can briefly measure off-edge while an inverted FlatList
    // commits streamed/tool content and applies its own tail correction. Only
    // deliberate reader-away or target-navigation intent earns this control.
    awayFromLiveEdge: isRoomChatViewportAway(state.mode),
    newMessageCount: state.newMessageKeys.length,
    hasNewActivity: state.hasNewActivity,
    maintainVisibleContentPosition: state.scopeKey === scopeKey && isRoomChatViewportAway(state.mode)
      ? MAINTAIN_READER_POSITION
      : MAINTAIN_VISIBLE_CONTENT_POSITION,
    viewabilityConfig: VIEWABILITY_CONFIG,
    onViewableItemsChanged,
    onScroll,
    onScrollBeginDrag,
    onMomentumScrollBegin,
    onScrollEndDrag,
    onMomentumScrollEnd,
    onContentSizeChange,
    pinTarget,
  }), [
    atLiveEdge,
    onMomentumScrollEnd,
    onMomentumScrollBegin,
    onContentSizeChange,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onViewableItemsChanged,
    pinTarget,
    state,
    scopeKey,
  ]);
}
