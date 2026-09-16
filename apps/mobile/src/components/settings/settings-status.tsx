import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export type SettingsStatusTone = "info" | "warning" | "error" | "success";

interface SettingsStatusProps {
  tone: SettingsStatusTone;
  children: string;
}

/** Compact, non-interactive status disclosure for loading, stale, and failure states. */
export function SettingsStatus({ tone, children }: SettingsStatusProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const color = toneColor(t, tone);

  return (
    <View
      style={[styles.status, { borderLeftColor: color }]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={children}
    >
      <Text style={[styles.text, { color }]}>{children}</Text>
    </View>
  );
}

function toneColor(t: AppTheme, tone: SettingsStatusTone): string {
  if (tone === "error") return t.color.status.error;
  if (tone === "warning") return t.color.status.warning;
  if (tone === "success") return t.color.status.success;
  return t.color.status.info;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    status: {
      borderLeftWidth: 3,
      backgroundColor: t.color.surface.panel,
      borderRadius: t.radii.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    text: { ...t.typography.caption, fontWeight: "600" },
  });
}
