import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { currentServingOrigin, fullWorkbenchUrl } from "@/lib/browser-entry.web";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type WebDestination = Readonly<{
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  href: "/" | "/memory" | "/files" | "/settings" | "/(drawer)/scheduled-work";
}>;

const DESTINATIONS: readonly WebDestination[] = [
  { icon: "chatbubbles-outline", label: "Chats", href: "/" },
  { icon: "time-outline", label: "Scheduled work", href: "/(drawer)/scheduled-work" },
  { icon: "library-outline", label: "Memory", href: "/memory" },
  { icon: "folder-outline", label: "Files", href: "/files" },
  { icon: "settings-outline", label: "Settings", href: "/settings" },
];

export function DrawerContent({ navigation }: DrawerContentComponentProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { activeServer } = useServers();
  const { signOut } = useAuth();

  const close = () => navigation.closeDrawer();
  const navigate = (href: WebDestination["href"]) => {
    close();
    router.push(href);
  };
  const openFullWorkbench = () => {
    const origin = currentServingOrigin(typeof location === "undefined" ? null : location);
    if (origin) location.assign(fullWorkbenchUrl(origin));
  };
  const handleSignOut = () => {
    close();
    void signOut().then(() => router.replace("/(onboarding)/sign-in"));
  };

  return (
    <DrawerContentScrollView
      style={{ backgroundColor: t.color.surface.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + t.spacing.md }]}
    >
      <Text style={styles.eyebrow}>Mobile Web</Text>
      {activeServer ? (
        <View style={styles.serverContext} accessibilityLabel={`Connected to ${activeServer.displayName}`}>
          <Ionicons name="server-outline" size={18} color={t.color.text.foreground} />
          <View style={styles.copy}>
            <Text style={styles.serverName}>{activeServer.displayName}</Text>
            <Text style={styles.serverUrl} numberOfLines={1}>{activeServer.serverUrl}</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.divider} />
      {DESTINATIONS.map((destination) => (
        <Pressable
          key={destination.href}
          accessibilityRole="button"
          style={styles.row}
          onPress={() => navigate(destination.href)}
        >
          <Ionicons name={destination.icon} size={20} color={t.color.text.foreground} />
          <Text style={styles.label}>{destination.label}</Text>
        </Pressable>
      ))}

      <View style={styles.divider} />
      <Pressable accessibilityRole="link" style={styles.row} onPress={openFullWorkbench}>
        <Ionicons name="open-outline" size={20} color={t.color.brand.accent} />
        <Text style={styles.link}>Open Full Workbench</Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        style={styles.row}
        onPress={() => { close(); router.push({ pathname: "/(onboarding)/add-server", params: { external: "1" } }); }}
      >
        <Ionicons name="globe-outline" size={20} color={t.color.brand.accent} />
        <Text style={styles.link}>Open another server</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.row} onPress={handleSignOut}>
        <Ionicons name="log-out-outline" size={20} color={t.color.status.error} />
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </DrawerContentScrollView>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl },
    eyebrow: { ...t.typography.caption, color: t.color.text.muted, textTransform: "uppercase", letterSpacing: 0.6 },
    serverContext: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingVertical: t.spacing.md },
    copy: { flex: 1, gap: t.spacing.xs },
    serverName: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    serverUrl: { ...t.typography.caption, color: t.color.text.dim },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.default, marginVertical: t.spacing.md },
    row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.md },
    label: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    link: { ...t.typography.bodyStrong, color: t.color.brand.accent },
    signOut: { ...t.typography.bodyStrong, color: t.color.status.error },
  });
}
