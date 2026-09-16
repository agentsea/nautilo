import { Stack } from "expo-router";

/** A drawer destination, intentionally separate from chat composition routes. */
export default function ScheduledWorkLayout() {
  return <Stack><Stack.Screen name="index" options={{ headerShown: false }} /></Stack>;
}
