import { forwardRef, useMemo, useRef } from "react";
import { Dimensions, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import { TaskAgentAvatar } from "./task-agent-avatar";
import {
  projectTaskWorkStrip,
  reduceTaskWorkStripOpen,
  shouldOpenTaskWorkOverviewFromHandle,
  taskWorkStripInteraction,
  type TaskWorkStripOpenAction,
} from "./task-work-strip-presentation";
import type { TaskWorkViewState } from "./task-work-state";

type TaskWorkStripProps = {
  readonly view: TaskWorkViewState;
  readonly serverUrl: string | null;
  /** Phase 3 supplies the actual keyboard-safe overview presentation. */
  readonly onOpenOverview?: () => void;
  readonly onCloseOverview?: () => void;
  readonly expanded?: boolean;
};

/**
 * Compact owner-wide delegated-work signal. It never reads Room focus state,
 * transcript state, or a draft; Phase 3 owns the richer overview interaction.
 */
export const TaskWorkStrip = forwardRef<View, TaskWorkStripProps>(function TaskWorkStrip({ view, serverUrl, onOpenOverview, onCloseOverview, expanded = false }, forwardedRef) {
  const t = useAppTheme();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.3;
  const styles = useMemo(() => createStyles(t, largeText), [largeText, t]);
  const openStateRef = useRef({ pullClaimed: false });
  const applyOpenAction = (action: TaskWorkStripOpenAction): void => {
    const result = reduceTaskWorkStripOpen(openStateRef.current, action);
    openStateRef.current = result.state;
    if (result.shouldOpen) onOpenOverview?.();
  };
  const handleResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => shouldOpenTaskWorkOverviewFromHandle({
      dx: gesture.dx,
      dy: gesture.dy,
      startX: gesture.x0,
      windowWidth: Dimensions.get("window").width,
    }),
    onMoveShouldSetPanResponderCapture: () => false,
    onPanResponderTerminationRequest: () => true,
    onPanResponderGrant: () => applyOpenAction("pull"),
    onPanResponderRelease: () => applyOpenAction("release"),
    onPanResponderTerminate: () => applyOpenAction("release"),
  }), [onOpenOverview]);

  const projection = projectTaskWorkStrip(view);
  const interaction = taskWorkStripInteraction({ expanded, canOpen: onOpenOverview !== undefined, canClose: onCloseOverview !== undefined });
  if (!projection || !serverUrl) return null;
  const { row, taskCount, actionNeeded } = projection;
  const countLabel = `${taskCount} delegated ${taskCount === 1 ? "task" : "tasks"}`;

  const content = (
    <>
      {interaction === "open" ? <View {...handleResponder.panHandlers} style={styles.handle} /> : null}
      <View style={styles.content}>
        <View style={styles.primary}>
          <TaskAgentAvatar serverUrl={serverUrl} taskId={row.taskId} agentName={row.task.agentName} />
          <View style={styles.copy}>
            <Text allowFontScaling numberOfLines={1} ellipsizeMode="tail" style={[styles.count, actionNeeded && styles.actionCount]}>
              {countLabel}
            </Text>
            <Text allowFontScaling numberOfLines={1} ellipsizeMode="tail" style={[styles.activity, actionNeeded && styles.actionActivity]}>
              {row.activity}
            </Text>
          </View>
        </View>
        {interaction !== "inert" ? <Text accessible={false} allowFontScaling={false} style={styles.disclosure}>{expanded ? "⌃" : "⌄"}</Text> : null}
      </View>
    </>
  );
  if (interaction === "inert") {
    return <View ref={forwardedRef} accessible={false} style={[styles.root, actionNeeded && styles.actionNeeded]}>{content}</View>;
  }
  return (
    <Pressable
      ref={forwardedRef}
      onPressIn={interaction === "open" ? () => applyOpenAction("press-start") : undefined}
      onPress={interaction === "close" ? onCloseOverview : () => applyOpenAction("press")}
      style={[styles.root, actionNeeded && styles.actionNeeded]}
      accessibilityRole="button"
      accessibilityLabel={`${countLabel}. ${row.task.agentName?.trim() || "Genie"}. ${row.activity}`}
      accessibilityState={{ expanded }}
      accessibilityHint={expanded ? "Double tap to close delegated work" : "Double tap to open delegated work"}>
      {content}
    </Pressable>
  );
});

function createStyles(t: AppTheme, largeText: boolean) {
  return StyleSheet.create({
    root: {
      flexShrink: 0,
      height: largeText ? 88 : 60,
      paddingHorizontal: t.spacing.md,
      paddingBottom: t.spacing.sm,
      backgroundColor: t.color.surface.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    actionNeeded: { borderBottomColor: t.color.status.error },
    handle: { alignSelf: "center", width: 36, height: 12, borderRadius: t.radii.pill, backgroundColor: t.color.border.interactive },
    content: { minHeight: 32, flexDirection: largeText ? "column" : "row", alignItems: largeText ? "stretch" : "center", gap: t.spacing.sm },
    primary: { flex: largeText ? 0 : 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
    copy: { flex: 1, minWidth: 0 },
    count: { color: t.color.text.foreground, ...t.typography.label },
    actionCount: { color: t.color.status.error },
    activity: { color: t.color.text.muted, ...t.typography.caption },
    actionActivity: { color: t.color.text.foreground, fontWeight: "700" },
    disclosure: { alignSelf: largeText ? "flex-end" : "center", color: t.color.text.muted, ...t.typography.bodyStrong },
  });
}
