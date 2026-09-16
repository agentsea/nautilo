import type { ThreadDetailResponse } from "@nautilo/types";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { ModelSwitcherSheet } from "@/components/model-switcher-sheet";
import {
  FULL_CHAT_CAPABILITIES,
  RoomChatComposer,
  RoomChatPane,
  useRoomChatController,
} from "@/features/room-chat-pane";
import { getApiClient } from "@/lib/api";
import { buildAuthorLabels, resolveAgentAuthorLabel } from "@/lib/room-authors";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

/** Canonical child-Room thread surface. The parent chat remains underneath the
 * stack, preserving its draft and scroll position when this screen is popped. */
export default function MobileThreadScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const navigation = useNavigation();
  const { threadRoomId } = useLocalSearchParams<{ threadRoomId: string }>();
  const controller = useRoomChatController({ roomId: threadRoomId });
  const canInvokeAgents = viewerCan(controller.viewer, "invoke_agents");
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const anchorAuthor = useMemo(() => {
    if (!detail) return "From the conversation";
    if (detail.anchor.role === "user" || detail.anchor.role === "human") {
      if (detail.anchor.sourceUserId && detail.anchor.sourceUserId === controller.viewerUserId) {
        return "You";
      }
      return detail.anchor.sourceUserId
        ? (buildAuthorLabels(controller.roomMembers).get(detail.anchor.sourceUserId) ?? "Someone")
        : "Someone";
    }
    if (detail.anchor.role === "assistant" || detail.anchor.role === "ai") {
      return resolveAgentAuthorLabel({
        authorAgentId: detail.anchor.authorAgentId,
        members: controller.roomMembers,
        viewerUserId: controller.viewerUserId,
        fallbackName: "Assistant",
        roomId: detail.parentRoomId,
      }).name;
    }
    return "System";
  }, [controller.roomMembers, controller.viewerUserId, detail]);

  useEffect(() => {
    navigation.setOptions({ title: "Thread" });
  }, [navigation]);

  useEffect(() => {
    if (!controller.roomMembersLoading && controller.directAgentRoom && !canInvokeAgents) {
      router.replace("/(drawer)/(tabs)");
    }
  }, [canInvokeAgents, controller.directAgentRoom, controller.roomMembersLoading]);

  useEffect(() => {
    if (!canInvokeAgents) setModelSheetVisible(false);
  }, [canInvokeAgents]);

  useEffect(() => {
    if (!controller.serverUrl || !threadRoomId) return;
    let cancelled = false;
    setDetailError(null);
    void getApiClient(controller.serverUrl).getThreadDetail(threadRoomId).then(
      (value) => {
        if (!cancelled) setDetail(value);
      },
      () => {
        if (!cancelled) setDetailError("Could not load the original message.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller.serverUrl, threadRoomId]);

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.container}>
      <View style={styles.contextSection}>
        <Text style={styles.contextLabel}>Original message</Text>
        {detail ? (
          <View style={styles.parentCard}>
            <Text style={styles.parentAuthor}>
              {anchorAuthor}
            </Text>
            <ScrollView
              style={styles.parentScroll}
              contentContainerStyle={styles.parentScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              accessibilityLabel="Original message content">
              <Text style={styles.parentText}>{detail.anchor.content}</Text>
            </ScrollView>
          </View>
        ) : detailError ? (
          <Text style={styles.errorText}>{detailError}</Text>
        ) : (
          <ActivityIndicator size="small" color={t.color.brand.accent} />
        )}
      </View>
      <View style={styles.threadContent}>
        <View style={styles.repliesHeader}>
          <Text style={styles.repliesLabel}>
            {detail?.summary.replyCount === 1
              ? "1 reply"
              : `${detail?.summary.replyCount ?? ""} replies`.trim()}
          </Text>
        </View>
        <RoomChatPane controller={controller} actionSurface="subthread" />
      </View>
      <View style={styles.composerDock}>
        {canInvokeAgents || (!controller.roomMembersLoading && !controller.directAgentRoom) ? (
          <RoomChatComposer
            controller={controller}
            capabilities={FULL_CHAT_CAPABILITIES}
            onOpenModelSheet={() => setModelSheetVisible(true)}
          />
        ) : null}
      </View>
      {canInvokeAgents && !controller.directHumanRoom ? (
        <ModelSwitcherSheet
          visible={modelSheetVisible}
          onClose={() => setModelSheetVisible(false)}
          selectedModelId={controller.modelId}
          defaultModelLabel={controller.defaultModelLabel}
          onSelect={controller.handleModelSelect}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    contextSection: {
      maxHeight: "34%",
      flexShrink: 1,
      gap: t.spacing.xs,
      padding: t.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
      backgroundColor: t.color.surface.panel,
    },
    contextLabel: {
      ...t.typography.caption,
      color: t.color.text.muted,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    parentCard: {
      minHeight: 0,
      flexShrink: 1,
      gap: t.spacing.xs,
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    parentAuthor: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "600" },
    parentScroll: { minHeight: 0, flexShrink: 1 },
    parentScrollContent: { flexGrow: 0 },
    parentText: { ...t.typography.body, color: t.color.text.foreground },
    errorText: { ...t.typography.caption, color: t.color.status.error },
    threadContent: { flex: 1, minHeight: 0 },
    composerDock: {
      flexShrink: 0,
      backgroundColor: t.color.surface.background,
    },
    repliesHeader: { paddingHorizontal: t.spacing.md, paddingTop: t.spacing.sm },
    repliesLabel: { ...t.typography.label, color: t.color.text.muted },
  });
}
