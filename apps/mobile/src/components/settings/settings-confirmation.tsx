import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface SettingsConfirmationProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
}

/** Explicit native confirmation used by irreversible Settings actions. */
export function SettingsConfirmation({
  visible,
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  destructive = false,
  busy = false,
}: SettingsConfirmationProps) {
  const insets = useSafeAreaInsets();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const confirmColor = destructive ? t.color.status.error : t.color.action.primaryBg;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <View style={[styles.card, { marginBottom: Math.max(insets.bottom, t.spacing.lg) }]}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              accessibilityHint="Closes this confirmation without making changes."
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={busy}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: confirmColor },
                (pressed || busy) && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityHint="Confirms this Settings action."
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.confirmLabel}>{busy ? "Working…" : confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    scrim: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0, 0, 0, 0.45)",
      paddingHorizontal: t.spacing.lg,
    },
    card: {
      gap: t.spacing.md,
      borderRadius: t.radii.lg,
      backgroundColor: t.color.surface.panel,
      padding: t.spacing.lg,
    },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    message: { ...t.typography.body, color: t.color.text.muted },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.sm, flexWrap: "wrap" },
    button: {
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.sm,
    },
    cancel: { borderWidth: 1, borderColor: t.color.border.default },
    pressed: { opacity: 0.7 },
    cancelLabel: { ...t.typography.label, color: t.color.text.foreground },
    confirmLabel: { ...t.typography.label, color: t.color.text.onPrimary },
  });
}
