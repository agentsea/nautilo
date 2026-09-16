import { Stack } from "expo-router";

export default function ComputersLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="manual" options={{ title: "Pair a computer" }} />
      <Stack.Screen name="[remoteHostId]" options={{ headerShown: false }} />
    </Stack>
  );
}
