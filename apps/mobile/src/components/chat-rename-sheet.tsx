import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { CHAT_LABEL_MAX_LENGTH, validateChatLabel } from "@/features/chat-management/chat-management-model";
import { getApiClient } from "@/lib/api";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomDetailResponse } from "@nautilo/types";

type Props = {
  visible: boolean;
  roomId: string | null;
  initialLabel: string;
  serverUrl: string | undefined;
  onClose: () => void;
  onRenamed: (room: RoomDetailResponse) => void;
};

/** One keyboard-safe rename surface used by the catalogue and chat header. */
export function ChatRenameSheet({
  visible,
  roomId,
  initialLabel,
  serverUrl,
  onClose,
  onRenamed,
}: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [draft, setDraft] = useState(initialLabel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(initialLabel);
    setError(null);
  }, [initialLabel, visible]);

  const save = async (): Promise<void> => {
    if (!roomId || !serverUrl || requestRef.current) return;
    const validation = validateChatLabel(draft);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    if (validation.label === initialLabel.trim()) {
      onClose();
      return;
    }
    const request = (async () => {
      setSaving(true);
      setError(null);
      try {
        const room = await getApiClient(serverUrl).renameRoom(roomId, { label: validation.label });
        onRenamed(room);
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not rename this chat. Try again.");
      } finally {
        setSaving(false);
      }
    })();
    requestRef.current = request;
    try {
      await request;
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={saving ? undefined : onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.modalRoot}>
        <Pressable
          style={styles.backdrop}
          onPress={saving ? undefined : onClose}
          disabled={saving}
          accessible={false}>
          <Pressable
            style={styles.dialog}
            onPress={(event) => event.stopPropagation()}
            accessible={false}
            accessibilityLabel="Rename chat"
            accessibilityViewIsModal
            importantForAccessibility="yes">
            <ScrollView
              style={styles.formBody}
              contentContainerStyle={styles.formContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}>
              <Text style={styles.title}>Rename chat</Text>
              <Text style={styles.label}>Chat name</Text>
              <TextInput
                autoFocus
                value={draft}
                onChangeText={(value) => {
                  setDraft(value);
                  if (error) setError(null);
                }}
                style={styles.input}
                maxLength={CHAT_LABEL_MAX_LENGTH}
                placeholder="Chat name"
                placeholderTextColor={t.color.text.dim}
                accessibilityLabel="Rename chat"
                returnKeyType="done"
                onSubmitEditing={() => void save()}
              />
              <Text style={styles.count} accessibilityLabel={`${draft.length} of ${CHAT_LABEL_MAX_LENGTH} characters`}>
                {draft.length}/{CHAT_LABEL_MAX_LENGTH}
              </Text>
              {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
            </ScrollView>
            <View style={styles.actions}>
              <Pressable
                style={[styles.button, styles.cancelButton]}
                onPress={onClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Cancel rename">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.saveButton, saving && styles.disabled]}
                onPress={() => void save()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Save chat name">
                {saving ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.saveText}>Save</Text>}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    modalRoot: {
      flex: 1,
    },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.48)",
      alignItems: "center",
      justifyContent: "center",
      padding: t.spacing.lg,
    },
    dialog: {
      width: "100%",
      maxWidth: 420,
      maxHeight: "100%",
      flexShrink: 1,
      padding: t.spacing.lg,
      borderRadius: t.radii.lg,
      backgroundColor: t.color.surface.panel,
      shadowColor: "#000",
      shadowOpacity: 0.24,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    formBody: { flexShrink: 1 },
    formContent: { gap: t.spacing.sm },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    label: { color: t.color.text.muted, ...t.typography.caption },
    input: {
      minHeight: 48,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    count: { alignSelf: "flex-end", color: t.color.text.dim, ...t.typography.caption },
    error: { color: t.color.status.error, ...t.typography.caption },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.sm, marginTop: t.spacing.sm },
    button: { minWidth: 88, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, paddingHorizontal: t.spacing.md },
    cancelButton: { borderWidth: 1, borderColor: t.color.border.default },
    saveButton: { backgroundColor: t.color.action.primaryBg },
    disabled: { opacity: 0.6 },
    cancelText: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    saveText: { color: t.color.text.onPrimary, ...t.typography.bodyStrong },
  });
}
