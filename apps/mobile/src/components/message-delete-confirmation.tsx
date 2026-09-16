import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type MessageDeleteConfirmationProps = {
  messageId: string | null;
  onClose: () => void;
  onConfirm: (messageId: string) => Promise<string | null>;
};

/** A deliberate, non-dismissible-by-accident confirmation for hard deletes. */
export function MessageDeleteConfirmation({
  messageId,
  onClose,
  onConfirm,
}: MessageDeleteConfirmationProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const confirm = async (): Promise<void> => {
    if (!messageId || busy) return;
    setBusy(true);
    const result = await onConfirm(messageId);
    setBusy(false);
    if (result) {
      setError(result);
      return;
    }
    onClose();
  };

  return (
    <BottomSheet visible={messageId != null} onClose={close} snapPoints={["36%"]} backdrop>
      <View style={styles.content} accessibilityViewIsModal>
        <Text style={styles.title}>Delete message?</Text>
        <Text style={styles.copy}>This permanently removes the message for everyone in this chat.</Text>
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            style={styles.cancel}
            onPress={close}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Cancel deleting message">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.delete, busy ? styles.disabled : null]}
            onPress={() => void confirm()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Delete message">
            <Text style={styles.deleteText}>{busy ? "Deleting…" : "Delete"}</Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.md },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    copy: { ...t.typography.body, color: t.color.text.muted },
    error: { ...t.typography.caption, color: t.color.status.error },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.sm },
    cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md },
    cancelText: { ...t.typography.label, color: t.color.text.foreground },
    delete: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      backgroundColor: t.color.status.error,
    },
    deleteText: { ...t.typography.label, color: t.color.text.onPrimary },
    disabled: { opacity: 0.55 },
  });
}
