import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface SoulEditorSheetProps {
  visible: boolean;
  value: string;
  onApply: (value: string) => void;
  onClose: () => void;
}

/** Dedicated editor so a long Soul file cannot become a nested profile scroller. */
export function SoulEditorSheet({ visible, value, onApply, onClose }: SoulEditorSheetProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [draft, setDraft] = useState(value);

  useEffect(() => { if (visible) setDraft(value); }, [value, visible]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.content} behavior="padding">
        <View style={styles.heading}>
          <Pressable onPress={onClose} style={styles.headerAction} accessibilityRole="button" accessibilityLabel="Cancel Soul instruction changes"><Text style={styles.secondaryText}>Cancel</Text></Pressable>
          <Text style={styles.title}>Soul instructions</Text>
          <Pressable onPress={() => { onApply(draft); onClose(); }} style={styles.headerAction} accessibilityRole="button" accessibilityLabel="Apply Soul instruction changes"><Text style={styles.doneText}>Done</Text></Pressable>
        </View>
        <Text style={styles.help}>These instructions shape how your Agent behaves. Changes apply when you save the Agent profile.</Text>
        <TextInput value={draft} onChangeText={setDraft} multiline scrollEnabled textAlignVertical="top" style={styles.editor} accessibilityLabel="Edit Soul instructions" />
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: t.color.surface.background },
  content: { flex: 1, gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.lg },
  heading: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.sm },
  headerAction: { minWidth: 64, minHeight: 44, alignItems: "center", justifyContent: "center" },
  title: { ...t.typography.subheading, color: t.color.text.foreground },
  help: { ...t.typography.caption, color: t.color.text.muted },
  editor: { flex: 1, minHeight: 240, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.md, backgroundColor: t.color.surface.panel, color: t.color.text.foreground, ...t.typography.body },
  secondaryText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
  doneText: { ...t.typography.bodyStrong, color: t.color.brand.accent },
}); }
