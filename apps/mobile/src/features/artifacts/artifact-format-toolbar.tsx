import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type IconName = keyof typeof Ionicons.glyphMap;

export type ArtifactFormatToolbarAction = {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly glyph?: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly hint?: string;
};

export type ArtifactFormatToolbarSheet = {
  readonly label: string;
  readonly title: string;
  readonly icon?: IconName;
  readonly glyph?: string;
  readonly actions: readonly ArtifactFormatToolbarAction[];
};

export type ArtifactFormatToolbarLink = {
  readonly label: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly currentUrl?: string;
  readonly validate: (url: string) => boolean;
  readonly invalidMessage: string;
  readonly onSubmit: (url: string) => void;
  readonly onRemove?: () => void;
};

type Props = {
  readonly accessibilityLabel: string;
  /** Common, immediate editor commands in Desktop Writer semantic order. */
  readonly primaryActions: readonly ArtifactFormatToolbarAction[];
  /** A mode action (such as Markdown Preview) placed after the shared Link control. */
  readonly afterLinkActions?: readonly ArtifactFormatToolbarAction[];
  /** Paragraph styles/headings/lists deliberately live in a focused sheet. */
  readonly formatSheet?: ArtifactFormatToolbarSheet;
  /** Link add/edit/remove deliberately lives in a focused sheet. */
  readonly link?: ArtifactFormatToolbarLink;
  /** Adapter-owned request to open Link from a native selection-menu action. */
  readonly linkOpenRequest?: number;
  /** Clears the adapter's captured native range once its requested Link sheet closes. */
  readonly onNativeLinkSheetClose?: () => void;
  /** Adapter-owned native input focus, restored only after the sheet dismisses. */
  readonly onReturnToEditor?: () => void;
};

type SheetName = "format" | "link" | null;

/** One-shot adapter-focus gate shared by iOS dismissal and Android close commit. */
function consumePendingEditorFocus(
  pending: { current: boolean },
  onReturnToEditor: (() => void) | undefined,
): boolean {
  if (!pending.current) return false;
  pending.current = false;
  onReturnToEditor?.();
  return true;
}

/**
 * Presentation-only mobile formatting shell. Editors retain ownership of text,
 * selection, layout, and history; adapters provide command callbacks and the
 * upstream-derived selected/disabled state for each control.
 */
