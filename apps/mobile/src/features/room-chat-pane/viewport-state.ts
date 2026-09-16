const LIVE_EDGE_THRESHOLD_PX = 24;
export const MAX_NEW_MESSAGE_COUNT = 99;

export type RoomChatViewportMode =
  | "following"
  | "reader-away"
  | "target-pinned"
  | "returning";

export type RoomChatViewportState = {
  scopeKey: string;
  mode: RoomChatViewportMode;
  /** Stable FlatList presentation identity for the visible historical row. */
  anchorKey: string | null;
  /** Bounded distinct visible messages received since leaving the live edge. */
  newMessageKeys: readonly string[];
  /** Covers non-message live rows (for example tool cards) without a fake count. */
  hasNewActivity: boolean;
};

export type RoomChatViewportEvent =
  | { type: "scope-changed"; scopeKey: string }
  | { type: "reader-scrolled-away"; anchorKey: string | null }
  | { type: "reader-reached-live-edge" }
  | { type: "target-navigation"; anchorKey: string }
  | { type: "return-requested"; origin: "control" | "local-send" }
  | { type: "return-arrived" }
  | { type: "new-visible-messages"; messageKeys: readonly string[]; hasActivity?: boolean }
  | {
      type:
        | "remote-human"
        | "remote-agent-run"
        | "stream-growth"
        | "layout-growth"
        | "history-prepend"
        | "reconciliation"
        | "reconnect";
    };

export function createRoomChatViewportState(scopeKey: string): RoomChatViewportState {
  return {
    scopeKey,
    mode: "following",
    anchorKey: null,
    newMessageKeys: [],
    hasNewActivity: false,
  };
}

/**
 * Pure reader-owned viewport contract. Remote activity is deliberately inert:
 * only the Human reaching the live edge, the explicit control, or a local send
 * can resume following.
 */
export function reduceRoomChatViewport(
  state: RoomChatViewportState,
  event: RoomChatViewportEvent,
): RoomChatViewportState {
  switch (event.type) {
    case "scope-changed":
      return event.scopeKey === state.scopeKey
        ? state
        : createRoomChatViewportState(event.scopeKey);
    case "reader-scrolled-away":
      return {
        ...state,
        mode: "reader-away",
        anchorKey: event.anchorKey ?? state.anchorKey,
      };
    case "target-navigation":
      return {
        ...state,
        mode: "target-pinned",
        anchorKey: event.anchorKey,
      };
    case "reader-reached-live-edge":
      return state.mode === "reader-away" || state.mode === "target-pinned"
        ? createRoomChatViewportState(state.scopeKey)
        : state;
    case "return-requested":
      return {
        ...state,
        mode: "returning",
        anchorKey: null,
        newMessageKeys: [],
        hasNewActivity: false,
      };
    case "return-arrived":
      return createRoomChatViewportState(state.scopeKey);
    case "new-visible-messages": {
      if (state.mode === "following" || state.mode === "returning") return state;
      const keys = [...state.newMessageKeys];
      const seen = new Set(keys);
      for (const key of event.messageKeys) {
        if (seen.has(key)) continue;
        keys.push(key);
        seen.add(key);
        if (keys.length === MAX_NEW_MESSAGE_COUNT) break;
      }
      const hasNewActivity = state.hasNewActivity || event.hasActivity === true || keys.length > 0;
      return keys.length === state.newMessageKeys.length && hasNewActivity === state.hasNewActivity
        ? state
        : { ...state, newMessageKeys: keys, hasNewActivity };
    }
    case "remote-human":
    case "remote-agent-run":
    case "stream-growth":
    case "layout-growth":
    case "history-prepend":
    case "reconciliation":
    case "reconnect":
      return state;
  }
}

/**
 * `renderItems` is newest-first for the inverted FlatList. Only rows inserted
 * before the formerly-newest row are live-edge arrivals; older-page and
 * around-target hydration insert after it and must not inflate new activity.
 */
export function leadingInsertedKeys(
  previousKeys: readonly string[],
  currentKeys: readonly string[],
): string[] {
  if (previousKeys.length === 0 || currentKeys.length === 0) return [];
  const previous = new Set(previousKeys);
  const firstRetainedIndex = currentKeys.findIndex((key) => previous.has(key));
  return firstRetainedIndex > 0 ? currentKeys.slice(0, firstRetainedIndex) : [];
}

export function isAtInvertedLiveEdge(offsetY: number): boolean {
  return offsetY <= LIVE_EDGE_THRESHOLD_PX;
}

export function isViewportAtLiveEdge(input: {
  currentScopeKey: string;
  stateScopeKey: string;
  geometryScopeKey: string | null;
  nativeAtLiveEdge: boolean;
  mode: RoomChatViewportMode;
}): boolean {
  return input.stateScopeKey === input.currentScopeKey &&
    input.geometryScopeKey === input.currentScopeKey &&
    input.nativeAtLiveEdge &&
    input.mode === "following";
}

export function isRoomChatViewportAway(mode: RoomChatViewportMode): boolean {
  return mode === "reader-away" || mode === "target-pinned";
}

export function mayMarkRoomRead(input: {
  active: boolean;
  mounted: boolean;
  atLiveEdge: boolean;
  reportedScopeKey: string;
  currentScopeKey: string;
}): boolean {
  return input.active &&
    input.mounted &&
    input.atLiveEdge &&
    input.reportedScopeKey === input.currentScopeKey;
}

export function nextLatestScrollCommand(input: {
  appliedRequestId: number;
  request: { id: number; origin: "control" | "local-send" };
  hasRows: boolean;
}): { requestId: number; origin: "control" | "local-send" } | null {
  if (!input.hasRows || input.request.id === 0 || input.request.id <= input.appliedRequestId) {
    return null;
  }
  return { requestId: input.request.id, origin: input.request.origin };
}

export function maySettleLatestReturn(input: {
  origin: "control" | "local-send";
  contentCommitted: boolean;
  nativeAtLiveEdge: boolean;
}): boolean {
  return input.nativeAtLiveEdge &&
    (input.origin === "control" || input.contentCommitted);
}
