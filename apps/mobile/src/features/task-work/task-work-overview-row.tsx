import { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { useAppTheme } from "@/providers/theme";
import { useAttention } from "@/providers/attention";
import type { AppTheme } from "@/theme/tokens";

import { TaskAgentAvatar } from "./task-agent-avatar";
import type { TaskWorkOverviewDisplayRow } from "./task-work-overview-presentation";
import { presentTaskWorkOverviewRow, shouldAnimateTaskWorkOverviewRow } from "./task-work-overview-row-presentation";

type TaskWorkOverviewRowProps = {
  readonly displayRow: TaskWorkOverviewDisplayRow;
  readonly serverUrl: string;
  readonly needsAttention: boolean;
  readonly nowMs: number;
  /** Phase 3's detail seam; route ownership arrives in task 3.4. */
  readonly onSelectTask?: (taskId: string) => void;
};

/** One compact, portrait-led disclosure target for a server-projected Task. */
export function TaskWorkOverviewRow({
  displayRow,
  serverUrl,
  needsAttention,
  nowMs,
  onSelectTask,
}: TaskWorkOverviewRowProps) {
  const t = useAppTheme();
  const reducedMotion = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.3;
  const presentation = presentTaskWorkOverviewRow({ displayRow, needsAttention, nowMs });
  const { pendingApprovalForTask, activeChallengeForTask } = useAttention();
  const taskApproval = pendingApprovalForTask(displayRow.row.taskId);
  const taskChallenge = activeChallengeForTask(displayRow.row.taskId);
  const exactAttention = taskApproval ? "Approval required" : taskChallenge ? "PIN required" : null;
  const runningAnimation = shouldAnimateTaskWorkOverviewRow(displayRow.row.status, reducedMotion);
  const activityPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!runningAnimation) {
      activityPulse.stopAnimation();
      activityPulse.setValue(1);
      return;
    }
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(activityPulse, { toValue: 0.45, duration: 800, useNativeDriver: true }),
      Animated.timing(activityPulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [activityPulse, runningAnimation]);
  const styles = useMemo(
    () => createStyles(t, presentation.displayDepth, presentation.displayParentTaskId !== null, largeText),
    [largeText, presentation.displayDepth, presentation.displayParentTaskId, t],
  );
  const detailLabel = [
    presentation.agentName,
    presentation.prompt,
    presentation.statusLabel,
    presentation.activity,
    presentation.timing,
    exactAttention,
  ].filter(Boolean).join(". ");
  const content = <>
    {presentation.displayParentTaskId !== null ? <View accessible={false} style={styles.connector} /> : null}
    <TaskAgentAvatar
      serverUrl={serverUrl}
      taskId={displayRow.row.taskId}
      agentName={presentation.agentName}
      size={40}
    />
    <View style={styles.copy}>
      <View style={styles.titleLine}>
        <Text allowFontScaling style={styles.prompt}>{presentation.prompt}</Text>
        {onSelectTask ? <Text accessible={false} allowFontScaling={false} style={styles.disclosure}>›</Text> : null}
      </View>
      <Text allowFontScaling style={styles.agentName}>{presentation.agentName}</Text>
      <View style={styles.metadata}>
        {displayRow.row.status === "running" ? <Animated.View accessible={false} style={[styles.runningIndicator, { opacity: activityPulse }]} /> : null}
        <Text allowFontScaling style={[styles.status, presentation.needsAttention && styles.attentionStatus]}>{presentation.statusLabel}</Text>
        <Text allowFontScaling style={styles.separator} accessible={false}>·</Text>
        <Text allowFontScaling style={styles.timing}>{presentation.timing}</Text>
      </View>
      <Text allowFontScaling style={styles.activity}>{presentation.activity}</Text>
      {exactAttention ? <Text allowFontScaling style={styles.attentionBadge} accessibilityRole="text">{exactAttention}</Text> : null}
    </View>
  </>;

  // Task 3.4 installs the detail handoff. Until then rows remain readable
  // content instead of pretending that a disabled button can disclose details.
  if (!onSelectTask) {
    return <View style={styles.root} accessible accessibilityRole="summary" role="listitem" accessibilityLabel={detailLabel}>{content}</View>;
  }

  return (
    <Pressable
      onPress={() => onSelectTask(displayRow.row.taskId)}
      style={({ pressed }) => [styles.root, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${detailLabel}. View task details`}
      accessibilityHint="View task details"
      >
      {content}
    </Pressable>
  );
}

function createStyles(t: AppTheme, displayDepth: number, hasDisplayParent: boolean, largeText: boolean) {
  const indent = Math.max(0, displayDepth) * t.spacing.lg;
  return StyleSheet.create({
    root: {
      position: "relative",
      minHeight: 72,
      marginLeft: indent,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      flexDirection: largeText ? "column" : "row",
      alignItems: largeText ? "stretch" : "flex-start",
      gap: t.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    pressed: { backgroundColor: t.color.surface.subtle },
    connector: {
      position: "absolute",
      left: -t.spacing.sm,
      top: 0,
      bottom: 0,
      width: t.spacing.sm,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: hasDisplayParent ? t.color.border.default : "transparent",
      borderBottomLeftRadius: t.radii.sm,
    },
    copy: largeText ? { width: "100%", minWidth: 0, gap: 2 } : { flex: 1, minWidth: 0, gap: 2 },
    titleLine: { flexDirection: "row", flexWrap: largeText ? "wrap" : "nowrap", alignItems: "flex-start", gap: t.spacing.xs },
    prompt: { flexGrow: 1, flexShrink: 1, color: t.color.text.foreground, ...t.typography.bodyStrong },
    disclosure: { color: t.color.text.muted, ...t.typography.heading, lineHeight: t.typography.body.lineHeight },
    agentName: { color: t.color.text.muted, ...t.typography.caption },
    metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: t.spacing.xs },
    runningIndicator: { width: 8, height: 8, borderRadius: t.radii.pill, backgroundColor: t.color.brand.accent, marginTop: 4 },
    status: { color: t.color.text.foreground, ...t.typography.caption },
    attentionStatus: { color: t.color.status.error, fontWeight: "700" },
    attentionBadge: { color: t.color.status.error, ...t.typography.caption, fontWeight: "700" },
    separator: { color: t.color.text.dim, ...t.typography.caption },
    timing: { color: t.color.text.muted, ...t.typography.caption },
    activity: { color: t.color.text.muted, ...t.typography.caption },
  });
}
