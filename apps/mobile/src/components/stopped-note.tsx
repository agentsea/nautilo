// D383 follow-up — transient "Stopped" note shown on the AutoApproveBar row
// (left of the auto-approve pill) after the user stops a turn. Fades in, then
// the caller flips `visible` off (auto after ~2.5s) → it fades out and
// unmounts. Always dismissable via the ✕ (never a stuck, undismissable note).
// Renders a zero-size placeholder while hidden so the row keeps the auto-approve
// pill right-aligned (space-between with a stable left child).
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function StoppedNote({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const opacity = useRef(new Animated.Value(0)).current;
  // Stays mounted through the fade-out; unmounts only once opacity hits 0.
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    if (visible) {
      setShowing(true);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
    } else if (showing) {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setShowing(false);
      });
    }
  }, [visible, showing, opacity]);

  if (!showing) return <View style={styles.placeholder} />;

  return (
    <Animated.View style={[styles.chip, { opacity }]}>
      <Ionicons name="stop-circle-outline" size={12} color={t.color.text.muted} />
      <Text style={styles.label}>Stopped</Text>
      <Pressable
        onPress={onDismiss}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss">
        <Ionicons name="close" size={12} color={t.color.text.muted} />
      </Pressable>
    </Animated.View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    placeholder: { width: 0, height: 0 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.subtle,
    },
    label: { ...t.typography.caption, color: t.color.text.muted },
  });
}
