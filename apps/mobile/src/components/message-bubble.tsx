import { useMemo, useRef } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MessageAvatar } from '@/components/message-avatar';
import { MessageTimestamp } from '@/components/message-timestamp';
import { AssistantChatMarkdown } from '@/components/assistant-chat-markdown';
import { MessageActionRail } from '@/components/message-action-rail';
import type { MessageAttachmentPreview, MessageReaction } from '@/lib/messages';
import { stripAssistantArtifacts } from '@/lib/strip-assistant-artifacts';
import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';
import {
  getMessageActionDescriptors,
  type AvatarRef,
  type MessageActionDescriptor,
  type MessageActionSurface,
} from '@nautilo/types';

const AVATAR_SIZE = 28;
const AVATAR_GAP = 8;

export type MessageActionRailRevealRequest = {
  messageId: string;
  anchor: { x: number; y: number; width: number; height: number };
  actions: readonly MessageActionDescriptor[];
  outgoing: boolean;
  onAction: (id: MessageActionDescriptor['id']) => void;
};

type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'system';
  /** Viewer-authored messages are outgoing, regardless of role alone. */
  outgoing: boolean;
  content: string;
  sentAt?: string;
  pending?: boolean;
  failed?: boolean;
  /** D382 — optional local preview URIs rendered as thumbnails above the text. */
  attachments?: MessageAttachmentPreview[];
  onAttachmentPress?: (attachment: MessageAttachmentPreview) => void;
  /** D408 — aggregated reactions (persisted messages only). */
  reactions?: MessageReaction[];
  /** Persisted server message id — required for reaction toggles. */
  messageId?: string;
  onToggleReaction?: (messageId: string, emoji: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onReactPress?: (messageId: string) => void;
  onCopyPress?: (messageId: string, content: string) => void;
  onEditPress?: (messageId: string) => void;
  onDeletePress?: (messageId: string) => void;
  onReportPress?: (messageId: string) => void;
  /** Omit for an inert, read-only surface such as a Task transcript. */
  actionSurface?: MessageActionSurface;
  /** Inert Task transcripts retain Markdown and allow native text selection. */
  selectableContent?: boolean;
  actionRailVisible?: boolean;
  onActionRailReveal?: (request: MessageActionRailRevealRequest) => void;
  /** D408 — grouped multi-participant chrome (group rooms only). */
  grouped?: boolean;
  senderName?: string;
  showSenderName?: boolean;
  showSenderAvatar?: boolean;
  senderUserId?: string;
  senderAgentId?: string;
  senderAgentAvatar?: AvatarRef | null;
  roomId?: string;
  serverUrl?: string;
  /** D408 stub — agent-focus / member-info wiring is a later task. */
  onAvatarPress?: () => void;
  /** D408 — inline quote-reply header (resolved by the screen). */
  replyToSenderName?: string;
  replyToSnippet?: string;
  onReplyHeaderPress?: () => void;
  onReplyPress?: (messageId: string) => void;
  /** D426 — visible entry into the canonical child thread. */
  replyCount?: number;
  onThreadPress?: (messageId: string) => void;
  editedAt?: string | null;
};

