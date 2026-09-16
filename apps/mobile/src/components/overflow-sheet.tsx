// D383 Stage 1 — top-bar ⋯ overflow menu (design-map §3.5).
// D424 — Theme applies inline (System/Light/Dark); Settings keeps ThemeToggle.
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/providers/auth";
import { useAppTheme, useThemePreference, type ThemePreference } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type OverflowSheetProps = {
  visible: boolean;
  onClose: () => void;
};

type RowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  disabled?: boolean;
  destructive?: boolean;
  onPress?: () => void;
};

const THEME_SEGMENTS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function OverflowRow({ icon, label, hint, disabled, destructive, onPress }: RowProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createRowStyles(t), [t]);
  const color = destructive
    ? t.color.status.error
    : disabled
      ? t.color.text.dim
      : t.color.text.foreground;

  return (
    <Pressable
      style={[styles.row, disabled && styles.rowDisabled]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
    >
      <Ionicons name={icon} size={20} color={color} />
      <View style={styles.meta}>
        <Text style={[styles.label, { color }]}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

function ThemeSection({ onClose }: { onClose: () => void }) {
  const t = useAppTheme();
  const styles = useMemo(() => createThemeSectionStyles(t), [t]);
  const { preference, setPreference } = useThemePreference();

  const handleSelect = (value: ThemePreference): void => {
    setPreference(value);
    onClose();
  };

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Ionicons name="color-palette-outline" size={20} color={t.color.text.foreground} />
        <Text style={styles.headerLabel}>Theme</Text>
      </View>
      <View style={styles.track}>
        {THEME_SEGMENTS.map((seg) => {
          const active = seg.value === preference;
          return (
            <Pressable
              key={seg.value}
              onPress={() => handleSelect(seg.value)}
              style={[styles.segment, active && styles.segmentActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Theme: ${seg.label}`}
            >
              <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
                {seg.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function OverflowSheet({ visible, onClose }: OverflowSheetProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();

  const handleSignOut = (): void => {
    onClose();
    void (async () => {
      await signOut();
      router.replace("/(onboarding)/sign-in");
    })();
  };
  const openSettings = (path: "/settings/approvals" | "/settings/human-profile" | "/settings/skills"): void => {
    onClose();
    router.push(path);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss menu"
        />
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + t.spacing.lg }]}
          accessibilityViewIsModal>
          <View style={styles.handle} />
          <Text style={styles.title}>Menu</Text>
          <ThemeSection onClose={onClose} />
          <OverflowRow
            icon="flash-outline"
            label="Approvals"
            hint="Review standing approvals"
            onPress={() => openSettings("/settings/approvals")}
          />
          <OverflowRow icon="sparkles-outline" label="Skills" hint="Browse and configure Agent Skills" onPress={() => openSettings("/settings/skills")} />
          <OverflowRow icon="person-outline" label="Account" hint="Your Human profile" onPress={() => openSettings("/settings/human-profile")} />
          <View style={styles.divider} />
          <OverflowRow
            icon="log-out-outline"
            label="Sign out"
            destructive
            onPress={handleSignOut}
          />
        </View>
      </View>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    modalRoot: {
      flex: 1,
      justifyContent: "flex-end",
    },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.5)",
    },
    sheet: {
      maxHeight: "80%",
      backgroundColor: t.color.surface.panel,
      borderTopLeftRadius: t.radii.lg,
      borderTopRightRadius: t.radii.lg,
      paddingHorizontal: t.spacing.lg,
      paddingTop: t.spacing.sm,
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.border.strong,
      marginBottom: t.spacing.md,
    },
    title: {
      color: t.color.text.foreground,
      ...t.typography.subheading,
      marginBottom: t.spacing.md,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.color.border.default,
      marginVertical: t.spacing.sm,
    },
  });
}

function createRowStyles(t: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
    },
    rowDisabled: { opacity: 0.55 },
    meta: { flex: 1, gap: 2 },
    label: { ...t.typography.bodyStrong },
    hint: { color: t.color.text.muted, ...t.typography.caption },
  });
}

function createThemeSectionStyles(t: AppTheme) {
  return StyleSheet.create({
    section: {
      gap: t.spacing.sm,
      paddingBottom: t.spacing.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
    },
    headerLabel: {
      ...t.typography.bodyStrong,
      color: t.color.text.foreground,
    },
    track: {
      flexDirection: "row",
      gap: t.spacing.xs,
      padding: t.spacing.xs,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    segment: {
      flex: 1,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentActive: {
      backgroundColor: t.color.action.primaryBg,
    },
    segmentLabel: {
      ...t.typography.label,
      color: t.color.text.muted,
    },
    segmentLabelActive: {
      color: t.color.text.onPrimary,
    },
  });
}
