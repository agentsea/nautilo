import { AppState, type AppStateStatus } from "react-native";

export type AppLifecycleState = AppStateStatus;

export interface AppLifecycleSubscription {
  remove(): void;
}

export interface AppLifecycle {
  currentState(): AppLifecycleState;
  addEventListener(
    event: "change",
    listener: (state: AppLifecycleState) => void,
  ): AppLifecycleSubscription;
}

/** Native projection. Its behavior and AppState event contract are unchanged. */
export const appLifecycle: AppLifecycle = {
  currentState: () => AppState.currentState,
  addEventListener: (_event, listener) => AppState.addEventListener("change", listener),
};
