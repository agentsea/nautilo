/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Notifications from "expo-notifications";
import type { PushPermissionPolicyDeps } from "./push-permission-policy";

const getPermissionsAsync = mock();
const requestPermissionsAsync = mock();
const setBadgeCountAsync = mock(async () => true);
const getNotificationChannelAsync = mock(
  (async () => null) as typeof Notifications.getNotificationChannelAsync,
);

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
mock.module("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
mock.module("expo-notifications", () => ({
  getPermissionsAsync,
  requestPermissionsAsync,
  setBadgeCountAsync,
  getNotificationChannelAsync,
  AndroidImportance: { NONE: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  IosAuthorizationStatus: {
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
    DENIED: 1,
  },
}));

const { createPushPermissionPolicy } = await import("./push-permission-policy");

function permission(
  status: "granted" | "denied" | "undetermined",
  overrides: Record<string, unknown> = {},
): Awaited<ReturnType<typeof Notifications.getPermissionsAsync>> {
  return { status, canAskAgain: status === "undetermined", ...overrides } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
}

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
  };
}

function deps(overrides: Partial<PushPermissionPolicyDeps> = {}): PushPermissionPolicyDeps {
  return {
    storage: storage(),
    notifications: {
      getPermissionsAsync: getPermissionsAsync as typeof Notifications.getPermissionsAsync,
      requestPermissionsAsync: requestPermissionsAsync as typeof Notifications.requestPermissionsAsync,
      setBadgeCountAsync: setBadgeCountAsync as typeof Notifications.setBadgeCountAsync,
      getNotificationChannelAsync: getNotificationChannelAsync as typeof Notifications.getNotificationChannelAsync,
      androidImportanceNone: 2 as Notifications.AndroidImportance,
      permissionStatus: { GRANTED: "granted", DENIED: "denied" } as typeof Notifications.PermissionStatus,
      iosAuthorization: { AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4, DENIED: 1 } as typeof Notifications.IosAuthorizationStatus,
    },
    platform: "ios",
    ...overrides,
  };
}

