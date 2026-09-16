// D383 Stage 2 — custom left-drawer content (design-map §3.5).
// Multi-server switcher, quick-jump rows, Settings, and sign out.
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";
import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/providers/auth";
import { useNotificationState } from "@/providers/notification-state";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type DrawerRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  disabled?: boolean;
  destructive?: boolean;
  onPress?: () => void;
};

function DrawerRow({ icon, label, hint, disabled, destructive, onPress }: DrawerRowProps) {
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

export function DrawerContent({ navigation }: DrawerContentComponentProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { servers, activeServer, switchTo, remove } = useServers();
  const { signOut } = useAuth();
  const { serverAttention } = useNotificationState();

  const close = (): void => {
    navigation.closeDrawer();
  };

  const handlePickServer = (id: string): void => {
    close();
    if (id === activeServer?.id) return;
    void switchTo(id);
  };

  const handleAddServer = (): void => {
    close();
    router.push("/(onboarding)/add-server");
  };

  const handleRemoveServer = (id: string, displayName: string): void => {
    Alert.alert(
      `Remove ${displayName}?`,
      "This removes the saved server and its sign-in from this phone. The server and its data are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => { void remove(id); },
        },
      ],
    );
  };

  const goTab = (href: "/" | "/memory" | "/files" | "/settings"): void => {
    close();
    router.push(href);
  };

  const goComputers = (): void => {
    close();
    router.push("/(drawer)/computers");
  };

  const goScheduledWork = (): void => {
    close();
    router.push("/(drawer)/scheduled-work");
  };

  const handleSignOut = (): void => {
    close();
    void (async () => {
      await signOut();
      router.replace("/(onboarding)/sign-in");
    })();
  };

  return (
    <DrawerContentScrollView
      style={{ backgroundColor: t.color.surface.background }}
      contentContainerStyle={[styles.scrollBody, { paddingTop: insets.top + t.spacing.md }]}
    >
      <Text style={styles.sectionTitle}>Servers</Text>
      {servers.map((s) => {
        const active = s.id === activeServer?.id;
        // The active server's attention is already shown by its Chats tab.
        const attention = active ? null : serverAttention(s.id, s.displayName);
        return (
          <View key={s.id} style={[styles.serverRow, active && styles.serverRowActive]}>
            <Pressable
              style={styles.serverSelect}
              onPress={() => handlePickServer(s.id)}
              accessibilityRole="button"
              accessibilityLabel={active
                ? `${s.displayName}, active`
                : attention?.accessibilityLabel ?? s.displayName}
            >
              <Ionicons name="server-outline" size={18} color={t.color.text.foreground} />
              <View style={styles.serverMeta}>
                <Text style={styles.serverName} numberOfLines={1}>{s.displayName}</Text>
                <Text style={styles.serverUrl} numberOfLines={1}>{s.serverUrl}</Text>
              </View>
              {active ? (
                <Ionicons name="checkmark" size={18} color={t.color.brand.accent} />
              ) : attention?.hasUnread ? (
                attention.importantText ? (
                  <View accessible={false} style={[styles.importantBadge, attention.stale && styles.staleAttention]}>
                    <Text style={styles.importantBadgeText}>{attention.importantText}</Text>
                  </View>
                ) : (
                  <View accessible={false} style={[styles.unreadDot, attention.stale && styles.staleAttention]} />
                )
              ) : null}
            </Pressable>
            <Pressable
              style={styles.serverMenu}
              onPress={() => handleRemoveServer(s.id, s.displayName)}
              accessibilityRole="button"
              accessibilityLabel={`Remove saved server ${s.displayName}`}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color={t.color.text.muted} />
            </Pressable>
          </View>
        );
      })}
      <Pressable style={styles.addServerRow} onPress={handleAddServer}>
        <Ionicons name="add-circle-outline" size={18} color={t.color.brand.accent} />
        <Text style={styles.addServerLabel}>Add server</Text>
      </Pressable>

      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Go to</Text>
      <DrawerRow
        icon="chatbubbles-outline"
        label="Chats"
        onPress={() => goTab("/")}
      />
      <DrawerRow
        icon="laptop-outline"
        label="Computers"
        onPress={goComputers}
      />
      <DrawerRow
        icon="time-outline"
        label="Scheduled work"
        hint="View and control server schedules"
        onPress={goScheduledWork}
      />
      <DrawerRow icon="library-outline" label="Memory" onPress={() => goTab("/memory")} />
      <DrawerRow icon="folder-outline" label="Files" onPress={() => goTab("/files")} />

      <View style={styles.divider} />
      <DrawerRow
        icon="settings-outline"
        label="Settings"
        hint="Profile, account, and appearance"
        onPress={() => goTab("/settings")}
      />
      <DrawerRow icon="log-out-outline" label="Sign out" destructive onPress={handleSignOut} />
    </DrawerContentScrollView>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    scrollBody: {
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.xl,
    },
    sectionTitle: {
      color: t.color.text.muted,
      ...t.typography.caption,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginBottom: t.spacing.sm,
      marginTop: t.spacing.xs,
    },
    serverRow: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: t.radii.sm,
    },
    serverSelect: {
      flex: 1,
      minHeight: 64,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
      paddingLeft: t.spacing.sm,
    },
    serverMenu: {
      minWidth: 48,
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    serverRowActive: { backgroundColor: t.color.surface.subtle },
    serverMeta: { flex: 1, gap: t.spacing.xs },
    serverName: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    serverUrl: { color: t.color.text.dim, ...t.typography.caption },
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: t.color.brand.accent,
    },
    importantBadge: {
      minWidth: 22,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.brand.accent,
    },
    importantBadgeText: { color: t.color.text.onPrimary, ...t.typography.caption },
    staleAttention: { opacity: 0.55 },
    addServerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
      paddingHorizontal: t.spacing.sm,
    },
    addServerLabel: { color: t.color.brand.accent, ...t.typography.bodyStrong },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.color.border.default,
      marginVertical: t.spacing.md,
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
