// Shared chat composer strip. Consumes a `RoomChatController`
// and renders the transcript-adjacent controls: auto-approve/stop-note bar,
// approval card, typing indicator, routing receipt, inline reply preview, and
// the composer primitive with model + voice + attachment controls.
//
// The full-screen chat route and the future docked artifact-viewer pane both
// render this strip so composer + send behavior is not duplicated. The route
// keeps keyboard/safe-area tuning (it wraps this component in
// KeyboardAvoidingView) and owns the ModelSwitcherSheet modal via
// `onOpenModelSheet`. `capabilities` makes each surface's intentional
// omissions an explicit opt-out instead of a hidden wrapper.
import { Feather, Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ApprovalCard } from "@/components/approval-card";
import { AudioLinesIcon } from "@/components/audio-lines-icon";
import { AutoApproveBar } from "@/components/auto-approve-bar";
import { Composer } from "@/components/composer";
import { HostChoiceCard } from "@/components/host-choice-card";
import { StoppedNote } from "@/components/stopped-note";
import { AskUserPicker } from "@/features/room-chat-pane/ask-user-picker";
import { mobileMentionCandidates } from "@/features/room-chat-pane/human-mentions";
import { recordMobileHumanActivity } from "@/lib/human-activity";
import type { RoomChatController, RoomChatComposerCapabilities } from "@/hooks/use-room-chat-controller";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type RoomChatComposerProps = {
  controller: RoomChatController;
  capabilities: RoomChatComposerCapabilities;
  /** Opens the route-owned model switcher sheet. */
  onOpenModelSheet: () => void;
  interactionDisabled?: boolean;
};