describe("D468 device push permission policy", () => {
  beforeEach(() => {
    getPermissionsAsync.mockReset();
    requestPermissionsAsync.mockReset();
    setBadgeCountAsync.mockReset();
    getNotificationChannelAsync.mockReset();
    getNotificationChannelAsync.mockResolvedValue(null);
    setBadgeCountAsync.mockResolvedValue(true);
  });

  test("observes an undetermined state without causing a surprise OS prompt", async () => {
    getPermissionsAsync.mockResolvedValue(permission("undetermined"));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toMatchObject({
      permission: "unknown",
      canRequestPermission: true,
      badge: "unavailable",
      importantChannel: "not_applicable",
      alertCapability: "unavailable",
    });
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test("requests only after an explicit action, then exposes the actual denied result", async () => {
    getPermissionsAsync.mockResolvedValueOnce(permission("undetermined"));
    requestPermissionsAsync.mockResolvedValue(permission("denied"));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.requestPermission()).toMatchObject({
      permission: "denied",
      canRequestPermission: false,
      badge: "unavailable",
      importantChannel: "not_applicable",
      alertCapability: "unavailable",
    });
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("reports an Android channel disabled by the Human without mutating it", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted"));
    getNotificationChannelAsync.mockResolvedValue({
      id: "important-messages",
      importance: 2,
    } as Awaited<ReturnType<typeof Notifications.getNotificationChannelAsync>>);
    const policy = createPushPermissionPolicy(deps({ platform: "android" }));

    expect(await policy.refresh()).toMatchObject({
      permission: "allowed",
      importantChannel: "blocked",
      alertCapability: "blocked",
    });
    expect(getNotificationChannelAsync).toHaveBeenCalledWith("important-messages");
  });

  test("does not claim Android channel readiness when native inspection cannot find it", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted"));
    getNotificationChannelAsync.mockResolvedValue(null);
    const policy = createPushPermissionPolicy(deps({ platform: "android" }));

    expect(await policy.refresh()).toMatchObject({
      permission: "allowed",
      importantChannel: "unavailable",
      alertCapability: "unavailable",
    });
  });

  test("never asks again after the system has denied or locked its prompt", async () => {
    getPermissionsAsync.mockResolvedValue(permission("denied"));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.requestPermission()).toMatchObject({
      permission: "denied",
      canRequestPermission: false,
    });
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test("keeps iOS provisional permission distinct from fully allowed", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted", {
      ios: { status: 3, allowsBadge: true },
    }));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toMatchObject({
      permission: "provisional",
      canRequestPermission: false,
      badge: "enabled",
      alertCapability: "available",
    });
  });

  test("reports native failures as unavailable rather than pretending permission is denied", async () => {
    getPermissionsAsync.mockRejectedValue(new Error("native module unavailable"));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toEqual({
      permission: "unavailable",
      canRequestPermission: false,
      badge: "unavailable",
      importantChannel: "unavailable",
      alertCapability: "unavailable",
    });
  });

  test("turning off the device-local badge clears it before persisting the preference", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted", {
      ios: { status: 2, allowsBadge: true },
    }));
    const source = storage();
    const policy = createPushPermissionPolicy(deps({ storage: source }));

    await policy.setBadgeEnabled(false);

    expect(setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(source.values.get("nautilo.push.badge-enabled.v1")).toBe("false");
    expect(await policy.refresh()).toMatchObject({ badge: "disabled" });
  });

  test("does not persist a disabled badge preference when native badge clearing fails", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted", {
      ios: { status: 2, allowsBadge: true },
    }));
    setBadgeCountAsync.mockResolvedValue(false);
    const source = storage();
    const policy = createPushPermissionPolicy(deps({ storage: source }));

    let failure: unknown = null;
    try {
      await policy.setBadgeEnabled(false);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("could not clear");
    expect(source.values.get("nautilo.push.badge-enabled.v1")).toBeUndefined();
    expect(await policy.refresh()).toMatchObject({ badge: "enabled" });
  });

  test("serializes duplicate request presses and never opens two system prompts", async () => {
    getPermissionsAsync.mockResolvedValue(permission("undetermined"));
    let resolvePrompt!: (value: Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>) => void;
    requestPermissionsAsync.mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }));
    const policy = createPushPermissionPolicy(deps());

    const first = policy.requestPermission();
    const duplicate = policy.requestPermission();
    for (let attempt = 0; attempt < 8 && !resolvePrompt; attempt += 1) await Promise.resolve();
    expect(resolvePrompt).toBeDefined();
    resolvePrompt(permission("granted", { ios: { status: 2, allowsBadge: true } }));

    expect(await Promise.all([first, duplicate])).toEqual([
      {
        permission: "allowed",
        canRequestPermission: false,
        badge: "enabled",
        importantChannel: "not_applicable",
        alertCapability: "available",
      },
      {
        permission: "allowed",
        canRequestPermission: false,
        badge: "enabled",
        importantChannel: "not_applicable",
        alertCapability: "available",
      },
    ]);
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("does not claim iOS alert readiness when the system has disabled alerts", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted", {
      ios: { status: 2, allowsAlert: false, allowsBadge: true },
    }));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toMatchObject({
      permission: "allowed",
      importantChannel: "not_applicable",
      alertCapability: "blocked",
    });
  });

  test("does not claim iOS alert readiness when native inspection omits alert settings", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted"));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toMatchObject({
      permission: "allowed",
      alertCapability: "unavailable",
    });
  });

  test("keeps provisional iOS authorization available for quiet delivery", async () => {
    getPermissionsAsync.mockResolvedValue(permission("granted", {
      ios: { status: 3, allowsAlert: false, allowsBadge: true },
    }));
    const policy = createPushPermissionPolicy(deps());

    expect(await policy.refresh()).toMatchObject({
      permission: "provisional",
      alertCapability: "available",
    });
  });
});
