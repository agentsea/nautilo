/**
 * D528 — platform-neutral reader-owned viewport contract.
 *
 * Remote activity is deliberately inert: it may change transcript content but
 * never changes the reader's follow intent. Only a deliberate local send,
 * explicit return, or Human scroll gesture reaching the edge can resume it.
 */
export type ConversationViewportMode =
  | "following"
  | "reader-away"
  | "target-pinned"
  | "returning";

export function conversationViewportScopeKey(activeRoomId: string | null): string {
  return activeRoomId === null ? "legacy-chat" : `room:${activeRoomId}`;
}

export type ConversationViewportEvent =
  | {
      readonly type: "viewport-observed";
      readonly atLiveEdge: boolean;
      readonly origin?: "layout" | "human";
    }
  | { readonly type: "reader-scrolled-away" }
  | { readonly type: "target-navigation" }
  | { readonly type: "return-to-latest" }
  | { readonly type: "local-send" }
  | { readonly type: "remote-human-message" }
  | { readonly type: "remote-agent-run" }
  | { readonly type: "stream-growth" }
  | { readonly type: "layout-growth" }
  | { readonly type: "history-prepend" }
  | { readonly type: "message-reconciliation" }
  | { readonly type: "reconnect" }
  | { readonly type: "room-switch"; readonly restoredAtLiveEdge: boolean };

export interface ConversationAnchorCandidate {
  messageId: string;
  offsetPx: number;
}

export function selectVisibleConversationAnchors(args: {
  viewportTop: number;
  viewportBottom: number;
  messages: readonly {
    messageId: string;
    top: number;
    bottom: number;
  }[];
  maxCandidates?: number;
}): ConversationAnchorCandidate[] {
  const visibleIndex = args.messages.findIndex(
    (message) => message.bottom > args.viewportTop && message.top < args.viewportBottom,
  );
  if (visibleIndex < 0) return [];
  const orderedIndexes: number[] = [visibleIndex];
  for (let distance = 1; orderedIndexes.length < (args.maxCandidates ?? 5); distance++) {
    const next = visibleIndex + distance;
    const previous = visibleIndex - distance;
    if (next < args.messages.length) orderedIndexes.push(next);
    if (orderedIndexes.length >= (args.maxCandidates ?? 5)) break;
    if (previous >= 0) orderedIndexes.push(previous);
    if (next >= args.messages.length && previous < 0) break;
  }
  return orderedIndexes.map((index) => ({
    messageId: args.messages[index].messageId,
    offsetPx: args.messages[index].top - args.viewportTop,
  }));
}

export function selectVisibleConversationAnchor(
  args: Parameters<typeof selectVisibleConversationAnchors>[0],
): ConversationAnchorCandidate | null {
  return selectVisibleConversationAnchors(args)[0] ?? null;
}

export function selectFirstSurvivingConversationAnchor(
  candidates: readonly ConversationAnchorCandidate[],
  survives: (messageId: string) => boolean,
): ConversationAnchorCandidate | null {
  return candidates.find((candidate) => survives(candidate.messageId)) ?? null;
}

export async function materializeFirstConversationAnchor<TTarget>(args: {
  candidates: readonly ConversationAnchorCandidate[];
  materializeById: (messageId: string) => boolean;
  findTarget: (messageId: string) => TTarget | null;
  releaseMaterializedTarget: (messageId: string) => void;
  waitForCommit: () => Promise<void>;
  loadHistoryAround?: (messageId: string) => Promise<boolean>;
  isCurrent: () => boolean;
  maxAttempts?: number;
}): Promise<{ anchor: ConversationAnchorCandidate; target: TTarget } | null> {
  const maxAttempts = args.maxAttempts ?? 8;
  const tryMaterialize = async (
    anchor: ConversationAnchorCandidate,
  ): Promise<TTarget | null> => {
    for (let attempt = 0; attempt < maxAttempts && args.isCurrent(); attempt += 1) {
      if (args.materializeById(anchor.messageId)) {
        await args.waitForCommit();
        if (!args.isCurrent()) {
          args.releaseMaterializedTarget(anchor.messageId);
          return null;
        }
        const target = args.findTarget(anchor.messageId);
        if (target) return target;
        args.releaseMaterializedTarget(anchor.messageId);
      }
      if (attempt + 1 < maxAttempts) await args.waitForCommit();
    }
    return null;
  };

  for (const anchor of args.candidates) {
    let target = await tryMaterialize(anchor);
    if (target) return { anchor, target };
    if (!args.isCurrent()) return null;
    if (!args.loadHistoryAround) continue;

    const loaded = await args.loadHistoryAround(anchor.messageId);
    if (!args.isCurrent()) return null;
    if (!loaded) continue;
    await args.waitForCommit();
    target = await tryMaterialize(anchor);
    if (target) return { anchor, target };
  }
  return null;
}

