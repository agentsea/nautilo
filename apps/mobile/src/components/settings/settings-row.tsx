import { Ionicons } from "@expo/vector-icons";
import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface SettingsRowProps {
  label: string;
  summary?: string;
  accessibilityHint: string;
  onPress: () => void;
  /** Replaces the standard chevron when a detail needs a compact native control. */
  trailing?: ReactNode;
}

/** Native Settings list row with a >=44pt target and one focused destination. */
export function SettingsRow({
  label,
  summary,
  accessibilityHint,
  onPress,
  trailing,
}: SettingsRowProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const accessibilityLabel = summary ? `${label}, ${summary}` : label;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <View style={styles.copy}>
        <Text style={styles.label}>{label}</Text>
        {summary ? (
          <Text style={styles.summary}>{summary}</Text>
        ) : null}
      </View>
      <View style={styles.trailing} pointerEvents="none">
        {trailing ?? <Ionicons name="chevron-forward" size={20} color={t.color.text.muted} />}
      </View>
    </Pressable>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    row: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    rowPressed: { backgroundColor: t.color.surface.subtle },
    copy: { flex: 1, minWidth: 0, gap: 2 },
    label: { ...t.typography.bodyStrong, color: t.color.text.foreground, flexShrink: 1 },
    summary: { ...t.typography.caption, color: t.color.text.muted, flexShrink: 1 },
    trailing: { minWidth: 24, alignItems: "flex-end", justifyContent: "center" },
  });
}
