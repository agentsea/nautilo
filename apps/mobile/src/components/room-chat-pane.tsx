import type { ReactElement } from "react";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  type ViewToken,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ArtifactOpenCard } from "@/components/artifact-open-card";
import { EmojiPickerSheet } from "@/components/emoji-picker-sheet";
import { MessageBubble } from "@/components/message-bubble";
import { messageDayLabels } from "@/lib/message-time";
import type { MessageActionRailRevealRequest } from "@/components/message-bubble";
import { MessageActionRail } from "@/components/message-action-rail";
import { MessageDeleteConfirmation } from "@/components/message-delete-confirmation";
import { MessageEditSheet } from "@/components/message-edit-sheet";
import {
  ReportContentSheet,
  type MobileReportTarget,
} from "@/components/report-content-sheet";
import {
  initialMessageActionRevealState,
  messageActionRevealReducer,
  shouldDismissTranscriptTap,
} from "@/features/threads/message-action-reveal";
import { ToolCard } from "@/components/tool-card";
import { ToolResultSheet, type ToolResultDisclosure } from "@/components/tool-result-sheet";
import { recoverTargetScroll } from "@/features/room-chat-search/scroll-recovery";
import { useRoomChatViewport } from "@/features/room-chat-pane/use-room-chat-viewport";
import type { RoomChatController } from "@/hooks/use-room-chat-controller";
import type { ChatItem } from "@/lib/messages";
import type { MessageAttachmentPreview } from "@/lib/messages";
import { MessageAttachmentViewer } from "@/features/message-attachments/message-attachment-viewer";
import { isCurrentMessageAttachmentSelection, isRetainedAttachment } from "@/features/message-attachments/message-attachment-source";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type RoomChatPaneProps = {
  controller: RoomChatController;
  /** Explicitly prevents nested reply-in-thread actions in a child thread. */
  actionSurface: "room" | "subthread";
  /**
   * Full-screen-only room target: tapping an agent avatar focuses that bot.
   * The docked pane (Phase 4.2) omits this (focus mode is full-chat only).
   */
  onAgentAvatarPress?: (agentActorId: string) => void;
  /** Parent-room-only entry into a canonical child thread. */
  onThreadPress?: (messageId: number) => void;
};

/**
 * Reusable transcript column for a room. Consumes a `RoomChatController` for
 * list state + the message/tool render slots, so the full-screen chat and the
 * docked artifact viewer render the same message column without duplicating
 * streaming, send, reaction, or paging logic. Room header/drawer/focus/members
 * chrome stays in the consuming route.
 */