export function isConversationViewportReadyForRead(args: {
  activeRoomId: string | null;
  readyRoomId: string | null;
  viewportAtBottom: boolean;
  followingLiveEdge: boolean;
}): boolean {
  return args.activeRoomId !== null &&
    args.readyRoomId === args.activeRoomId &&
    args.followingLiveEdge &&
    args.viewportAtBottom;
}

export function isConversationViewportFollowing(args: {
  mode: ConversationViewportMode;
  activeScopeKey: string;
  readyScopeKey: string | null;
}): boolean {
  return args.readyScopeKey === args.activeScopeKey &&
    (args.mode === "following" || args.mode === "returning");
}

/**
 * Windowing follows the reader-owned intent, not transient viewport geometry.
 *
 * Committing a long non-streamed message can make assistant-ui report
 * `isAtBottom=false` for one layout pass before its tail scroll runs. If the
 * bounded transcript treats that frame as lost follow intent, it evicts the
 * new tail and the scroll can no longer reach it; the reply then appears only
 * after a later explicit return-to-latest action (for example, sending the
 * next message).
 */
export function shouldConversationTranscriptFollowTail(
  followIntent: boolean | undefined,
): boolean {
  return followIntent ?? true;
}

export function shouldScheduleConversationLiveTailScroll(args: {
  readonly followingLiveEdge: boolean;
  readonly activeScopeKey: string;
  readonly activeVisitId: number;
  readonly readyScopeKey: string | null;
  readonly readyVisitId: number | null;
  readonly committedScopeKey: string;
  readonly committedVisitId: number;
  readonly previousTailMessageId: string | null;
  readonly committedTailMessageId: string | null;
}): boolean {
  return args.followingLiveEdge &&
    args.committedTailMessageId !== null &&
    args.committedTailMessageId !== args.previousTailMessageId &&
    args.committedScopeKey === args.activeScopeKey &&
    args.committedVisitId === args.activeVisitId &&
    args.readyScopeKey === args.activeScopeKey &&
    args.readyVisitId === args.activeVisitId;
}

export function scheduleConversationLiveTailScroll(args: {
  readonly schedule: (callback: () => void) => () => void;
  readonly isCurrent: () => boolean;
  readonly scrollToBottom: () => void;
}): () => void {
  return args.schedule(() => {
    if (args.isCurrent()) args.scrollToBottom();
  });
}

export function isConversationViewportAway(args: {
  mode: ConversationViewportMode;
  activeScopeKey: string;
  readyScopeKey: string | null;
}): boolean {
  return args.readyScopeKey === args.activeScopeKey &&
    (args.mode === "reader-away" || args.mode === "target-pinned");
}

export function isConversationViewportScopeReady(args: {
  activeScopeKey: string;
  readyScopeKey: string | null;
}): boolean {
  return args.readyScopeKey === args.activeScopeKey;
}

export function isConversationViewportAtPhysicalLiveEdge(args: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  thresholdPx?: number;
}): boolean {
  return Math.abs(args.scrollHeight - args.scrollTop - args.clientHeight) <=
    (args.thresholdPx ?? 1);
}

export function shouldAutoLoadOlderConversationHistory(args: {
  scrollTop: number;
  clientHeight: number;
}): boolean {
  // Start one viewport ahead so an ordinary upward scroll usually never
  // reaches the hard boundary while waiting for the next page.
  return args.scrollTop <= Math.max(80, args.clientHeight);
}

export function storeConversationSnapshotForReadyScope<T>(args: {
  activeRoomId: string | null;
  activeScopeKey: string;
  readyScopeKey: string | null;
  activeVisitId: number;
  readyVisitId: number | null;
  snapshots: Map<string, T>;
  createSnapshot: () => T;
}): boolean {
  if (
    args.activeRoomId === null ||
    args.readyVisitId !== args.activeVisitId ||
    !isConversationViewportScopeReady({
      activeScopeKey: args.activeScopeKey,
      readyScopeKey: args.readyScopeKey,
    })
  ) return false;
  args.snapshots.set(args.activeRoomId, args.createSnapshot());
  return true;
}

export function freezeConversationViewportForRoomSwitch<T>(args: Parameters<
  typeof storeConversationSnapshotForReadyScope<T>
>[0] & { freeze: () => void }): void {
  storeConversationSnapshotForReadyScope(args);
  args.freeze();
}

