// D383 Stage 1a — ThemeToggle: 3-way segmented control (System · Light · Dark)
// for the manual theme override. Reads/writes useThemePreference(); the active
// segment uses action.primaryBg + text.onPrimary, inactive segments are muted.
// Self-contained — drop it into Settings (canonical home, design-map §3.5).
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppTheme, useThemePreference, type ThemePreference } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const SEGMENTS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface ThemeToggleProps {
  style?: StyleProp<ViewStyle>;
}

export function ThemeToggle({ style }: ThemeToggleProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { preference, setPreference } = useThemePreference();

  return (
    <View style={[styles.track, style]}>
      {SEGMENTS.map((seg) => {
        const active = seg.value === preference;
        return (
          <Pressable
            key={seg.value}
            onPress={() => setPreference(seg.value)}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Theme: ${seg.label}`}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{seg.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    track: {
      flexDirection: "row",
      alignSelf: "flex-start",
      gap: t.spacing.xs,
      padding: t.spacing.xs,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    segment: {
      minHeight: 44,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentActive: {
      backgroundColor: t.color.action.primaryBg,
    },
    label: {
      ...t.typography.label,
      color: t.color.text.muted,
    },
    labelActive: {
      color: t.color.text.onPrimary,
    },
  });
}