export function RoomChatComposer({
  controller: c,
  capabilities,
  onOpenModelSheet,
  interactionDisabled = false,
}: RoomChatComposerProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const statusLeading =
    c.typing || c.workingAgentName || c.stopNoteVisible ? (
      <>
        {c.typing ? (
          <Text style={styles.typingText} numberOfLines={1}>
            {c.typing.displayName || "Someone"} is typing…
          </Text>
        ) : null}
        {c.workingAgentName ? (
          <View
            style={styles.workingIndicator}
            accessible
            accessibilityLabel={`${c.workingAgentName} is working`}
            accessibilityLiveRegion="polite">
            <Text style={styles.typingText} numberOfLines={1}>
              {c.workingAgentName}
            </Text>
            <WorkingDots color={t.color.text.muted} />
          </View>
        ) : null}
        <StoppedNote visible={c.stopNoteVisible} onDismiss={c.dismissStopNote} />
      </>
    ) : null;

  return (
    <>
      <AutoApproveBar
        showAutoApprove={c.canInvokeAgents && !c.directHumanRoom}
        leading={statusLeading}
        trailing={
          capabilities.voicePlayback ? (
            <Pressable
              style={[
                styles.voiceSessionPill,
                c.voiceEnabled && styles.voiceSessionPillActive,
              ]}
              onPress={c.speaking ? c.stopVoice : c.toggleVoice}
              accessibilityRole="button"
              accessibilityLabel={
                c.speaking
                  ? "Stop voice playback"
                  : c.voiceEnabled
                    ? "Disable voice playback"
                    : "Enable voice playback"
              }
              accessibilityState={{ selected: c.voiceEnabled }}>
              {c.speaking ? (
                <Ionicons name="stop" size={13} color={t.color.brand.accent} />
              ) : (
                <AudioLinesIcon
                  size={15}
                  color={c.voiceEnabled ? t.color.brand.accent : t.color.text.muted}
                />
              )}
              <Text
                numberOfLines={1}
                style={[
                  styles.voiceSessionText,
                  c.voiceEnabled && styles.voiceSessionTextActive,
                ]}>
                {c.speaking ? "Stop talking" : c.voiceEnabled ? "Talk: on" : "Talk: off"}
              </Text>
            </Pressable>
          ) : null
        }
      />
      {c.roomHostChoice ? <HostChoiceCard choice={c.roomHostChoice} /> : null}
      {c.roomApproval ? <ApprovalCard approval={c.roomApproval} /> : null}
      {c.replyTarget ? (
        <View style={styles.replyPreviewStrip}>
          <View style={styles.replyPreviewBody}>
            <Text style={styles.replyPreviewLabel} numberOfLines={1}>
              Replying to {c.replyTarget.senderName}
            </Text>
            <Text style={styles.replyPreviewSnippet} numberOfLines={1}>
              {c.replyTarget.snippet}
            </Text>
          </View>
          <Pressable
            style={styles.replyPreviewDismiss}
            onPress={c.cancelReply}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply">
            <Ionicons name="close" size={18} color={t.color.text.muted} />
          </Pressable>
        </View>
      ) : null}
      {c.capabilityError ? (
        <View style={styles.capabilityError} accessibilityRole="alert">
          <Text style={styles.capabilityErrorText}>{c.capabilityError}</Text>
        </View>
      ) : null}
      {c.contentFilterNotice ? (
        <View style={styles.capabilityError} accessibilityRole="alert">
          <Text style={styles.capabilityErrorText}>{c.contentFilterNotice}</Text>
        </View>
      ) : null}
      {c.directHumanInteractionBlocked ? (
        <View style={styles.blockedNotice} accessibilityRole="alert">
          <Text style={styles.blockedNoticeText}>
            Direct messaging is unavailable. Existing messages remain visible.
          </Text>
        </View>
      ) : null}
      <Composer
        onSend={c.handleSend}
        value={c.draftText}
        onChangeText={(text) => {
          recordMobileHumanActivity();
          c.setDraftText(text);
        }}
        onDiscardDraft={c.discardDraft}
        serverUrl={c.serverUrl}
        disabled={c.sending || interactionDisabled || c.directHumanInteractionBlocked}
        busy={c.busy}
        onStop={() => void c.handleStop()}
        hasAttachments={
          capabilities.attachments && c.attachments.some((a) => a.status === "ready")
        }
        voiceInputAvailable={capabilities.voiceInput && Boolean(c.serverUrl)}
        onMicStart={capabilities.voiceInput ? c.handleMicStart : undefined}
        onMicRelease={capabilities.voiceInput ? c.handleMicRelease : undefined}
        onMicCancel={capabilities.voiceInput ? c.handleMicCancel : undefined}
        mentionCandidates={mobileMentionCandidates(
          c.roomMembers,
          c.viewerActorId,
          c.canMentionEveryone,
        )}
        attachmentsSlot={
          capabilities.attachments &&
          (c.attachments.length > 0 || c.attachPermissionNote) ? (
            <View style={styles.attachmentsSlot}>
              {c.attachPermissionNote ? (
                <Text style={styles.attachPermissionNote}>{c.attachPermissionNote}</Text>
              ) : null}
              {c.attachments.length > 0 ? (
                <View style={styles.attachmentChips}>
                  {c.attachments.map((a) => (
                    <View key={a.localId} style={styles.attachmentChip}>
                      {a.status === "failed" ? (
                        <Pressable
                          style={styles.attachmentThumbPressable}
                          onPress={() => void c.handleRetry(a.localId)}
                          accessibilityRole="button"
                          accessibilityLabel="Retry upload">
                          {a.uri ? <Image
                            source={{ uri: a.uri }}
                            style={styles.attachmentThumb}
                            contentFit="cover"
                          /> : <Ionicons name="document-outline" size={22} color={t.color.text.foreground} />}
                          <View style={styles.attachmentOverlay}>
                            <Ionicons
                              name="alert-circle"
                              size={18}
                              color={t.color.status.error}
                            />
                          </View>
                        </Pressable>
                      ) : (
                        <>
                          {a.uri ? <Image
                            source={{ uri: a.uri }}
                            style={styles.attachmentThumb}
                            contentFit="cover"
                          /> : <Ionicons name="document-outline" size={22} color={t.color.text.foreground} />}
                          {a.status === "uploading" ? (
                            <View style={styles.attachmentOverlay}>
                              <ActivityIndicator
                                size="small"
                                color={t.color.text.foreground}
                              />
                            </View>
                          ) : null}
                        </>
                      )}
                      <Pressable
                        style={styles.attachmentRemove}
                        onPress={() => c.handleRemoveAttachment(a.localId)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove attachment">
                        <Ionicons name="close" size={14} color={t.color.text.foreground} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null
        }
        controls={
          c.canInvokeAgents && !c.directHumanRoom ? (
            <Pressable
              style={styles.modelChip}
              onPress={onOpenModelSheet}
              accessibilityRole="button"
              accessibilityLabel="Change model">
              <Ionicons name="pricetag-outline" size={14} color={t.color.text.muted} />
              <Text style={styles.modelChipLabel} numberOfLines={1}>
                {c.modelLabel}
              </Text>
              <Ionicons name="chevron-down" size={14} color={t.color.text.dim} />
            </Pressable>
          ) : undefined
        }
        attachSlot={
          capabilities.attachments ? (
            <Pressable
              style={styles.attachButton}
              onPress={() => void c.handleAttach()}
              accessibilityRole="button"
              accessibilityLabel="Attach image">
              <Feather name="paperclip" size={20} color={t.color.text.muted} />
            </Pressable>
          ) : null
        }
      />
      <AskUserPicker
        choice={c.askUserChoice}
        members={c.roomMembers}
        serverUrl={c.serverUrl}
        onCancel={c.dismissAskUserChoice}
        onSelect={(botActorId) => void c.selectAskUserCandidate(botActorId)}
      />
    </>
  );
}

function WorkingDots({ color }: { color: string }) {
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.stagger(
        150,
        dots.map((dot) =>
          Animated.sequence([
            Animated.timing(dot, { toValue: 1, duration: 220, useNativeDriver: true }),
            Animated.timing(dot, { toValue: 0, duration: 420, useNativeDriver: true }),
          ]),
        ),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [dots]);

  return (
    <View style={stylesForDots.dots} accessible={false}>
      {dots.map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            stylesForDots.dot,
            {
              backgroundColor: color,
              opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }],
            },
          ]}
        />
      ))}
    </View>
  );
}

const stylesForDots = StyleSheet.create({
  dots: { flexDirection: "row", alignItems: "center", gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2 },
});

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    typingText: {
      flexShrink: 1,
      color: t.color.text.muted,
      ...t.typography.caption,
    },
    workingIndicator: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      minWidth: 0,
    },
    replyPreviewStrip: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    replyPreviewBody: {
      flex: 1,
      borderLeftWidth: 3,
      borderLeftColor: t.color.brand.accent,
      paddingLeft: t.spacing.sm,
      gap: 2,
    },
    replyPreviewLabel: {
      ...t.typography.caption,
      fontWeight: "600",
      color: t.color.text.foreground,
    },
    replyPreviewSnippet: {
      ...t.typography.caption,
      color: t.color.text.muted,
    },
    replyPreviewDismiss: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.pill,
    },
    capabilityError: {
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.status.error,
      backgroundColor: t.color.surface.panel,
    },
    capabilityErrorText: {
      ...t.typography.caption,
      color: t.color.status.error,
    },
    blockedNotice: {
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.border.default,
      backgroundColor: t.color.surface.panel,
    },
    blockedNoticeText: {
      ...t.typography.caption,
      color: t.color.text.muted,
    },
    modelChip: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.pill,
      backgroundColor: "transparent",
      minWidth: 0,
    },
    modelChipLabel: {
      color: t.color.text.foreground,
      ...t.typography.caption,
      flexShrink: 1,
    },
    attachButton: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.pill,
      backgroundColor: "transparent",
    },
    voiceSessionPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
      width: 116,
      justifyContent: "center",
    },
    voiceSessionPillActive: {
      borderColor: t.color.brand.accent,
    },
    voiceSessionText: {
      ...t.typography.caption,
      color: t.color.text.muted,
      fontWeight: "500",
    },
    voiceSessionTextActive: {
      color: t.color.brand.accent,
    },
    attachmentsSlot: {
      flexDirection: "column",
      gap: t.spacing.xs,
    },
    attachPermissionNote: {
      color: t.color.text.muted,
      ...t.typography.caption,
      paddingHorizontal: t.spacing.xs,
    },
    attachmentChips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: t.spacing.xs,
    },
    attachmentChip: {
      position: "relative",
      width: 64,
      height: 64,
      borderRadius: t.radii.md,
      overflow: "hidden",
      backgroundColor: t.color.surface.element,
    },
    attachmentThumbPressable: {
      width: "100%",
      height: "100%",
    },
    attachmentThumb: {
      width: "100%",
      height: "100%",
    },
    attachmentOverlay: {
      position: "absolute",
      inset: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.overlay,
    },
    attachmentRemove: {
      position: "absolute",
      top: 2,
      right: 2,
      width: 20,
      height: 20,
      borderRadius: t.radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.overlay,
    },
  });
}
