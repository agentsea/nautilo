import { Stack } from "expo-router";

/** Root stack preserves the originating Chat beneath an exact Task inspection route. */
export default function TasksLayout() {
  return <Stack><Stack.Screen name="[taskId]" options={{ headerShown: false }} /></Stack>;
}
