import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import type { TaskLifecycleAction, TaskLifecyclePhase } from "./task-detail-lifecycle";

/** Presentation-only detail controls. The route-owned coordinator owns all APIs. */
export function TaskDetailLifecycleControls({
  targetKey,
  actions,
  phase,
  action,
  error,
  notice,
  onAction,
  onReload,
}: {
  readonly targetKey: string;
  readonly actions: readonly TaskLifecycleAction[];
  readonly phase: TaskLifecyclePhase;
  readonly action: TaskLifecycleAction | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly onAction: (action: TaskLifecycleAction) => void;
  readonly onReload: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stopInvokerRef = useRef<View>(null);
  const confirmationCancelRef = useRef<View>(null);
  const restoreStopFocusRef = useRef(false);
  const busy = phase === "requesting" || phase === "reconciling";
  const recoveryRequired = phase === "recovery-required";
  const canStop = actions.includes("stop");
  useEffect(() => { setConfirmingStop(false); restoreStopFocusRef.current = false; }, [targetKey, recoveryRequired]);
  useEffect(() => {
    if (!canStop) {
      restoreStopFocusRef.current = false;
      setConfirmingStop(false);
    }
  }, [canStop]);
  useEffect(() => {
    if (confirmingStop || !restoreStopFocusRef.current || !canStop) return;
    restoreStopFocusRef.current = false;
    if (Platform.OS === "web") {
      stopInvokerRef.current?.focus?.();
      return;
    }
    const node = findNodeHandle(stopInvokerRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  }, [canStop, confirmingStop]);
  useEffect(() => {
    if (!confirmingStop) return;
    if (Platform.OS === "web") {
      confirmationCancelRef.current?.focus?.();
      return;
    }
    const node = findNodeHandle(confirmationCancelRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  }, [confirmingStop]);

  const dismissConfirmation = (): void => {
    restoreStopFocusRef.current = true;
    setConfirmingStop(false);
  };

  if (actions.length === 0 && !error && !notice) return null;
  const labelFor = (action: TaskLifecycleAction): string => action === "pause" ? "Pause task" : action === "resume" ? "Resume task" : "Stop task";
  const pendingText = phase === "requesting"
    ? action === "pause" ? "Pausing task…" : action === "resume" ? "Resuming task…" : "Stopping task…"
    : phase === "reconciling" ? "Refreshing task status…" : null;
  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <Pressable
              key={action}
              ref={action === "stop" ? stopInvokerRef : undefined}
              onPress={() => action === "stop" ? setConfirmingStop(true) : onAction(action)}
              disabled={busy || recoveryRequired}
              style={({ pressed }) => [styles.action, action === "stop" ? styles.stop : styles.neutral, (pressed || busy || recoveryRequired) && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel={labelFor(action)}
              accessibilityHint={action === "stop" ? "Asks for confirmation before permanently stopping this task." : undefined}
              accessibilityState={{ disabled: busy || recoveryRequired, busy }}
            >
              <Text style={[styles.actionLabel, action === "stop" && styles.stopLabel]}>{labelFor(action)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {/* Keep all feedback below the stable action row so a mutation cannot move
          its controls away from a finger. */}
      {pendingText ? <Text style={styles.pending} accessibilityLiveRegion="polite">{pendingText}</Text> : null}
      {notice ? <View style={styles.notice} accessibilityRole="alert"><Text style={styles.noticeText}>{notice}</Text></View> : null}
      {error ? <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View> : null}
      {recoveryRequired ? <Pressable onPress={onReload} style={styles.reload} accessibilityRole="button" accessibilityLabel="Reload task" accessibilityHint="Reloads the canonical task status before another change." accessibilityState={{ busy }}><Text style={styles.reloadLabel}>Reload task</Text></Pressable> : null}
      <BottomSheet visible={confirmingStop} snapPoints={["60%"]} scrollable onClose={() => !busy && dismissConfirmation()}>
        <View style={styles.confirmation} accessibilityViewIsModal>
          <Text style={styles.confirmTitle} accessibilityRole="header">Stop this task?</Text>
          <Text style={styles.confirmCopy}>Stopping a task is permanent and cannot be resumed.</Text>
          <View style={styles.confirmActions}>
            <Pressable ref={confirmationCancelRef} onPress={dismissConfirmation} disabled={busy} style={[styles.action, styles.neutral]} accessibilityRole="button" accessibilityLabel="Cancel stopping task" accessibilityState={{ disabled: busy }}><Text style={styles.actionLabel}>Cancel</Text></Pressable>
            <Pressable onPress={() => { restoreStopFocusRef.current = false; setConfirmingStop(false); onAction("stop"); }} disabled={busy} style={[styles.action, styles.stop]} accessibilityRole="button" accessibilityLabel="Stop task" accessibilityState={{ disabled: busy, busy }}><Text style={[styles.actionLabel, styles.stopLabel]}>Stop task</Text></Pressable>
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { gap: t.spacing.sm, marginVertical: t.spacing.sm },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    action: { flexGrow: 1, minWidth: 120, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, paddingHorizontal: t.spacing.sm },
    neutral: { backgroundColor: t.color.surface.subtle },
    stop: { backgroundColor: t.color.status.error },
    disabled: { opacity: 0.55 },
    actionLabel: { ...t.typography.label, color: t.color.text.foreground },
    stopLabel: { color: t.color.text.onPrimary },
    error: { borderRadius: t.radii.md, padding: t.spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.status.error },
    errorText: { ...t.typography.body, color: t.color.status.error },
    notice: { borderRadius: t.radii.md, padding: t.spacing.md, backgroundColor: t.color.surface.subtle },
    noticeText: { ...t.typography.body, color: t.color.text.foreground },
    pending: { ...t.typography.caption, color: t.color.text.muted },
    reload: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.interactive },
    reloadLabel: { ...t.typography.label, color: t.color.border.interactive },
    confirmation: { gap: t.spacing.md },
    confirmTitle: { ...t.typography.heading, color: t.color.text.foreground },
    confirmCopy: { ...t.typography.body, color: t.color.text.muted },
    confirmActions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm, marginTop: t.spacing.md },
  });
}
