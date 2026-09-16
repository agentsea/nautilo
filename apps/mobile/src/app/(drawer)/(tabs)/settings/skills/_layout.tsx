import { Stack, router } from "expo-router";

import { AppBar, AppBarBackButton } from "@/components/app-bar";

function returnToSettings(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/(drawer)/(tabs)/settings");
}

/** Nested, native Settings navigation for catalogue and individual Skills. */
export default function SkillsLayout() {
  return (
    <Stack
      screenOptions={{
        header: ({ options }) => (
          <AppBar
            title={typeof options.title === "string" ? options.title : "Skills"}
            left={<AppBarBackButton onPress={returnToSettings} />}
          />
        ),
      }}
    >
      <Stack.Screen name="index" options={{ title: "Skills" }} />
      <Stack.Screen name="[name]" options={{ title: "Skill" }} />
    </Stack>
  );
}
