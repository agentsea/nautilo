import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Dimensions, findNodeHandle, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import { shouldCloseTaskWorkOverviewFromUpHandle, shouldFocusTaskWorkOverviewShell, taskWorkOverviewTabWrap } from "./task-work-overview-presentation";
import { TaskWorkOverviewContent } from "./task-work-overview-content";
import type { TaskWorkViewState } from "./task-work-state";

export function TaskWorkOverviewShell({
  onClose,
  view,
  serverUrl,
  onSelectTask,
}: {
  readonly onClose: () => void;
  readonly view: TaskWorkViewState;
  readonly serverUrl: string | null;
  /** Phase 3's callback seam; task 3.4 owns route handoff. */
  readonly onSelectTask?: (taskId: string) => void;
}) {
  const t = useAppTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.3;
  const reveal = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const closeRef = useRef<View>(null);
  const shellRef = useRef<View>(null);
  const focusedInitiallyRef = useRef(false);
  const mountedRef = useRef(true);
  const [stageHeight, setStageHeight] = useState(0);
  const [revealFinished, setRevealFinished] = useState(reducedMotion);
  useEffect(() => {
    mountedRef.current = true;
    if (reducedMotion) { reveal.setValue(1); setRevealFinished(true); return () => { mountedRef.current = false; }; }
    reveal.setValue(0);
    setRevealFinished(false);
    const animation = Animated.timing(reveal, { toValue: 1, duration: 160, useNativeDriver: false });
    animation.start(({ finished }) => {
      if (finished && mountedRef.current) setRevealFinished(true);
    });
    return () => { mountedRef.current = false; animation.stop(); };
  }, [reducedMotion, reveal]);
  useEffect(() => {
    if (!shouldFocusTaskWorkOverviewShell({ stageHeight, reducedMotion, revealFinished, alreadyFocused: focusedInitiallyRef.current })) return;
    focusedInitiallyRef.current = true;
    if (Platform.OS === "web") {
      closeRef.current?.focus?.();
      return;
    }
    const node = findNodeHandle(closeRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  }, [reducedMotion, revealFinished, stageHeight]);
  const styles = useMemo(() => createStyles(t, insets.bottom, insets.left, insets.right, largeText), [insets.bottom, insets.left, insets.right, largeText, t]);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => shouldCloseTaskWorkOverviewFromUpHandle({ dx: gesture.dx, dy: gesture.dy, startX: gesture.x0, windowWidth: Dimensions.get("window").width }),
    onMoveShouldSetPanResponderCapture: () => false,
    onPanResponderTerminationRequest: () => true,
    onPanResponderGrant: () => onClose(),
  }), [onClose]);
  const revealedHeight = reducedMotion ? stageHeight : reveal.interpolate({ inputRange: [0, 1], outputRange: [0, stageHeight] });
  const onWebKeyDown = (event: unknown): void => {
    const keyEvent = event as { key?: string; shiftKey?: boolean; target?: unknown; preventDefault?: () => void };
    if (keyEvent.key !== "Tab") return;
    const host = shellRef.current as unknown as { querySelectorAll?: (selector: string) => ArrayLike<{ focus?: () => void }> } | null;
    const focusable = host?.querySelectorAll
      ? Array.from(host.querySelectorAll(
        '[role="button"]:not([disabled]):not([aria-disabled="true"]), [href]:not([aria-disabled="true"]), input:not([disabled]):not([aria-disabled="true"]), select:not([disabled]):not([aria-disabled="true"]), textarea:not([disabled]):not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"]):not([disabled]):not([aria-disabled="true"])',
      ))
      : [];
    const activeElement = typeof document === "undefined" ? keyEvent.target : document.activeElement;
    const next = taskWorkOverviewTabWrap({ focusableCount: focusable.length, activeIndex: focusable.indexOf(activeElement as { focus?: () => void }), shiftKey: keyEvent.shiftKey === true });
    if (next === null) return;
    keyEvent.preventDefault?.();
    focusable[next]?.focus?.();
  };
  return <View style={styles.clip} onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}>
    <Animated.View
      ref={shellRef}
      style={[styles.root, { height: revealedHeight }]}
      accessibilityRole="summary"
      accessibilityLabel="Delegated work"
      accessibilityViewIsModal
      onAccessibilityEscape={() => onClose()}
      {...(Platform.OS === "web" ? { role: "dialog", "aria-modal": true, onKeyDown: onWebKeyDown } as unknown as Record<string, unknown> : {})}>
      <View {...responder.panHandlers} style={styles.handleHit}><View style={styles.handle} /></View>
      <View style={styles.header}>
        <Text allowFontScaling style={styles.title}>Delegated work</Text>
        <Pressable ref={closeRef} onPress={() => onClose()} style={styles.close} accessibilityRole="button" accessibilityLabel="Close delegated work">
          <Text allowFontScaling style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
      <View style={styles.contentHost}>
        {serverUrl ? <TaskWorkOverviewContent view={view} serverUrl={serverUrl} onSelectTask={onSelectTask} /> : null}
      </View>
    </Animated.View>
  </View>;
}
function createStyles(t: AppTheme, bottom: number, left: number, right: number, largeText: boolean) { return StyleSheet.create({
  clip: { ...StyleSheet.absoluteFill, overflow: "hidden", zIndex: 30, elevation: 30 },
  root: { overflow: "hidden", paddingBottom: bottom, paddingLeft: left, paddingRight: right, backgroundColor: t.color.surface.background },
  handleHit: { minHeight: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  handle: { width: 36, height: 12, borderRadius: t.radii.pill, backgroundColor: t.color.border.interactive },
  header: { minHeight: 44, paddingHorizontal: t.spacing.md, paddingVertical: largeText ? t.spacing.xs : 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", rowGap: t.spacing.xs },
  title: { flexShrink: 1, color: t.color.text.foreground, ...t.typography.subheading }, close: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.sm }, closeText: { color: t.color.border.interactive, ...t.typography.label }, contentHost: { flex: 1 },
}); }
