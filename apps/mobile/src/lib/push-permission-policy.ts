/**
 * D468 device-local notification policy.
 *
 * The operating system remains the permission authority. This module only
 * observes that authority until an explicit user action asks it to prompt, and
 * keeps the app-badge preference local to this installation. It owns neither
 * server registration nor notification navigation.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID } from "./push-installation";

const BADGE_ENABLED_STORAGE_KEY = "nautilo.push.badge-enabled.v1";

export type DevicePushPermission =
  | "unavailable"
  | "unknown"
  | "provisional"
  | "allowed"
  | "denied";

export type DeviceBadgeState = "enabled" | "disabled" | "unavailable";

/**
 * Android exposes per-channel state separately from app-wide permission. iOS
 * has no equivalent channel, so callers must not mistake that for a failure.
 */
export type DeviceImportantChannelState = "available" | "blocked" | "unavailable" | "not_applicable";

/**
 * Platform-neutral answer to whether this device may actually present an
 * important alert. Android derives it from the durable channel; iOS derives
 * it from its alert authorization. Provisional iOS authorization remains
 * available (quiet delivery), not blocked.
 */
export type DevicePushAlertCapability = "available" | "blocked" | "unavailable";

export interface DevicePushNotificationState {
  readonly permission: DevicePushPermission;
  /** True only while the OS may still show its permission prompt. */
  readonly canRequestPermission: boolean;
  /** The installation-local badge preference, constrained by native truth. */
  readonly badge: DeviceBadgeState;
  /**
   * Whether Android's durable Important messages channel can present alerts.
   * `blocked` is a Human-controlled system choice and is never repaired by
   * Nautilo. `unavailable` means native inspection could not prove readiness.
   */
  readonly importantChannel: DeviceImportantChannelState;
  /**
   * Alert-delivery truth suitable for the outcome-level UI. A granted OS
   * permission alone is insufficient when Android's channel or iOS alerts
   * have been disabled in system settings.
   */
  readonly alertCapability: DevicePushAlertCapability;
}

interface PushPermissionNotificationsAdapter {
  readonly getPermissionsAsync: typeof Notifications.getPermissionsAsync;
  readonly requestPermissionsAsync: typeof Notifications.requestPermissionsAsync;
  readonly setBadgeCountAsync: typeof Notifications.setBadgeCountAsync;
  readonly getNotificationChannelAsync: typeof Notifications.getNotificationChannelAsync;
  readonly androidImportanceNone: Notifications.AndroidImportance;
  readonly permissionStatus: typeof Notifications.PermissionStatus;
  readonly iosAuthorization: typeof Notifications.IosAuthorizationStatus;
}

interface PushPermissionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PushPermissionPolicyDeps {
  readonly storage: PushPermissionStorage;
  readonly notifications: PushPermissionNotificationsAdapter;
  readonly platform: "ios" | "android";
}

const defaultDeps: PushPermissionPolicyDeps = {
  storage: AsyncStorage,
  notifications: {
    getPermissionsAsync: Notifications.getPermissionsAsync,
    requestPermissionsAsync: Notifications.requestPermissionsAsync,
    setBadgeCountAsync: Notifications.setBadgeCountAsync,
    getNotificationChannelAsync: Notifications.getNotificationChannelAsync,
    androidImportanceNone: Notifications.AndroidImportance.NONE,
    permissionStatus: Notifications.PermissionStatus,
    iosAuthorization: Notifications.IosAuthorizationStatus,
  },
  platform: Platform.OS === "android" ? "android" : "ios",
};

export interface PushPermissionPolicy {
  /** Pure observation — never triggers the OS prompt. */
  refresh(): Promise<DevicePushNotificationState>;
  /** Explicit user action; concurrent taps coalesce to one native prompt. */
  requestPermission(): Promise<DevicePushNotificationState>;
  /** Persists this installation's badge preference and clears an off badge. */
  setBadgeEnabled(enabled: boolean): Promise<DevicePushNotificationState>;
}

type NativePermissions = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;

function nativePermission(
  permissions: NativePermissions,
  deps: PushPermissionPolicyDeps,
): DevicePushPermission {
  if (deps.platform === "ios" && permissions.ios !== undefined) {
    const status = permissions.ios.status;
    if (status === deps.notifications.iosAuthorization.PROVISIONAL) return "provisional";
    if (
      status === deps.notifications.iosAuthorization.AUTHORIZED
      || status === deps.notifications.iosAuthorization.EPHEMERAL
    ) {
      return "allowed";
    }
    if (status === deps.notifications.iosAuthorization.DENIED) return "denied";
    return "unknown";
  }
  if (permissions.status === deps.notifications.permissionStatus.GRANTED) return "allowed";
  if (permissions.status === deps.notifications.permissionStatus.DENIED) return "denied";
  return "unknown";
}

