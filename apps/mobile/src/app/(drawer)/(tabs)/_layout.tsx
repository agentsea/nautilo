import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/providers/auth";
import { useNotificationState } from "@/providers/notification-state";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";

// D369 §3 — the 4-tab bottom bar: Chats / Memory / Files / Settings.
// D383 Stage 1 — per-screen AppBar (headerShown: false here); tabs stay stable.
// Gate: no active server → add-server; server-but-signed-out → sign-in.
export default function TabsLayout() {
  const { activeServer, loading } = useServers();
  const { status } = useAuth();
  const { activeAttention } = useNotificationState();
  const t = useAppTheme();

  if (loading || status === "loading") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.color.surface.background,
        }}
      >
        <ActivityIndicator color={t.color.brand.accent} />
      </View>
    );
  }
  if (!activeServer) {
    return <Redirect href="/(onboarding)/add-server" />;
  }
  if (status === "signed-out") {
    return <Redirect href="/(onboarding)/sign-in" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.color.brand.accent,
        tabBarInactiveTintColor: t.color.text.dim,
        tabBarStyle: {
          backgroundColor: t.color.surface.background,
          borderTopColor: t.color.border.default,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarBadge: activeAttention?.importantText ?? (activeAttention?.hasUnread ? "•" : undefined),
          tabBarAccessibilityLabel: activeAttention?.accessibilityLabel ?? "Chats",
          tabBarBadgeStyle: {
            backgroundColor: t.color.brand.accent,
            color: t.color.text.onPrimary,
            ...(activeAttention?.importantText
              ? { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5 }
              : {
                  minWidth: 9,
                  height: 9,
                  borderRadius: 5,
                  paddingHorizontal: 0,
                  // Android Fabric rejects zero-sized text during native
                  // measurement. Hide the bullet against the dot instead.
                  color: t.color.brand.accent,
                  fontSize: 1,
                }),
          },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="memory"
        options={{
          title: "Memory",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="sparkles-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="files"
        options={{
          title: "Files",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="folder-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