export function MessageBubble({
  role,
  outgoing,
  content,
  sentAt,
  pending = false,
  failed = false,
  attachments,
  onAttachmentPress,
  reactions,
  messageId,
  onToggleReaction,
  onReact,
  onReactPress,
  onCopyPress,
  onEditPress,
  onDeletePress,
  onReportPress,
  actionSurface,
  selectableContent = false,
  actionRailVisible = false,
  onActionRailReveal,
  grouped = false,
  senderName,
  showSenderName = false,
  showSenderAvatar = false,
  senderUserId,
  senderAgentId,
  senderAgentAvatar,
  roomId,
  serverUrl,
  onAvatarPress,
  replyToSenderName,
  replyToSnippet,
  onReplyHeaderPress,
  onReplyPress,
  replyCount = 0,
  onThreadPress,
  editedAt,
}: MessageBubbleProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const bubbleAnchorRef = useRef<View>(null);

  if (role === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, pending && styles.pending]}>{content}</Text>
        {failed ? <Text style={styles.failedNote}>{"Didn't get through"}</Text> : null}
      </View>
    );
  }

  const isUser = outgoing;
  const displayContent =
    role === 'assistant' ? stripAssistantArtifacts(content) : content;
  const hasAttachments = !!attachments && attachments.length > 0;
  const hasText = displayContent.length > 0;
  const canReact =
    messageId != null &&
    typeof onReact === 'function' &&
    !pending &&
    !messageId.startsWith('streaming:');
  const canReply = messageId != null && typeof onReplyPress === 'function' && !pending;
  // Match desktop fidelity: there is no "Attachment" clipboard placeholder.
  // Attachment-only messages therefore do not advertise a Copy action.
  const canCopy =
    messageId != null &&
    typeof onCopyPress === 'function' &&
    !pending &&
    displayContent.trim().length > 0;
  const canDelete = messageId != null && typeof onDeletePress === 'function' && !pending;
  const canEdit = messageId != null && typeof onEditPress === 'function' && !pending;
  const baseActionDescriptors = actionSurface ? getMessageActionDescriptors({
    surface: actionSurface,
    capabilities: {
      reply: canReply,
      react: canReact,
      replyInThread:
        typeof onThreadPress === 'function' && !pending && replyCount === 0,
      copy: canCopy,
      report:
        !outgoing &&
        (role === 'assistant' || typeof senderUserId === 'string') &&
        typeof onReportPress === 'function',
      edit: canEdit,
      delete: canDelete,
    },
  }) : [];
  const actionDescriptors = baseActionDescriptors;
  const visibleReactions = (reactions ?? []).filter((r) => r.count > 0);
  const showReactionStrip =
    visibleReactions.length > 0 && typeof onToggleReaction === 'function';
  const showQuoteHeader =
    replyToSenderName != null &&
    replyToSnippet != null &&
    replyToSenderName.length > 0 &&
    replyToSnippet.length > 0;

  const handleAction = (id: (typeof actionDescriptors)[number]['id']): void => {
    if (!messageId) return;
    switch (id) {
      case 'reply':
        onReplyPress?.(messageId);
        return;
      case 'react':
        onReactPress?.(messageId);
        return;
      case 'reply-in-thread':
        onThreadPress?.(messageId);
        return;
      case 'copy':
        onCopyPress?.(messageId, displayContent);
        return;
      case 'report':
        onReportPress?.(messageId);
        return;
      case 'edit':
        onEditPress?.(messageId);
        return;
      case 'delete':
        onDeletePress?.(messageId);
    }
  };

  const handleBubblePress = (): void => {
    if (!messageId || actionDescriptors.length === 0 || !onActionRailReveal) return;
    bubbleAnchorRef.current?.measureInWindow((x, y, width, height) => {
      onActionRailReveal({
        messageId,
        anchor: { x, y, width, height },
        actions: actionDescriptors,
        outgoing: isUser,
        onAction: handleAction,
      });
    });
  };

  const showIncomingChrome = grouped && !isUser;
  const showAvatarColumn = showIncomingChrome;
  const avatarLabel = senderName ?? '';

  const bubbleBody = (
    <>
      <Pressable
        ref={bubbleAnchorRef}
        onPress={handleBubblePress}
        disabled={actionDescriptors.length === 0}
        accessible={role !== 'assistant'}
        style={({ pressed }) => [pressed && actionDescriptors.length > 0 ? styles.bubblePressed : null]}>
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAssistant,
            pending && styles.pending,
            failed && styles.failed,
          ]}>
          {showQuoteHeader ? (
            <Pressable
              style={[
                styles.quoteHeader,
                isUser ? styles.quoteHeaderUser : styles.quoteHeaderAssistant,
              ]}
              onPress={onReplyHeaderPress}
              disabled={typeof onReplyHeaderPress !== 'function'}
              accessibilityRole="button"
              accessibilityLabel={`Jump to message from ${replyToSenderName}`}>
              <Text
                style={[
                  styles.quoteSender,
                  isUser ? styles.quoteSenderUser : styles.quoteSenderAssistant,
                ]}
                numberOfLines={1}>
                {replyToSenderName}
              </Text>
              <Text
                style={[
                  styles.quoteSnippet,
                  isUser ? styles.quoteSnippetUser : styles.quoteSnippetAssistant,
                ]}
                numberOfLines={2}>
                {replyToSnippet}
              </Text>
            </Pressable>
          ) : null}
          {hasAttachments ? (
            <View
              style={[
                styles.attachmentGrid,
                hasText ? styles.attachmentGridWithText : null,
              ]}>
              {attachments.map((a, i) => {
                const retainedImage = a.kind === "retained" && a.mimeType.toLowerCase().startsWith("image/");
                return <Pressable key={`${a.uri}-${i}`} accessibilityRole="button"
                  accessibilityLabel={a.kind === "retained" ? `Open attachment ${a.filename}` : "Attachment preview; original available after conversation refresh"}
                  disabled={a.kind !== "retained" || !onAttachmentPress}
                  onPress={() => onAttachmentPress?.(a)}>
                  {retainedImage || a.kind === "local" ? <Image source={a.kind === "retained" && a.headers ? { uri: a.uri, headers: a.headers } : { uri: a.uri }}
                    style={styles.attachmentThumb} contentFit="cover" /> : <View style={styles.attachmentFile}>
                    <Text style={styles.contentAssistant} numberOfLines={2}>{a.filename}</Text>
                    <Text style={styles.contentAssistant} numberOfLines={1}>{a.mimeType}</Text>
                  </View>}
                </Pressable>;
              })}
            </View>
          ) : null}
          {hasText && role === 'assistant' ? (
            <AssistantChatMarkdown source={displayContent} selectable={selectableContent} />
          ) : hasText ? (
            <Text selectable style={[styles.content, isUser ? styles.contentUser : styles.contentAssistant]}>
              {displayContent}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {!pending && !failed ? <MessageTimestamp sentAt={sentAt} /> : null}
      {!pending && !failed && editedAt ? (
        <Text style={[styles.editedMarker, isUser ? styles.editedMarkerUser : null]}>edited</Text>
      ) : null}
      {showReactionStrip && messageId && onToggleReaction ? (
        <View style={[styles.reactionStrip, isUser ? styles.reactionStripUser : null]}>
          {visibleReactions.map((r) => {
            const isSelf = r.mine === true;
            return (
              <Pressable
                key={r.emoji}
                style={[styles.reactionChip, isSelf && styles.reactionChipSelf]}
                onPress={() => onToggleReaction(messageId, r.emoji)}
                accessibilityRole="button"
                accessibilityLabel={`${r.emoji} reacted by ${r.count}`}>
                <Text style={styles.reactionEmoji}>{r.emoji}</Text>
                {r.count > 1 ? (
                  <Text style={[styles.reactionCount, isSelf && styles.reactionCountSelf]}>
                    {r.count}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <MessageActionRail
        actions={actionDescriptors}
        visible={actionRailVisible}
        outgoing={isUser}
        onAction={handleAction}
      />
      {messageId && typeof onThreadPress === 'function' && replyCount > 0 ? (
        <Pressable
          style={[styles.threadAffordance, isUser ? styles.threadAffordanceUser : null]}
          onPress={() => onThreadPress(messageId)}
          accessibilityRole="button"
          accessibilityLabel={`Open thread with ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}>
          <Text style={styles.threadAffordanceText}>
            {`↩ ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
          </Text>
          <Text style={styles.threadAffordanceChevron}>›</Text>
        </Pressable>
      ) : null}
      {failed ? <Text style={styles.failedNote}>{"Didn't get through"}</Text> : null}
    </>
  );

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {showSenderName && senderName ? (
        <Text
          style={[
            styles.senderName,
            showIncomingChrome ? styles.senderNameGrouped : null,
          ]}>
          {senderName}
        </Text>
      ) : null}
      {showIncomingChrome ? (
        <View style={styles.incomingRow}>
          {showAvatarColumn ? (
            showSenderAvatar && roomId && serverUrl ? (
              <MessageAvatar
                serverUrl={serverUrl}
                roomId={roomId}
                displayName={avatarLabel}
                userId={senderUserId}
                agentId={senderAgentId}
                agentAvatar={senderAgentAvatar}
                size={AVATAR_SIZE}
                onAvatarPress={onAvatarPress}
              />
            ) : (
              <View style={styles.avatarSpacer} />
            )
          ) : null}
          <View style={styles.bubbleColumn}>{bubbleBody}</View>
        </View>
      ) : (
        bubbleBody
      )}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    row: {
      marginVertical: t.spacing.xs,
      maxWidth: '85%',
    },
    rowUser: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
    },
    rowAssistant: {
      alignSelf: 'flex-start',
      alignItems: 'flex-start',
    },
    incomingRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: AVATAR_GAP,
      maxWidth: '100%',
    },
    bubbleColumn: {
      flexShrink: 1,
      maxWidth: '100%',
    },
    avatarSpacer: {
      width: AVATAR_SIZE,
      flexShrink: 0,
    },
    senderName: {
      ...t.typography.caption,
      fontWeight: '600',
      color: t.color.text.muted,
      marginBottom: t.spacing.xs,
    },
    senderNameGrouped: {
      marginLeft: AVATAR_SIZE + AVATAR_GAP,
    },
    bubblePressed: {
      opacity: 0.92,
    },
    bubble: {
      borderRadius: t.radii.lg,
      maxWidth: '100%',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    bubbleUser: {
      backgroundColor: t.color.action.primaryBg,
      borderBottomRightRadius: 4,
    },
    bubbleAssistant: {
      backgroundColor: t.color.surface.element,
      borderBottomLeftRadius: 4,
    },
    content: {
      ...t.typography.body,
    },
    contentUser: {
      color: t.color.text.onPrimary,
    },
    contentAssistant: {
      color: t.color.text.foreground,
    },
    attachmentGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.xs,
    },
    attachmentGridWithText: {
      marginBottom: t.spacing.xs,
    },
    attachmentThumb: {
      width: 140,
      height: 140,
      borderRadius: t.radii.md,
      overflow: 'hidden',
    },
    attachmentFile: {
      width: 140,
      minHeight: 88,
      justifyContent: 'center',
      gap: t.spacing.xs,
      padding: t.spacing.sm,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
    },
    threadAffordance: {
      alignSelf: 'stretch',
      minHeight: 36,
      marginTop: t.spacing.xs,
      paddingHorizontal: t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    threadAffordanceUser: {
      alignSelf: 'flex-end',
    },
    threadAffordanceText: {
      ...t.typography.caption,
      color: t.color.brand.accent,
      fontWeight: '600',
    },
    threadAffordanceChevron: {
      ...t.typography.body,
      color: t.color.text.muted,
    },
    quoteHeader: {
      borderLeftWidth: 3,
      paddingLeft: t.spacing.sm,
      marginBottom: t.spacing.xs,
      gap: 2,
    },
    quoteHeaderUser: {
      borderLeftColor: t.color.text.onPrimary,
      opacity: 0.85,
    },
    quoteHeaderAssistant: {
      borderLeftColor: t.color.brand.accent,
    },
    quoteSender: {
      ...t.typography.caption,
      fontWeight: '600',
    },
    quoteSenderUser: {
      color: t.color.text.onPrimary,
    },
    quoteSenderAssistant: {
      color: t.color.text.muted,
    },
    quoteSnippet: {
      ...t.typography.caption,
    },
    quoteSnippetUser: {
      color: t.color.text.onPrimary,
      opacity: 0.9,
    },
    quoteSnippetAssistant: {
      color: t.color.text.muted,
    },
    reactionStrip: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.xs,
      marginTop: t.spacing.xs,
      alignSelf: 'flex-start',
    },
    reactionStripUser: {
      alignSelf: 'flex-end',
    },
    reactionChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 2,
    },
    reactionChipSelf: {
      borderColor: t.color.brand.accent,
      backgroundColor: t.color.surface.subtle,
    },
    reactionEmoji: {
      fontSize: 14,
      lineHeight: 18,
    },
    reactionCount: {
      ...t.typography.caption,
      color: t.color.text.muted,
    },
    reactionCountSelf: {
      color: t.color.text.foreground,
    },
    systemRow: {
      alignSelf: 'center',
      alignItems: 'center',
      marginVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
    },
    systemText: {
      ...t.typography.caption,
      color: t.color.text.muted,
      textAlign: 'center',
    },
    pending: {
      opacity: 0.6,
    },
    failed: {
      borderWidth: 1,
      borderColor: t.color.status.error,
    },
    failedNote: {
      marginTop: t.spacing.xs,
      ...t.typography.caption,
      color: t.color.status.error,
    },
    editedMarker: {
      ...t.typography.caption,
      color: t.color.text.muted,
      alignSelf: 'flex-start',
      paddingHorizontal: t.spacing.sm,
    },
    editedMarkerUser: {
      alignSelf: 'flex-end',
    },
  });
}
