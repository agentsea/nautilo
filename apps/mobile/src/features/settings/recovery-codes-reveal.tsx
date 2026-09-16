import { useCallback, useEffect, useMemo } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";

import type { RecoveryCodeFamily } from "@/features/settings/recovery-controller";
import { RECOVERY_CODE_FAMILIES } from "@/features/settings/recovery-controller";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function RecoveryCodesReveal({ family, codes, onCopy, onAcknowledge, onClear }: {
  family: RecoveryCodeFamily;
  codes: string;
  onCopy: (codes: string) => Promise<void> | void;
  onAcknowledge: () => void;
  onClear: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const copy = RECOVERY_CODE_FAMILIES[family];
  useEffect(() => () => onClear(), [onClear]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") onClear();
    });
    return () => subscription.remove();
  }, [onClear]);
  useFocusEffect(useCallback(() => () => onClear(), [onClear]));
  return <View style={styles.card} accessibilityLiveRegion="polite">
    <Text style={styles.title}>{copy.title}</Text>
    <Text style={styles.notice}>Save these now. They will not be shown again.</Text>
    <Text selectable style={styles.codes}>{codes}</Text>
    <View style={styles.actions}>
      <Pressable style={styles.secondary} onPress={() => void onCopy(codes)} accessibilityRole="button"><Text style={styles.secondaryText}>Copy all</Text></Pressable>
      <Pressable style={styles.primary} onPress={onAcknowledge} accessibilityRole="button"><Text style={styles.primaryText}>I saved these codes</Text></Pressable>
    </View>
  </View>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  card: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
  title: { ...t.typography.subheading, color: t.color.text.foreground }, notice: { ...t.typography.bodyStrong, color: t.color.status.warning },
  codes: { ...t.typography.body, color: t.color.text.foreground, fontFamily: "monospace", padding: t.spacing.md, backgroundColor: t.color.surface.background, borderRadius: t.radii.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm }, primary: { padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, secondary: { padding: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, primaryText: { ...t.typography.bodyStrong, color: t.color.surface.background }, secondaryText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
}); }
