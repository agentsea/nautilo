import { Stack, router } from "expo-router";

import { AppBar, AppBarBackButton } from "@/components/app-bar";

function returnToSettings(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/(drawer)/(tabs)/settings");
}

export default function CommandsLayout() {
  return (
    <Stack
      screenOptions={{
        header: ({ options }) => (
          <AppBar
            title={typeof options.title === "string" ? options.title : "Commands"}
            left={<AppBarBackButton onPress={returnToSettings} />}
          />
        ),
      }}
    >
      <Stack.Screen name="index" options={{ title: "Commands" }} />
      <Stack.Screen name="new" options={{ title: "New Command" }} />
      <Stack.Screen name="[name]" options={{ title: "Command" }} />
    </Stack>
  );
}
