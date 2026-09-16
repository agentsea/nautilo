import { ApiError, MessageEditConflictError } from "@nautilo/api-client/browser";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  initialMessageEditState,
  messageEditReducer,
  type EditableMobileMessage,
} from "@/components/message-edit-state";
import { MobileMessageEditAdmissionError } from "@/features/room-chat-pane/message-edit";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

function messageEditFailureText(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "This message can no longer be edited.";
  }
  if (error instanceof MobileMessageEditAdmissionError) return error.message;
  return "Could not save this edit. Your draft is preserved.";
}

type MessageEditSheetProps = {
  message: EditableMobileMessage;
  onClose: () => void;
  onSave: (
    messageId: string,
    body: { content: string; expectedRevision: number },
  ) => Promise<void>;
};

/** A dedicated editor so the Room composer draft remains completely untouched. */
export function MessageEditSheet({ message, onClose, onSave }: MessageEditSheetProps) {
  const t = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(t), [t]);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const [state, dispatch] = useReducer(
    messageEditReducer,
    message,
    initialMessageEditState,
  );
  const activeRef = useRef(true);
  const savingRef = useRef(false);

  useEffect(() => {
    // StrictMode replays effect setup/cleanup in development. Reactivate this
    // mounted editor so only a real unmount fences its in-flight completion.
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (savingRef.current || state.saving || message.editRevision <= state.baseRevision) return;
    if (state.draft === state.baseContent) {
      onClose();
      return;
    }
    dispatch({
      type: "conflict",
      content: message.content,
      editRevision: message.editRevision,
      source: "remote",
    });
  }, [
    message.editRevision,
    message.content,
    onClose,
    state.baseContent,
    state.baseRevision,
    state.draft,
    state.saving,
  ]);

  const close = (): void => {
    if (!savingRef.current && !state.saving) onClose();
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || state.saving || state.conflictReviewRequired) return;
    if (state.draft.trim().length === 0) {
      dispatch({ type: "save-started" });
      return;
    }
    savingRef.current = true;
    dispatch({ type: "save-started" });
    try {
      await onSave(message.id, {
        content: state.draft,
        expectedRevision: state.baseRevision,
      });
      if (activeRef.current) onClose();
    } catch (error) {
      if (!activeRef.current) return;
      if (error instanceof MessageEditConflictError) {
        dispatch({
          type: "conflict",
          content: error.current.content,
          editRevision: error.current.editRevision,
          source: "save",
        });
        return;
      }
      dispatch({ type: "save-failed", error: messageEditFailureText(error) });
    } finally {
      savingRef.current = false;
    }
  };

  const saveDisabled =
    state.saving || state.conflictReviewRequired || state.draft.trim().length === 0;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={styles.modalRoot}>
        <Pressable
          style={[styles.backdrop, { paddingTop: insets.top }]}
          onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}
          onPress={close}
          accessible={false}>
          <Pressable
            style={[styles.dialog, { paddingBottom: Math.max(insets.bottom, t.spacing.md) }]}
            onPress={(event) => event.stopPropagation()}
            accessible={false}
            accessibilityViewIsModal>
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              bounces={false}>
              <Text style={styles.title}>Edit message</Text>
              <TextInput
                autoFocus
                multiline
                value={state.draft}
                onChangeText={(value) => dispatch({ type: "draft", value })}
                editable={!state.saving}
                placeholder="Message"
                placeholderTextColor={t.color.text.dim}
                accessibilityLabel="Edit message text"
                style={[
                  styles.input,
                  // Reserve room for the heading, recovery copy and actions;
                  // the multiline field scrolls without truncating the draft.
                  availableHeight === null ? null : { maxHeight: Math.min(styles.input.maxHeight, availableHeight / 3) },
                ]}
              />
              {state.error ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {state.error}
                </Text>
              ) : null}
              {state.conflictCurrent ? (
                <View style={styles.conflict}>
                  <Text style={styles.conflictLabel}>Current message</Text>
                  <Text selectable style={styles.conflictText}>{state.conflictCurrent.content}</Text>
                  {state.conflictReviewRequired ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Confirm review of current message"
                      onPress={() => dispatch({ type: "conflict-reviewed" })}
                      style={styles.reviewButton}>
                      <Text style={styles.reviewButtonText}>I’ve reviewed this</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.reviewedText} accessibilityLiveRegion="polite">
                      Current message reviewed. Saving will replace it with your draft.
                    </Text>
                  )}
                </View>
              ) : null}
            </ScrollView>
            <View style={styles.actions}>
              <Pressable
                onPress={close}
                disabled={state.saving}
                accessibilityRole="button"
                accessibilityLabel="Cancel editing message"
                style={styles.cancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void save()}
                disabled={saveDisabled}
                accessibilityRole="button"
                accessibilityLabel="Save edited message"
                accessibilityState={{ disabled: saveDisabled }}
                style={[styles.save, saveDisabled ? styles.disabled : null]}>
                {state.saving ? (
                  <ActivityIndicator color={t.color.text.onPrimary} />
                ) : (
                  <Text style={styles.saveText}>Save</Text>
                )}
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
    modalRoot: { flex: 1 },
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.48)" },
    dialog: {
      maxHeight: "100%",
      flexShrink: 1,
      padding: t.spacing.lg,
      borderTopLeftRadius: t.radii.lg,
      borderTopRightRadius: t.radii.lg,
      backgroundColor: t.color.surface.panel,
    },
    body: { flexShrink: 1 },
    content: { gap: t.spacing.md },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    input: {
      minHeight: 112,
      maxHeight: 220,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
      textAlignVertical: "top",
      ...t.typography.body,
    },
    error: { ...t.typography.caption, color: t.color.status.error },
    conflict: {
      gap: t.spacing.sm,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
    },
    conflictLabel: { ...t.typography.label, color: t.color.text.foreground },
    conflictText: { ...t.typography.body, color: t.color.text.muted },
    reviewButton: {
      minHeight: 44,
      alignSelf: "flex-start",
      justifyContent: "center",
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.strong,
    },
    reviewButtonText: { ...t.typography.label, color: t.color.text.foreground },
    reviewedText: { ...t.typography.caption, color: t.color.text.muted },
    actions: { flexShrink: 0, flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.sm, paddingTop: t.spacing.md },
    cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md },
    cancelText: { ...t.typography.label, color: t.color.text.foreground },
    save: {
      minWidth: 96,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      backgroundColor: t.color.brand.accent,
    },
    saveText: { ...t.typography.label, color: t.color.text.onPrimary },
    disabled: { opacity: 0.55 },
  });
}