export function RoomChatPane({
  controller: c,
  actionSurface,
  onAgentAvatarPress,
  onThreadPress,
}: RoomChatPaneProps) {
  const t = useAppTheme();
  const isSurfaceFocused = useIsFocused();
  const styles = useMemo(() => createStyles(t), [t]);
  const transcriptWrapRef = useRef<View>(null);
  const recoveredScrollRequestRef = useRef<number | null>(null);
  const appliedScrollRequestRef = useRef<number | null>(null);
  const scrollRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapAwayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reveal, dispatchReveal] = useReducer(
    messageActionRevealReducer,
    initialMessageActionRevealState,
  );
  const [emojiTarget, setEmojiTarget] = useState<{ messageId: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const editScopeIdentity = JSON.stringify([c.serverId, c.viewerUserId, c.roomId]);
  const [editTarget, setEditTarget] = useState<{ messageId: string; scopeIdentity: string } | null>(null);
  const [toolResultDisclosure, setToolResultDisclosure] = useState<ToolResultDisclosure | null>(null);
  const attachmentScopeIdentity = JSON.stringify([c.serverId, c.serverUrl, c.viewerUserId, c.roomId]);
  const [openAttachment, setOpenAttachment] = useState<{ attachment: Extract<MessageAttachmentPreview, { kind: "retained" }>; messageId: string; scopeIdentity: string } | null>(null);
  useEffect(() => setOpenAttachment(null), [c.serverId, c.serverUrl, c.viewerUserId, c.roomId]);
  const attachmentSelectionCurrent = openAttachment !== null && isCurrentMessageAttachmentSelection(c.items, {
    messageId: openAttachment.messageId,
    attachmentId: openAttachment.attachment.attachmentId,
  });
  useEffect(() => {
    if (openAttachment && !attachmentSelectionCurrent) setOpenAttachment(null);
  }, [attachmentSelectionCurrent, openAttachment]);
  const [reportTarget, setReportTarget] = useState<MobileReportTarget | null>(null);
  const [floatingRail, setFloatingRail] = useState<
    (MessageActionRailRevealRequest & { left: number; top: number }) | null
  >(null);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const revealedAtTouchStartRef = useRef<string | null>(null);
  const touchGenerationRef = useRef(0);
  const interactionConsumedRef = useRef(false);

  const clearTapAwayTimer = useCallback(() => {
    if (tapAwayTimerRef.current) clearTimeout(tapAwayTimerRef.current);
    tapAwayTimerRef.current = null;
  }, []);

  const handleTranscriptTouchStart = useCallback(() => {
    touchGenerationRef.current += 1;
    interactionConsumedRef.current = false;
    revealedAtTouchStartRef.current = revealRef.current.revealedMessageId;
    clearTapAwayTimer();
  }, [clearTapAwayTimer]);

  const markTranscriptInteraction = useCallback(() => {
    interactionConsumedRef.current = true;
    clearTapAwayTimer();
  }, [clearTapAwayTimer]);

  const handleTranscriptTouchEnd = useCallback(() => {
    // Let a row/control's Pressable resolve first. If neither handled this
    // interaction, it was a blank/list tap and closes the older reveal.
    clearTapAwayTimer();
    const scheduledGeneration = touchGenerationRef.current;
    tapAwayTimerRef.current = setTimeout(() => {
      if (shouldDismissTranscriptTap({
        currentGeneration: touchGenerationRef.current,
        scheduledGeneration,
        interactionConsumed: interactionConsumedRef.current,
      })) {
        dispatchReveal({ type: "dismiss" });
      }
      tapAwayTimerRef.current = null;
    }, 0);
  }, [clearTapAwayTimer]);

  useEffect(() => {
    dispatchReveal({ type: "scope", roomId: c.roomId ?? null });
    setFloatingRail(null);
    setEmojiTarget(null);
    setDeleteTarget(null);
    setEditTarget(null);
    setToolResultDisclosure(null);
  }, [c.roomId]);

  const editMessage = useMemo(() => {
    if (editTarget?.scopeIdentity !== editScopeIdentity) return null;
    const item = c.items.find(
      (candidate) => candidate.kind === "message" && candidate.id === editTarget.messageId,
    );
    return item?.kind === "message" && c.canEditMessage(item) ? item : null;
  }, [c.items, c.canEditMessage, editScopeIdentity, editTarget]);

  useEffect(() => {
    if (editTarget && editMessage === null) setEditTarget(null);
  }, [editMessage, editTarget]);

  useEffect(() => {
    if (reveal.revealedMessageId == null) setFloatingRail(null);
  }, [reveal.revealedMessageId]);

  const latestPersistedMessageId = useMemo(() => {
    for (let index = c.items.length - 1; index >= 0; index -= 1) {
      const item = c.items[index];
      if (item.kind === "message" && item.clientId === undefined && !item.id.startsWith("streaming:")) {
        return item.id;
      }
    }
    return null;
  }, [c.items]);

  useEffect(() => {
    const hasMessage = (messageId: string): boolean =>
      c.items.some((item) => item.kind === "message" && item.id === messageId);
    if (
      reveal.revealedMessageId != null &&
      !hasMessage(reveal.revealedMessageId)
    ) {
      dispatchReveal({ type: "dismiss" });
    }
    if (emojiTarget != null && !hasMessage(emojiTarget.messageId)) setEmojiTarget(null);
    if (deleteTarget != null && !hasMessage(deleteTarget)) setDeleteTarget(null);
  }, [c.items, deleteTarget, emojiTarget, reveal.revealedMessageId]);
  const reportLiveEdge = useCallback((atLiveEdge: boolean) => {
    c.reportViewportReadState({
      scopeKey: c.viewportScopeKey,
      mounted: isSurfaceFocused,
      atLiveEdge,
    });
  }, [c.reportViewportReadState, c.viewportScopeKey, isSurfaceFocused]);
  const viewport = useRoomChatViewport({
    scopeKey: c.viewportScopeKey,
    renderItems: c.renderItems,
    keyExtractor: c.keyExtractor,
    listRef: c.listRef,
    latestRequest: c.latestViewportRequest,
    onHumanReachedLiveEdge: c.releaseViewportAtLiveEdge,
  });
  useEffect(() => {
    reportLiveEdge(viewport.atLiveEdge);
  }, [reportLiveEdge, viewport.atLiveEdge]);

  useEffect(() => () => {
    c.reportViewportReadState({
      scopeKey: c.viewportScopeKey,
      mounted: false,
      atLiveEdge: false,
    });
  }, [c.reportViewportReadState, c.viewportScopeKey]);

  const handleViewableItemsChanged = useCallback((info: {
    viewableItems: ViewToken<ChatItem>[];
  }) => {
    viewport.onViewableItemsChanged(info);
    const revealedMessageId = revealRef.current.revealedMessageId;
    if (
      revealedMessageId != null &&
      !info.viewableItems.some(
        (token) => token.item?.kind === "message" && token.item.id === revealedMessageId,
      )
    ) {
      dispatchReveal({ type: "dismiss" });
    }
  }, [viewport.onViewableItemsChanged]);

  useEffect(() => {
    const target = c.scrollTarget;
    if (!target) return;
    // Position each target exactly once. Incoming streaming/voice rows update
    // `renderItems`; they must not replay an old search scroll and yank the
    // Human back to a previously selected message.
    if (appliedScrollRequestRef.current === target.requestId) return;
    appliedScrollRequestRef.current = target.requestId;
    recoveredScrollRequestRef.current = null;
    viewport.pinTarget(`msg:${target.messageId}`);
    const index = c.renderItems.findIndex(
      (item) => item.kind === "message" && String(item.id) === target.messageId,
    );
    if (index < 0) {
      c.reportTargetScrollFailure();
      return;
    }
    try {
      c.listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    } catch {
      c.reportTargetScrollFailure();
    }
  }, [
    c.scrollTarget,
    c.renderItems,
    c.listRef,
    c.reportTargetScrollFailure,
    viewport.pinTarget,
  ]);

  useEffect(() => () => {
    if (scrollRetryTimerRef.current) clearTimeout(scrollRetryTimerRef.current);
    clearTapAwayTimer();
  }, [clearTapAwayTimer]);

  const dayLabels = useMemo(() => messageDayLabels(c.renderItems), [c.renderItems]);
  const renderItem = useCallback(
    ({ item }: { item: ChatItem }): ReactElement | null => {
      if (item.kind === "tool") {
        return (
          <ToolCard
            name={item.toolName}
            status={item.status === "running" ? "start" : "end"}
            result={item.status === "error" ? item.error ?? item.result : item.result}
            failed={item.status === "error"}
            onResultLongPress={(result) => {
              markTranscriptInteraction();
              setToolResultDisclosure({
                name: item.toolName,
                result,
                failed: item.status === "error",
                truncated: item.resultTruncated === true,
              });
            }}
            groupedIncoming={c.groupedRoom}
          />
        );
      }
      const persisted =
        item.clientId === undefined && !item.id.startsWith("streaming:");
      const senderChrome = c.resolveSenderChrome(item);
      const replyQuote =
        item.replyToMessageId != null ? c.resolveReplyQuote(item.replyToMessageId) : null;
      const agentBotActorId =
        senderChrome.senderAgentId != null
          ? c.agentIdToActorId.get(senderChrome.senderAgentId)
          : undefined;
      const onAvatarPress =
        agentBotActorId != null && onAgentAvatarPress
          ? () => {
              markTranscriptInteraction();
              onAgentAvatarPress(agentBotActorId);
            }
          : undefined;
      return (
        <View style={
          c.highlightedMessageId === String(item.id) || reveal.revealedMessageId === String(item.id)
            ? styles.highlightedRow
            : undefined
        }>
          {dayLabels.has(item.id) ? <Text style={{ textAlign: "center", color: t.color.text.muted, paddingVertical: t.spacing.md, ...t.typography.caption }}>{dayLabels.get(item.id)}</Text> : null}
          <MessageBubble
            role={item.role}
            sentAt={item.sentAt}
            outgoing={senderChrome.outgoing}
            content={item.text}
            pending={item.status === "pending"}
            failed={item.status === "failed"}
            attachments={item.attachments}
            onAttachmentPress={(attachment) => {
              if (persisted && isRetainedAttachment(attachment)) {
                markTranscriptInteraction();
                setOpenAttachment({ attachment, messageId: item.id, scopeIdentity: attachmentScopeIdentity });
              }
            }}
            reactions={item.reactions}
            messageId={persisted ? item.id : undefined}
            onToggleReaction={persisted ? (messageId, emoji) => {
              markTranscriptInteraction();
              c.handleToggleReaction(messageId, emoji);
            } : undefined}
            onReact={persisted ? c.handleReact : undefined}
            onReactPress={persisted ? (messageId) => {
              markTranscriptInteraction();
              dispatchReveal({ type: "dismiss" });
              setEmojiTarget({ messageId });
            } : undefined}
            onCopyPress={persisted ? (_messageId, text) => {
              markTranscriptInteraction();
              void Clipboard.setStringAsync(text);
              dispatchReveal({ type: "dismiss" });
            } : undefined}
            onEditPress={persisted && c.canEditMessage(item) ? (messageId) => {
              markTranscriptInteraction();
              dispatchReveal({ type: "dismiss" });
              setEditTarget({ messageId, scopeIdentity: editScopeIdentity });
            } : undefined}
            onDeletePress={persisted && c.canDeleteMessage(item) ? (messageId) => {
              markTranscriptInteraction();
              dispatchReveal({ type: "dismiss" });
              setDeleteTarget(messageId);
            } : undefined}
            onReportPress={
              persisted && !senderChrome.outgoing && c.roomId
                ? (messageId) => {
                    const numericId = Number(messageId);
                    if (!Number.isInteger(numericId) || numericId <= 0) return;
                    markTranscriptInteraction();
                    dispatchReveal({ type: "dismiss" });
                    setReportTarget({
                      type: "message",
                      roomId: c.roomId!,
                      messageId: numericId,
                      label: "message",
                    });
                  }
                : undefined
            }
            actionSurface={actionSurface}
            actionRailVisible={
              persisted && item.id === latestPersistedMessageId
            }
            onActionRailReveal={persisted && item.id !== latestPersistedMessageId ? (request) => {
              markTranscriptInteraction();
              // The state captured at touch-start distinguishes a second tap
              // on the open row (close) from a tap on a different row (move).
              if (revealedAtTouchStartRef.current === request.messageId) {
                dispatchReveal({ type: "dismiss" });
                setFloatingRail(null);
              } else {
                transcriptWrapRef.current?.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
                  const railWidth = request.actions.length * 44 + 2;
                  const preferredLeft = request.outgoing
                    ? request.anchor.x + request.anchor.width - rootX - railWidth
                    : request.anchor.x - rootX;
                  const left = Math.max(8, Math.min(preferredLeft, rootWidth - railWidth - 8));
                  const below = request.anchor.y + request.anchor.height - rootY + 4;
                  const top = below + 44 <= rootHeight
                    ? below
                    : Math.max(8, request.anchor.y - rootY - 48);
                  setFloatingRail({ ...request, left, top });
                  dispatchReveal({ type: "reveal", messageId: request.messageId });
                });
              }
            } : undefined}
            onReplyPress={persisted ? (messageId) => {
              markTranscriptInteraction();
              dispatchReveal({ type: "dismiss" });
              c.handleReplyPress(messageId);
            } : undefined}
            replyCount={item.replyCount ?? 0}
            onThreadPress={
              persisted && onThreadPress
                ? (messageId) => {
                    const numericId = Number(messageId);
                    if (Number.isInteger(numericId) && numericId > 0) {
                      markTranscriptInteraction();
                      dispatchReveal({ type: "dismiss" });
                      onThreadPress(numericId);
                    }
                  }
                : undefined
            }
            replyToSenderName={replyQuote?.senderName}
            replyToSnippet={replyQuote?.snippet}
            onReplyHeaderPress={
              item.replyToMessageId != null
                ? () => {
                    markTranscriptInteraction();
                    c.handleReplyHeaderPress(item.replyToMessageId!);
                  }
                : undefined
            }
            grouped={senderChrome.grouped}
            senderName={senderChrome.senderName}
            showSenderName={senderChrome.showSenderName}
            showSenderAvatar={senderChrome.showSenderAvatar}
            senderUserId={
              senderChrome.senderUserId ??
              (!senderChrome.outgoing && item.role === "user"
                ? item.sourceUserId
                : undefined)
            }
            senderAgentId={senderChrome.senderAgentId}
            senderAgentAvatar={senderChrome.senderAgentAvatar}
            roomId={c.roomId ?? undefined}
            serverUrl={c.serverUrl}
            onAvatarPress={onAvatarPress}
            editedAt={item.editedAt}
          />
          {item.artifacts?.map((artifact) => (
            <ArtifactOpenCard
              key={`${artifact.roomId}:${artifact.artifactInternalId}`}
              artifact={artifact}
              outgoing={senderChrome.outgoing}
              groupedIncoming={senderChrome.grouped}
            />
          ))}
        </View>
      );
    },
    [
      dayLabels,
      t,
      c.groupedRoom,
      c.resolveSenderChrome,
      c.resolveReplyQuote,
      c.agentIdToActorId,
      c.handleToggleReaction,
      c.handleReact,
      c.handleReplyPress,
      c.handleReplyHeaderPress,
      c.canDeleteMessage,
      c.canEditMessage,
      c.roomId,
      c.serverUrl,
      actionSurface,
      clearTapAwayTimer,
      markTranscriptInteraction,
      latestPersistedMessageId,
      reveal.revealedMessageId,
      onAgentAvatarPress,
      onThreadPress,
      attachmentScopeIdentity,
      editScopeIdentity,
    ],
  );

  if (c.loading || c.roomMembersLoading || c.viewerState === "loading" || c.viewer == null) {
    return (
      <View style={styles.stateWrap}>
        <ActivityIndicator color={t.color.brand.accent} />
      </View>
    );
  }

  if (c.error) {
    return (
      <View style={styles.stateWrap}>
        <Text style={styles.stateTitle}>Could not load conversation</Text>
        <Text style={styles.stateSub}>{c.error}</Text>
        <Pressable style={styles.retryButton} onPress={() => void c.loadInitial()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (c.renderItems.length === 0) {
    return (
      <View style={styles.stateWrap}>
        <Text style={styles.stateTitle}>Say hello</Text>
        <Text style={styles.stateSub}>Send the first message to start this conversation.</Text>
      </View>
    );
  }

  return (
    <View ref={transcriptWrapRef} style={styles.transcriptWrap}>
      {c.transcriptWindow.mode === "historical" && c.transcriptWindow.hasOlderGap ? (
        <Pressable
          style={styles.gapRow}
          onPress={() => void c.loadHistoricalOlderGap()}
          disabled={c.pagingLoading}
          accessibilityRole="button"
          accessibilityLabel="Load older messages">
          <Text style={styles.gapText}>
            {c.pagingLoading ? "Loading older messages…" : "Load older messages"}
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        ref={c.listRef}
        data={c.renderItems}
        keyExtractor={c.keyExtractor}
        renderItem={renderItem}
        inverted
        // Native MVCP must retain the offscreen trailing anchor. FlatList
        // still virtualizes rows; Android's separate clipping detaches it.
        removeClippedSubviews={false}
        contentContainerStyle={styles.listBody}
        maintainVisibleContentPosition={viewport.maintainVisibleContentPosition}
        onEndReached={() => void c.loadOlder()}
        onEndReachedThreshold={0.5}
        onScrollBeginDrag={() => {
          dispatchReveal({ type: "dismiss" });
          viewport.onScrollBeginDrag();
        }}
        onMomentumScrollBegin={viewport.onMomentumScrollBegin}
        onScroll={viewport.onScroll}
        onScrollEndDrag={viewport.onScrollEndDrag}
        onMomentumScrollEnd={(event) => {
          viewport.onMomentumScrollEnd(event);
          dispatchReveal({ type: "dismiss" });
        }}
        onTouchStart={handleTranscriptTouchStart}
        onTouchEnd={handleTranscriptTouchEnd}
        onContentSizeChange={viewport.onContentSizeChange}
        scrollEventThrottle={32}
        viewabilityConfig={viewport.viewabilityConfig}
        onViewableItemsChanged={handleViewableItemsChanged}
        onScrollToIndexFailed={(info) => {
          const requestId = c.scrollTarget?.requestId;
          if (requestId == null) {
            c.reportTargetScrollFailure();
            return;
          }
          recoveredScrollRequestRef.current = recoverTargetScroll({
            requestId,
            attemptedRequestId: recoveredScrollRequestRef.current,
            index: info.index,
            averageItemLength: info.averageItemLength,
            scrollToOffset: (offset) =>
              c.listRef.current?.scrollToOffset({ offset, animated: false }),
            scrollToIndex: (index) => c.listRef.current?.scrollToIndex({
              index,
              animated: true,
              viewPosition: 0.5,
            }),
            schedule: (run) => {
              if (scrollRetryTimerRef.current) clearTimeout(scrollRetryTimerRef.current);
              scrollRetryTimerRef.current = setTimeout(run, 80);
            },
            fail: c.reportTargetScrollFailure,
          });
        }}
        ListFooterComponent={
          // Keep a trailing native anchor even for a one-message transcript.
          <View collapsable={false} style={c.pagingLoading ? styles.pageFooter : undefined}>
            {c.pagingLoading ? (
              <ActivityIndicator size="small" color={t.color.brand.accent} />
            ) : null}
          </View>
        }
      />
      {floatingRail && reveal.revealedMessageId === floatingRail.messageId ? (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          <View
            style={[
              styles.floatingRail,
              { left: floatingRail.left, top: floatingRail.top },
            ]}>
            <MessageActionRail
              actions={floatingRail.actions}
              visible
              outgoing={floatingRail.outgoing}
              onAction={floatingRail.onAction}
            />
          </View>
        </View>
      ) : null}
      {c.transcriptWindow.mode === "historical" && c.transcriptWindow.hasNewerGap ? (
        <Pressable
          style={styles.gapRow}
          onPress={c.returnToLatest}
          accessibilityRole="button"
          accessibilityLabel="Return to latest messages">
          <Text style={styles.gapText}>Newer messages available · Return to latest</Text>
        </Pressable>
      ) : null}
      {c.targetNavigationError ? (
        <View style={styles.targetError} accessibilityRole="alert">
          <Text style={styles.targetErrorText}>{c.targetNavigationError}</Text>
        </View>
      ) : null}
      {viewport.awayFromLiveEdge &&
      !(c.transcriptWindow.mode === "historical" && c.transcriptWindow.hasNewerGap) ? (
        <Pressable
          style={styles.returnLatest}
          onPress={c.returnToLatest}
          accessibilityRole="button"
          accessibilityLabel="Return to latest messages">
          <Text style={styles.returnLatestText}>
            {viewport.newMessageCount > 0
              ? `${viewport.newMessageCount} new message${viewport.newMessageCount === 1 ? "" : "s"} · Return to latest`
              : viewport.hasNewActivity
                ? "New activity · Return to latest"
                : "Return to latest"}
          </Text>
        </Pressable>
      ) : null}
      <EmojiPickerSheet
        visible={emojiTarget != null}
        onClose={() => setEmojiTarget(null)}
        onPick={(emoji) => {
          if (emojiTarget) {
            c.handleReact(emojiTarget.messageId, emoji);
            dispatchReveal({ type: "dismiss" });
          }
        }}
      />
      <MessageDeleteConfirmation
        messageId={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={c.handleDeleteMessage}
      />
      {editMessage ? (
        <MessageEditSheet
          key={`${editTarget?.scopeIdentity}:${editMessage.id}`}
          message={{
            id: editMessage.id,
            content: editMessage.editContent ?? editMessage.text,
            editRevision: editMessage.editRevision ?? 0,
          }}
          onClose={() => setEditTarget((current) => current === editTarget ? null : current)}
          onSave={c.handleEditMessage}
        />
      ) : null}
      <ToolResultSheet disclosure={toolResultDisclosure} onClose={() => setToolResultDisclosure(null)} />
      <ReportContentSheet
        serverUrl={c.serverUrl}
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
      {attachmentSelectionCurrent && openAttachment?.scopeIdentity === attachmentScopeIdentity && c.serverId && c.serverUrl && c.viewerUserId && c.roomId ? (
        <MessageAttachmentViewer
          attachment={openAttachment.attachment}
          scope={{ serverId: c.serverId, serverUrl: c.serverUrl, accountId: c.viewerUserId, roomId: c.roomId, messageId: openAttachment.messageId }}
          onClose={() => setOpenAttachment(null)}
        />
      ) : null}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    transcriptWrap: { flex: 1 },
    listBody: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm },
    highlightedRow: {
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
    },
    floatingRail: {
      position: "absolute",
      zIndex: 20,
      elevation: 12,
      shadowColor: "#000",
      shadowOpacity: 0.22,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
    },
    gapRow: {
      alignItems: "center",
      paddingVertical: t.spacing.xs,
      backgroundColor: t.color.surface.panel,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    gapText: { color: t.color.text.muted, ...t.typography.caption },
    targetError: { padding: t.spacing.sm, backgroundColor: t.color.surface.panel },
    targetErrorText: { color: t.color.status.error, textAlign: "center", ...t.typography.caption },
    returnLatest: {
      position: "absolute",
      right: t.spacing.md,
      bottom: t.spacing.md,
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.panel,
    },
    returnLatestText: { color: t.color.brand.accent, ...t.typography.label },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      padding: t.spacing.xl,
    },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: {
      marginTop: t.spacing.sm,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    pageFooter: { paddingVertical: t.spacing.md, alignItems: "center" },
  });
}
