import { expect, mock, test } from "bun:test";

import appConfig from "../../app.json";
import { EXPO_PUSH_ANDROID_CHANNEL_ID } from "../../../../packages/server/src/push/expo-push-provider";

// This test imports the Mobile source only to assert the cross-process
// contract. Keep native modules out of Bun's non-React-Native runtime.
mock.module("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 5 },
  IosAuthorizationStatus: {},
  PermissionStatus: {},
}));
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));

const { NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID } = await import("./push-installation");

test("D468 uses the same Android channel in native configuration, setup, and Expo payloads", () => {
  const notificationPlugin = appConfig.expo.plugins.find((plugin) =>
    Array.isArray(plugin) && plugin[0] === "expo-notifications",
  );
  const pluginOptions = Array.isArray(notificationPlugin)
    ? notificationPlugin[1] as { defaultChannel?: unknown } | undefined
    : undefined;

  expect(pluginOptions?.defaultChannel).toBe(NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID);
  expect(EXPO_PUSH_ANDROID_CHANNEL_ID).toBe(NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID);
});
