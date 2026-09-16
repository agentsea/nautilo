import { describe, expect, mock, test } from "bun:test";
import type * as Notifications from "expo-notifications";
import type { PushInstallationDeps } from "./push-installation";

type Listener = (token: { data: string }) => void;
const secure = new Map<string, string>();
let tokenListener: Listener | undefined;
const setNotificationChannelAsync = mock(async () => null);
const getNotificationChannelAsync = mock(
  (async () => null) as typeof Notifications.getNotificationChannelAsync,
);
const getPermissionsAsync = mock(async () => ({ status: "granted", ios: { status: 2 } }));
const requestPermissionsAsync = mock(async () => ({ status: "granted", ios: { status: 2 } }));
const getExpoPushTokenAsync = mock(async () => ({ data: "ExponentPushToken[first-token]" }));

mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secure.set(key, value); },
}));
mock.module("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
mock.module("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { DENIED: 0, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied" },
  getPermissionsAsync,
  requestPermissionsAsync,
  getExpoPushTokenAsync,
  getNotificationChannelAsync,
  setNotificationChannelAsync,
  addPushTokenListener: (listener: Listener) => {
    tokenListener = listener;
    return { remove: () => { tokenListener = undefined; } };
  },
}));

const push = await import("./push-installation");

function deps(platform: "ios" | "android" = "ios"): PushInstallationDeps {
  return {
    secureStore: {
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async (key, value) => { secure.set(key, value); },
    },
    notifications: {
      getPermissionsAsync: getPermissionsAsync as unknown as typeof Notifications.getPermissionsAsync,
      requestPermissionsAsync: requestPermissionsAsync as unknown as typeof Notifications.requestPermissionsAsync,
      getExpoPushTokenAsync: getExpoPushTokenAsync as unknown as typeof Notifications.getExpoPushTokenAsync,
      getNotificationChannelAsync: getNotificationChannelAsync as typeof Notifications.getNotificationChannelAsync,
      setNotificationChannelAsync: setNotificationChannelAsync as typeof Notifications.setNotificationChannelAsync,
      addPushTokenListener: ((listener) => {
        tokenListener = listener as Listener;
        return { remove: () => { tokenListener = undefined; } } as unknown as ReturnType<typeof Notifications.addPushTokenListener>;
      }) as typeof Notifications.addPushTokenListener,
      androidImportanceDefault: 3,
      iosAuthorization: { DENIED: 0, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 } as never,
      permissionStatus: { GRANTED: "granted", DENIED: "denied" } as never,
    },
    platform,
    randomUuid: () => "11111111-1111-4111-8111-111111111111",
  };
}

describe("D468 Mobile push installation native foundation", () => {
  test("coalesces identity creation and stores token/revision only in SecureStore", async () => {
    secure.clear();
    const [left, right] = await Promise.all([
      push.loadOrCreatePushInstallation(deps()),
      push.loadOrCreatePushInstallation(deps()),
    ]);
    expect(left.installationId).toBe(right.installationId);
    expect(left.expoPushToken).toBeNull();
    expect([...secure.values()].join(" ")).toContain("installationId");
  });

  test("creates Android channel before permission/token and increments only on a new token", async () => {
    secure.clear();
    setNotificationChannelAsync.mockClear();
    getNotificationChannelAsync.mockReset();
    getNotificationChannelAsync.mockResolvedValue(null);
    getExpoPushTokenAsync.mockClear();
    getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[first-token]" });
    const first = await push.refreshPushInstallation({}, deps("android"));
    const same = await push.refreshPushInstallation({}, deps("android"));
    getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[rotated-token]" });
    const rotated = await push.refreshPushInstallation({}, deps("android"));
    expect(setNotificationChannelAsync).toHaveBeenCalledWith(
      push.NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID,
      expect.objectContaining({ name: "Important messages" }),
    );
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: push.NAUTILO_EAS_PROJECT_ID });
    expect([first.tokenGeneration, same.tokenGeneration, rotated.tokenGeneration]).toEqual([1, 1, 2]);
  });

  test("does not overwrite an existing Android channel chosen in system settings", async () => {
    secure.clear();
    setNotificationChannelAsync.mockClear();
    getNotificationChannelAsync.mockResolvedValue({
      id: push.NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID,
      importance: 2,
    } as Awaited<ReturnType<typeof Notifications.getNotificationChannelAsync>>);
    getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[existing-channel-token]" });

    await push.refreshPushInstallation({}, deps("android"));

    expect(getNotificationChannelAsync).toHaveBeenCalledWith(push.NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID);
    expect(setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  test("does not mint a token while denied, but uses explicit permission requests", async () => {
    secure.clear();
    getPermissionsAsync.mockResolvedValue({ status: "undetermined", ios: { status: 1 } });
    requestPermissionsAsync.mockResolvedValue({ status: "denied", ios: { status: 0 } });
    const denied = await push.refreshPushInstallation({}, deps());
    expect(denied).toMatchObject({ permission: "undetermined", expoPushToken: null, tokenGeneration: 0 });
    const requested = await push.refreshPushInstallation({ requestPermission: true }, deps());
    expect(requestPermissionsAsync).toHaveBeenCalled();
    expect(requested).toMatchObject({ permission: "denied", expoPushToken: null, tokenGeneration: 0 });
  });

  test("does not let an older token fetch overwrite a newer refresh", async () => {
    secure.clear();
    getPermissionsAsync.mockResolvedValue({ status: "granted", ios: { status: 2 } });
    const resolveToken: Array<(value: { data: string }) => void> = [];
    const raceDeps: PushInstallationDeps = {
      ...deps(),
      notifications: {
        ...deps().notifications,
        getExpoPushTokenAsync: (async () => new Promise((resolve) => {
          resolveToken.push(resolve);
        })) as unknown as typeof Notifications.getExpoPushTokenAsync,
      },
    };
    const older = push.refreshPushInstallation({}, raceDeps);
    const newer = push.refreshPushInstallation({}, raceDeps);
    while (resolveToken.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    resolveToken[1]?.({ data: "ExponentPushToken[newer-token]" });
    await newer;
    resolveToken[0]?.({ data: "ExponentPushToken[older-token]" });
    const late = await older;
    expect(late.expoPushToken).toBe("ExponentPushToken[newer-token]");
    expect(late.tokenGeneration).toBe(1);
  });

  test("subscribes to token rotations without installing navigation/auth listeners", async () => {
    secure.clear();
    getPermissionsAsync.mockResolvedValue({ status: "granted", ios: { status: 2 } });
    const observed: string[] = [];
    const errors: unknown[] = [];
    const subscription = push.subscribeToPushTokenRotations(
      (state) => observed.push(state.expoPushToken ?? ""),
      (error) => errors.push(error),
      deps(),
    );
    tokenListener?.({ data: "ExponentPushToken[listener-token]" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual(["ExponentPushToken[listener-token]"]);
    expect(errors).toEqual([]);
    subscription.remove();
  });
});
