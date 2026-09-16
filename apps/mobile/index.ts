import { LogBox } from "react-native";
import EventSource from "react-native-sse";

// Register development-only dependency warning filters before Expo Router is
// imported. Router 57's bundled React Navigation stack reads
// InteractionManager while its modules initialize, which is earlier than the
// root layout can install a LogBox filter.
if (__DEV__) {
  LogBox.ignoreLogs(["InteractionManager has been deprecated"]);
}

// api-client's artifact SSE client reads the browser-global EventSource.
// Install React Native's implementation before Expo Router imports any route.
if (typeof globalThis.EventSource !== "function") {
  globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

// This must stay a runtime import: a static import is hoisted ahead of the
// LogBox registration above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("expo-router/entry");