export function ArtifactFormatToolbar({
  accessibilityLabel,
  primaryActions,
  afterLinkActions = [],
  formatSheet,
  link,
  linkOpenRequest = 0,
  onNativeLinkSheetClose,
  onReturnToEditor,
}: Props) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [openSheet, setOpenSheet] = useState<SheetName>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkInputRef = useRef<TextInput>(null);
  const restoreFocusPending = useRef(false);
  const waitForKeyboardHide = useRef(false);
  const handledLinkOpenRequest = useRef(linkOpenRequest);
  const nativeLinkSheetOpen = useRef(false);

  useEffect(() => {
    if (openSheet === "link") {
      setLinkDraft(link?.currentUrl ?? "https://");
      setLinkError(null);
    }
  }, [link?.currentUrl, openSheet]);

  useEffect(() => {
    if (linkOpenRequest === handledLinkOpenRequest.current) return;
    handledLinkOpenRequest.current = linkOpenRequest;
    if (link && !link.disabled) {
      nativeLinkSheetOpen.current = true;
      setOpenSheet("link");
    }
  }, [link, linkOpenRequest]);

  const closeSheet = () => {
    if (openSheet === null) return;
    if (openSheet === "link" && nativeLinkSheetOpen.current) {
      nativeLinkSheetOpen.current = false;
      onNativeLinkSheetClose?.();
    }
    restoreFocusPending.current = true;
    waitForKeyboardHide.current =
      Platform.OS === "android" && openSheet === "link" && Keyboard.isVisible();
    if (waitForKeyboardHide.current) Keyboard.dismiss();
    setOpenSheet(null);
  };
  const returnToEditorIfPending = useCallback(
    () => consumePendingEditorFocus(restoreFocusPending, onReturnToEditor),
    [onReturnToEditor, restoreFocusPending],
  );
  useEffect(() => {
    if (Platform.OS === "android" && openSheet === null) {
      if (waitForKeyboardHide.current && Keyboard.isVisible()) return;
      waitForKeyboardHide.current = false;
      returnToEditorIfPending();
    }
  }, [openSheet, returnToEditorIfPending]);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = Keyboard.addListener("keyboardDidHide", () => {
      if (!waitForKeyboardHide.current) return;
      waitForKeyboardHide.current = false;
      returnToEditorIfPending();
    });
    return () => subscription.remove();
  }, [returnToEditorIfPending]);
  const formatDisabled =
    formatSheet?.actions.every((action) => action.disabled === true) ?? true;
  const linkDraftValid = link?.validate(linkDraft) ?? false;
  const submitLink = () => {
    if (!link) return;
    if (!link.validate(linkDraft)) {
      setLinkError(link.invalidMessage);
      return;
    }
    link.onSubmit(linkDraft);
    closeSheet();
  };

  return (
    <View style={styles.root} accessibilityLabel={accessibilityLabel}>
      <View style={styles.toolbar}>
        {primaryActions.map((action) => (
          <ToolbarButton
            key={action.id}
            action={action}
            styles={styles}
            theme={theme}
          />
        ))}
        {link ? (
          <ToolbarButton
            action={{
              id: "link",
              label: link.label,
              icon: "link-outline",
              selected: link.selected,
              disabled: link.disabled,
              hint: link.hint,
              onPress: () => setOpenSheet("link"),
            }}
            styles={styles}
            theme={theme}
          />
        ) : null}
        {afterLinkActions.map((action) => (
          <ToolbarButton
            key={action.id}
            action={action}
            styles={styles}
            theme={theme}
          />
        ))}
        {formatSheet ? (
          <ToolbarButton
            action={{
              id: "format",
              label: formatSheet.label,
              glyph: formatSheet.glyph ?? "¶",
              icon: formatSheet.icon,
              disabled: formatDisabled,
              hint: formatDisabled
                ? "Unavailable for the current selection"
                : undefined,
              onPress: () => setOpenSheet("format"),
            }}
            styles={styles}
            theme={theme}
          />
        ) : null}
      </View>

      <Modal
        visible={openSheet !== null}
        transparent
        animationType="slide"
        statusBarTranslucent
        onDismiss={returnToEditorIfPending}
        onShow={() => {
          if (openSheet === "link") linkInputRef.current?.focus();
        }}
        onRequestClose={closeSheet}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalRoot}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss formatting sheet"
            onPress={closeSheet}
            style={styles.backdrop}
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              { paddingBottom: Math.max(insets.bottom, theme.spacing.lg) },
            ]}
          >
            <View style={styles.handle} />
            {openSheet === "format" && formatSheet ? (
              <View
                accessibilityLabel={`${formatSheet.title} sheet`}
                style={styles.sheetContent}
              >
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>{formatSheet.title}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel formatting"
                    onPress={closeSheet}
                    style={({ pressed }) => [
                      styles.headerCancel,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                </View>
                <View
                  accessibilityLabel={`${formatSheet.title} options`}
                  style={styles.formatActions}
                >
                  {formatSheet.actions.map((action) => (
                    <Pressable
                      key={action.id}
                      accessibilityRole="button"
                      accessibilityLabel={action.label}
                      accessibilityHint={
                        action.disabled
                          ? "Unavailable for the current selection"
                          : action.hint
                      }
                      accessibilityState={{
                        disabled: action.disabled,
                        selected: action.selected,
                      }}
                      disabled={action.disabled}
                      onPress={() => {
                        action.onPress();
                        closeSheet();
                      }}
                      style={({ pressed }) => [
                        styles.sheetAction,
                        action.selected && styles.selectedSheetAction,
                        action.disabled && styles.disabled,
                        pressed && !action.disabled && styles.pressed,
                      ]}
                    >
                      <ToolbarIcon
                        action={action}
                        color={
                          action.selected
                            ? theme.color.text.onPrimary
                            : theme.color.text.foreground
                        }
                      />
                      <Text
                        adjustsFontSizeToFit
                        minimumFontScale={0.8}
                        numberOfLines={1}
                        style={[
                          styles.sheetActionText,
                          action.selected && styles.selectedText,
                        ]}
                      >
                        {action.label}
                      </Text>
                      {action.selected ? (
                        <Ionicons
                          name="checkmark"
                          size={18}
                          color={theme.color.text.onPrimary}
                        />
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {openSheet === "link" && link ? (
              <View
                accessibilityLabel="Link editing sheet"
                style={styles.sheetContent}
              >
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>
                    {link.selected ? "Edit link" : "Add link"}
                  </Text>
                </View>
                <TextInput
                  ref={linkInputRef}
                  accessibilityLabel="Link address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  keyboardType="url"
                  onChangeText={(value) => {
                    setLinkDraft(value);
                    setLinkError(null);
                  }}
                  placeholder="https://example.com"
                  placeholderTextColor={theme.color.text.dim}
                  selectTextOnFocus
                  style={styles.linkInput}
                  value={linkDraft}
                />
                {linkError ? (
                  <Text accessibilityRole="alert" style={styles.error}>
                    {linkError}
                  </Text>
                ) : null}
                <View style={styles.linkActions}>
                  {link.onRemove && link.selected ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Remove link"
                      onPress={() => {
                        link.onRemove?.();
                        closeSheet();
                      }}
                      style={({ pressed }) => [
                        styles.removeButton,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.removeText}>Remove</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel link editing"
                    onPress={closeSheet}
                    style={({ pressed }) => [
                      styles.footerCancel,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      link.selected ? "Update link" : "Add link"
                    }
                    accessibilityState={{ disabled: !linkDraftValid }}
                    disabled={!linkDraftValid}
                    onPress={submitLink}
                    style={({ pressed }) => [
                      styles.submitButton,
                      !linkDraftValid && styles.disabled,
                      pressed && linkDraftValid && styles.pressed,
                    ]}
                  >
                    <Text style={styles.submitText}>
                      {link.selected ? "Update" : "Add"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function ToolbarButton({
  action,
  styles,
  theme,
}: {
  action: ArtifactFormatToolbarAction;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityHint={
        action.disabled ? "Unavailable for the current selection" : action.hint
      }
      accessibilityState={{
        disabled: action.disabled,
        selected: action.selected,
      }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.control,
        action.selected && styles.selected,
        action.disabled && styles.disabled,
        pressed && !action.disabled && styles.pressed,
      ]}
    >
      <ToolbarIcon
        action={action}
        color={
          action.selected
            ? theme.color.text.onPrimary
            : theme.color.text.foreground
        }
      />
    </Pressable>
  );
}

function ToolbarIcon({
  action,
  color,
}: {
  action: ArtifactFormatToolbarAction;
  color: string;
}) {
  if (action.icon)
    return <Ionicons name={action.icon} size={21} color={color} />;
  return (
    <Text style={[glyphStyle, { color }]}>{action.glyph ?? action.label}</Text>
  );
}

const glyphStyle = { fontSize: 17, fontWeight: "700" as const, lineHeight: 20 };

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.color.border.default,
      backgroundColor: theme.color.surface.panel,
    },
    toolbar: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    control: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radii.sm,
      backgroundColor: "transparent",
    },
    selected: {
      borderColor: theme.color.border.interactive,
      backgroundColor: theme.color.action.primaryBg,
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.72 },
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.color.surface.overlay,
    },
    sheet: {
      gap: theme.spacing.sm,
      backgroundColor: theme.color.surface.panel,
      borderTopLeftRadius: theme.radii.lg,
      borderTopRightRadius: theme.radii.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: theme.radii.pill,
      backgroundColor: theme.color.border.strong,
    },
    sheetContent: { gap: theme.spacing.sm },
    sheetHeader: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    formatActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
    },
    sheetTitle: {
      color: theme.color.text.foreground,
      ...theme.typography.subheading,
    },
    sheetAction: {
      minHeight: 48,
      width: "48%",
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      borderRadius: theme.radii.sm,
      paddingHorizontal: theme.spacing.xs,
    },
    selectedSheetAction: { backgroundColor: theme.color.action.primaryBg },
    sheetActionText: {
      flex: 1,
      color: theme.color.text.foreground,
      ...theme.typography.body,
    },
    selectedText: { color: theme.color.text.onPrimary },
    linkInput: {
      minHeight: 48,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.sm,
      backgroundColor: theme.color.surface.element,
      color: theme.color.text.foreground,
      paddingHorizontal: theme.spacing.md,
      ...theme.typography.body,
    },
    error: { color: theme.color.status.error, ...theme.typography.caption },
    linkActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: theme.spacing.sm,
    },
    footerCancel: {
      minWidth: 72,
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.radii.sm,
    },
    headerCancel: {
      minWidth: 48,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.radii.sm,
    },
    cancelText: {
      color: theme.color.text.foreground,
      ...theme.typography.label,
    },
    removeButton: {
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.status.error,
      borderRadius: theme.radii.sm,
    },
    removeText: { color: theme.color.status.error, ...theme.typography.label },
    submitButton: {
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radii.sm,
      backgroundColor: theme.color.action.primaryBg,
    },
    submitText: {
      color: theme.color.text.onPrimary,
      ...theme.typography.label,
    },
  });
}