function canReceiveBadge(
  permissions: NativePermissions,
  permission: DevicePushPermission,
  deps: PushPermissionPolicyDeps,
): boolean {
  if (permission !== "allowed" && permission !== "provisional") return false;
  // iOS exposes badge authorization separately. Android launchers decide
  // support; no Android API can claim that an individual launcher will show it.
  if (deps.platform !== "ios" || permissions.ios === undefined) return true;
  return permissions.ios.allowsBadge !== false;
}

async function loadBadgeEnabled(storage: PushPermissionStorage): Promise<boolean> {
  return (await storage.getItem(BADGE_ENABLED_STORAGE_KEY)) !== "false";
}

/** Read the installation-local choice without touching native permission state. */
export async function loadPushBadgePreference(): Promise<boolean> {
  return loadBadgeEnabled(AsyncStorage);
}

function unavailable(): DevicePushNotificationState {
  return {
    permission: "unavailable",
    canRequestPermission: false,
    badge: "unavailable",
    importantChannel: "unavailable",
    alertCapability: "unavailable",
  };
}

async function importantChannelState(
  permission: DevicePushPermission,
  deps: PushPermissionPolicyDeps,
): Promise<DeviceImportantChannelState> {
  if (deps.platform !== "android") return "not_applicable";
  if (permission !== "allowed") return "unavailable";
  try {
    const channel = await deps.notifications.getNotificationChannelAsync(
      NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID,
    );
    if (channel === null) return "unavailable";
    return channel.importance <= deps.notifications.androidImportanceNone ? "blocked" : "available";
  } catch {
    return "unavailable";
  }
}

function alertCapability(
  permissions: NativePermissions,
  permission: DevicePushPermission,
  channel: DeviceImportantChannelState,
  deps: PushPermissionPolicyDeps,
): DevicePushAlertCapability {
  if (deps.platform === "android") {
    if (channel === "available" || channel === "blocked") return channel;
    return "unavailable";
  }
  if (permissions.ios === undefined) return "unavailable";
  if (permission !== "allowed" && permission !== "provisional") return "unavailable";
  // Provisional permission deliberately delivers quietly. An iOS settings
  // response that explicitly disables alerts is otherwise a real blocker.
  if (permission !== "provisional" && permissions.ios?.allowsAlert === false) return "blocked";
  return "available";
}

async function snapshotFrom(
  permissions: NativePermissions,
  badgeEnabled: boolean,
  deps: PushPermissionPolicyDeps,
): Promise<DevicePushNotificationState> {
  const permission = nativePermission(permissions, deps);
  const badge = canReceiveBadge(permissions, permission, deps)
    ? (badgeEnabled ? "enabled" : "disabled")
    : "unavailable";
  const importantChannel = await importantChannelState(permission, deps);
  return {
    permission,
    canRequestPermission: permission === "unknown" && permissions.canAskAgain !== false,
    badge,
    importantChannel,
    alertCapability: alertCapability(permissions, permission, importantChannel, deps),
  };
}

/**
 * All methods serialize native/storage observations. This makes foreground
 * reconciliation, an explicit request, and a badge toggle deterministic
 * without treating a stale result as a newer system decision.
 */
export function createPushPermissionPolicy(
  supplied: Partial<PushPermissionPolicyDeps> = {},
): PushPermissionPolicy {
  const deps: PushPermissionPolicyDeps = { ...defaultDeps, ...supplied };
  let tail: Promise<void> = Promise.resolve();
  let promptInFlight: Promise<DevicePushNotificationState> | null = null;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => {}).then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  };

  const observe = async (): Promise<DevicePushNotificationState> => {
    try {
      const [permissions, badgeEnabled] = await Promise.all([
        deps.notifications.getPermissionsAsync(),
        loadBadgeEnabled(deps.storage),
      ]);
      return await snapshotFrom(permissions, badgeEnabled, deps);
    } catch {
      return unavailable();
    }
  };

  return {
    refresh: () => enqueue(observe),

    requestPermission: () => {
      if (promptInFlight) return promptInFlight;
      const current = enqueue(async () => {
        const observed = await observe();
        if (
          observed.permission !== "unknown"
          || !observed.canRequestPermission
        ) {
          return observed;
        }
        try {
          const permissions = await deps.notifications.requestPermissionsAsync();
          const badgeEnabled = await loadBadgeEnabled(deps.storage);
          return await snapshotFrom(permissions, badgeEnabled, deps);
        } catch {
          return unavailable();
        }
      });
      promptInFlight = current;
      void current.finally(() => {
        if (promptInFlight === current) promptInFlight = null;
      });
      return current;
    },

    setBadgeEnabled: (enabled) => enqueue(async () => {
      const observed = await observe();
      if (observed.badge === "unavailable") return observed;
      if (!enabled) {
        // A successful preference cannot leave a stale numeric badge behind.
        const cleared = await deps.notifications.setBadgeCountAsync(0);
        if (!cleared) throw new Error("Nautilo could not clear this device's app badge.");
      }
      await deps.storage.setItem(BADGE_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
      return { ...observed, badge: enabled ? "enabled" : "disabled" };
    }),
  };
}
