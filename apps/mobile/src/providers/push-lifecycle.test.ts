/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import type { PushLifecycleCoordinatorDeps } from "./push-lifecycle";
import type { PushReconcileSummary } from "@/lib/push-reconciler";

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
mock.module("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
}));
mock.module("expo-linking", () => ({ openSettings: async () => {} }));
mock.module("@/lib/auth", () => ({ ensureValidToken: mock(async () => "unused") }));
mock.module("@/lib/server-store", () => ({
  loadRegistry: mock(),
  loadServerRegistrationSnapshot: mock(),
  isServerRegistrationCurrent: mock(),
  loadTokenSnapshot: mock(),
}));
mock.module("@nautilo/api-client/browser", () => ({ NautiloApiClient: class {} }));
mock.module("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "undetermined" }),
  requestPermissionsAsync: async () => ({ status: "undetermined" }),
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[test]" }),
  getNotificationChannelAsync: async () => null,
  setNotificationChannelAsync: async () => null,
  addPushTokenListener: () => ({ remove: () => {} }),
  setBadgeCountAsync: async () => true,
  AndroidImportance: { DEFAULT: 5, NONE: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied" },
  IosAuthorizationStatus: { AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4, DENIED: 1 },
}));
mock.module("@/lib/push-reconciler", () => ({ createMobilePushReconciler: () => ({}) }));

const { createPushLifecycleCoordinator } = await import("./push-lifecycle");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const summary: PushReconcileSummary = {
  tombstones: { attempted: 0, cleared: 0, retained: 0 },
  native: "ready",
  servers: new Map(),
};

function fixture(overrides: Partial<PushLifecycleCoordinatorDeps> = {}) {
  let listener: ((state: "active" | "background" | "inactive") => void) | null = null;
  let removed = 0;
  let starts = 0;
  let stops = 0;
  let triggers = 0;
  let badgeStarts = 0;
  let badgeStops = 0;
  let badgeTriggers = 0;
  let activeRefreshes = 0;
  const trigger = async () => { triggers += 1; return summary; };
  const deps: PushLifecycleCoordinatorDeps = {
    reconciler: { start: () => { starts += 1; }, stop: () => { stops += 1; }, trigger },
    appState: {
      addEventListener: (_event, next) => {
        listener = next;
        return { remove: () => { removed += 1; listener = null; } };
      },
    },
    onAppActive: async () => { activeRefreshes += 1; },
    badgeReconciler: {
      start: () => { badgeStarts += 1; },
      stop: () => { badgeStops += 1; },
      trigger: async () => { badgeTriggers += 1; },
    },
    ...overrides,
  };
  return {
    coordinator: createPushLifecycleCoordinator(deps),
    fire: (state: "active" | "background" | "inactive") => listener?.(state),
    counts: () => ({ starts, stops, triggers, badgeStarts, badgeStops, badgeTriggers, activeRefreshes, removed }),
  };
}

describe("D468 root push lifecycle", () => {
  test("starts the headless reconciler once and only reconciles on app activation", async () => {
    const source = fixture();

    source.coordinator.start();
    source.coordinator.start();
    source.fire("background");
    source.fire("inactive");
    source.fire("active");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.counts()).toEqual({ starts: 1, stops: 0, triggers: 1, badgeStarts: 1, badgeStops: 0, badgeTriggers: 1, activeRefreshes: 2, removed: 0 });
  });

  test("coalesces repeated activation and explicit reconciliation while work is pending", async () => {
    const pending = deferred<void>();
    let triggers = 0;
    const source = fixture({
      reconciler: {
        start: () => {},
        stop: () => {},
        trigger: () => { triggers += 1; return pending.promise.then(() => summary); },
      },
    });

    source.coordinator.start();
    const first = source.coordinator.trigger();
    source.fire("active");
    const duplicate = source.coordinator.trigger();
    expect(first).toBe(duplicate);
    expect(triggers).toBe(1);
    pending.resolve();
    expect(await first).toBe(summary);
  });

  test("cleans up rejected foreground runs without creating unhandled promise children", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const source = fixture({
        reconciler: {
          start: () => {},
          stop: () => {},
          trigger: async () => { throw new Error("fetch failed"); },
        },
      });

      source.coordinator.start();
      const error = await source.coordinator.activate().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fetch failed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("observes native permission before reconciling and exposes one completed activation", async () => {
    const calls: string[] = [];
    const completions: PushReconcileSummary[] = [];
    const source = fixture({
      onAppActive: async () => { calls.push("permission"); },
      onActivationComplete: (next) => { completions.push(next); },
      reconciler: {
        start: () => {},
        stop: () => {},
        trigger: async () => { calls.push("reconcile"); return summary; },
      },
    });

    source.coordinator.start();
    const completed = source.coordinator.activate();
    expect(await completed).toBe(summary);
    expect(calls).toEqual(["permission", "reconcile", "permission"]);
    expect(completions).toEqual([summary]);
  });

  test("does not restart reconciliation when the provider stops during native observation", async () => {
    const pending = deferred<void>();
    let triggers = 0;
    const source = fixture({
      onAppActive: () => pending.promise,
      reconciler: {
        start: () => {},
        stop: () => {},
        trigger: async () => { triggers += 1; return summary; },
      },
    });

    source.coordinator.start();
    const activation = source.coordinator.activate();
    source.coordinator.stop();
    pending.resolve();

    expect(await activation).toMatchObject({ native: "unavailable" });
    expect(triggers).toBe(0);
  });

  test("stops the subscription and cancels the reconciler on unmount", () => {
    const source = fixture();
    source.coordinator.start();
    source.coordinator.stop();
    source.fire("active");

    expect(source.counts()).toEqual({ starts: 1, stops: 1, triggers: 0, badgeStarts: 1, badgeStops: 1, badgeTriggers: 0, activeRefreshes: 0, removed: 1 });
  });
});
