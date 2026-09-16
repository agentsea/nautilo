import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface SettingsSectionProps {
  title: string;
  children: ReactNode;
}

/** A native grouped-list section; rows remain responsible for their own actions. */
export function SettingsSection({ title, children }: SettingsSectionProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  return (
    <View style={styles.section} accessibilityRole="summary" accessibilityLabel={title}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    section: { gap: t.spacing.sm },
    title: {
      ...t.typography.caption,
      color: t.color.text.muted,
      fontWeight: "700",
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    rows: {
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
    },
  });
}