export function isConversationViewportOperationCurrent<T>(args: {
  capturedViewport: T;
  currentViewport: T | null;
  capturedScopeKey: string;
  currentScopeKey: string;
  capturedGeneration: number;
  currentGeneration: number;
}): boolean {
  return args.currentViewport === args.capturedViewport &&
    args.currentScopeKey === args.capturedScopeKey &&
    args.currentGeneration === args.capturedGeneration;
}

export function isConversationTranscriptReadyForRestore(args: {
  activeScopeKey: string;
  transcriptReadyScopeKey: string | null;
  snapshotHasIdentity: boolean;
}): boolean {
  return !args.snapshotHasIdentity ||
    args.transcriptReadyScopeKey === args.activeScopeKey;
}

export interface ConversationTranscriptHydrationCoordinator {
  beginVisit(scopeKey: string): void;
  supersede(scopeKey: string): void;
  isSuperseded(scopeKey: string): boolean;
  commit(args: {
    scopeKey: string;
    snapshotAnchorIds: readonly string[];
    committedMessageIds: readonly string[];
    loadHistoryAround: (messageId: string) => Promise<boolean>;
    isCurrent: () => boolean;
    onReady: () => void;
  }): void;
}

/**
 * Owns the async, per-Room transcript hydration admission used before a saved
 * stable anchor may be restored. A newer Human/explicit intent permanently
 * supersedes the saved snapshot for that Room visit, including after a delayed
 * around-load or a later assistant-ui message commit.
 */
export function createConversationTranscriptHydrationCoordinator(): ConversationTranscriptHydrationCoordinator {
  let visitScopeKey: string | null = null;
  let superseded = false;
  let request: { scopeKey: string; signature: string; token: object } | null = null;

  const beginVisit = (scopeKey: string): void => {
    if (visitScopeKey === scopeKey) return;
    visitScopeKey = scopeKey;
    superseded = false;
    request = null;
  };

  return {
    beginVisit,
    supersede(scopeKey) {
      if (visitScopeKey !== scopeKey) return;
      superseded = true;
      request = null;
    },
    isSuperseded(scopeKey) {
      return visitScopeKey === scopeKey && superseded;
    },
    commit(args) {
      if (visitScopeKey !== args.scopeKey) return;
      if (superseded || args.snapshotAnchorIds.length === 0) {
        args.onReady();
        return;
      }
      const committed = new Set(args.committedMessageIds);
      if (args.snapshotAnchorIds.some((messageId) => committed.has(messageId))) {
        args.onReady();
        return;
      }

      const signature = args.snapshotAnchorIds.join(",");
      if (request?.scopeKey === args.scopeKey && request.signature === signature) return;
      const token = {};
      request = { scopeKey: args.scopeKey, signature, token };
      void (async () => {
        try {
          for (const messageId of args.snapshotAnchorIds) {
            const loaded = await args.loadHistoryAround(messageId);
            if (
              request?.token !== token ||
              visitScopeKey !== args.scopeKey ||
              superseded ||
              !args.isCurrent()
            ) return;
            // A successful merge must publish the stable ID in a subsequent
            // transcript commit before the positional restore is admitted.
            if (loaded) return;
          }
          args.onReady();
        } finally {
          if (request?.token === token) request = null;
        }
      })();
    },
  };
}

export function transitionConversationViewport(
  mode: ConversationViewportMode,
  event: ConversationViewportEvent,
): ConversationViewportMode {
  switch (event.type) {
    case "viewport-observed":
      if (mode === "target-pinned") {
        return event.atLiveEdge ? "following" : mode;
      }
      if (mode === "returning") {
        if (event.atLiveEdge) return "following";
        return event.origin === "human" ? "reader-away" : mode;
      }
      if (mode === "reader-away") {
        return event.atLiveEdge ? "following" : mode;
      }
      // assistant-ui can briefly report `isAtBottom=false` between committing
      // streamed/tool content and applying its own tail scroll. Layout alone
      // must not convert that transient frame into persistent reader-away
      // intent. The viewport's Human scroll path supplies `origin: "human"`
      // when the reader actually leaves the live edge.
      if (event.origin !== "human") return mode;
      return event.atLiveEdge ? "following" : "reader-away";
    case "reader-scrolled-away":
      return "reader-away";
    case "target-navigation":
      return "target-pinned";
    case "return-to-latest":
    case "local-send":
      return "returning";
    case "room-switch":
      return event.restoredAtLiveEdge ? "following" : "reader-away";
    case "remote-human-message":
    case "remote-agent-run":
    case "stream-growth":
    case "layout-growth":
    case "history-prepend":
    case "message-reconciliation":
    case "reconnect":
      return mode;
  }
}
