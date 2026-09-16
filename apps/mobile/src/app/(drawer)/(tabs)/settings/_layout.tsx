import { Stack, router } from "expo-router";

import { AppBar, AppBarBackButton } from "@/components/app-bar";

function returnToSettings(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/(drawer)/(tabs)/settings");
}

/** Native stack contained by the Settings tab. */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        header: ({ options }) => (
          <AppBar
            title={typeof options.title === "string" ? options.title : "Settings"}
            left={<AppBarBackButton onPress={returnToSettings} />}
          />
        ),
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="user-agreement" options={{ title: "User Agreement" }} />
      <Stack.Screen name="about" options={{ title: "About" }} />
      <Stack.Screen name="profile" options={{ headerShown: false }} />
      <Stack.Screen name="agent-photos" options={{ headerShown: false }} />
      <Stack.Screen name="human-profile" options={{ headerShown: false }} />
      <Stack.Screen name="security" options={{ headerShown: false }} />
      <Stack.Screen name="account-deletion" options={{ title: "Delete Account" }} />
      <Stack.Screen name="voice" options={{ headerShown: false }} />
      <Stack.Screen name="voice-picker" options={{ headerShown: false }} />
      <Stack.Screen name="skills" options={{ headerShown: false }} />
      <Stack.Screen name="commands" options={{ headerShown: false }} />
    </Stack>
  );
}
