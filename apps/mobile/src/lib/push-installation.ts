/**
 * D468 Mobile native push identity/token foundation.
 *
 * This module owns no server registration, auth, navigation, or UI. It only
 * provides serial, explicit lifecycle primitives for the later per-server
 * reconciler. Expo tokens never enter AsyncStorage or logs.
 */
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const NAUTILO_EAS_PROJECT_ID = "d3f1dfdb-e084-4ebf-a478-91e0c6e07b81";
/**
 * The Android channel embedded in the native app config and selected by every
 * server Expo payload. Keep this stable: Android treats a channel ID as the
 * user's durable notification preference boundary.
 */
export const NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID = "important-messages";

const INSTALLATION_STORAGE_KEY = "nautilo.push.installation.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[^\]\r\n]{1,2000}\]$/;

export type PushPlatform = "ios" | "android";
export type PushPermission = "granted" | "denied" | "undetermined";

export interface PushInstallationState {
  readonly version: 1;
  /** Stable public app-installation identity; never a bearer credential. */
  readonly installationId: string;
  /** Only returned to a caller preparing a bounded server registration. */
  readonly expoPushToken: string | null;
  /** Monotonic whenever Expo rotates the token. Starts at 1 with the first token. */
  readonly tokenGeneration: number;
  readonly permission: PushPermission;
}

interface PushNotificationsAdapter {
  readonly getPermissionsAsync: typeof Notifications.getPermissionsAsync;
  readonly requestPermissionsAsync: typeof Notifications.requestPermissionsAsync;
  readonly getExpoPushTokenAsync: typeof Notifications.getExpoPushTokenAsync;
  readonly getNotificationChannelAsync: typeof Notifications.getNotificationChannelAsync;
  readonly setNotificationChannelAsync: typeof Notifications.setNotificationChannelAsync;
  readonly addPushTokenListener: typeof Notifications.addPushTokenListener;
  readonly androidImportanceDefault: Notifications.AndroidImportance;
  readonly iosAuthorization: typeof Notifications.IosAuthorizationStatus;
  readonly permissionStatus: typeof Notifications.PermissionStatus;
}

export interface PushInstallationDeps {
  readonly secureStore: Pick<typeof SecureStore, "getItemAsync" | "setItemAsync">;
  readonly notifications: PushNotificationsAdapter;
  readonly platform: PushPlatform;
  readonly randomUuid: () => string;
}

const defaultDeps: PushInstallationDeps = {
  secureStore: SecureStore,
  notifications: {
    getPermissionsAsync: Notifications.getPermissionsAsync,
    requestPermissionsAsync: Notifications.requestPermissionsAsync,
    getExpoPushTokenAsync: Notifications.getExpoPushTokenAsync,
    getNotificationChannelAsync: Notifications.getNotificationChannelAsync,
    setNotificationChannelAsync: Notifications.setNotificationChannelAsync,
    addPushTokenListener: Notifications.addPushTokenListener,
    androidImportanceDefault: Notifications.AndroidImportance.DEFAULT,
    iosAuthorization: Notifications.IosAuthorizationStatus,
    permissionStatus: Notifications.PermissionStatus,
  },
  platform: Platform.OS === "android" ? "android" : "ios",
  randomUuid: Crypto.randomUUID,
};

/** Explicitly distinguish a native unavailability from a denied permission. */
class PushInstallationError extends Error {
  constructor(
    readonly code: "invalid_native_state" | "token_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PushInstallationError";
  }
}

let storageTail: Promise<void> = Promise.resolve();
let initialization: Promise<PushInstallationState> | null = null;
let tokenEpoch = 0;
let committedTokenEpoch = 0;

function enqueueStorageMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = storageTail.catch(() => {}).then(mutation);
  storageTail = result.then(() => {}, () => {});
  return result;
}

function parseStoredState(value: string | null): PushInstallationState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PushInstallationState>;
    if (
      parsed.version !== 1
      || typeof parsed.installationId !== "string"
      || !UUID.test(parsed.installationId)
      || (parsed.expoPushToken !== null && (typeof parsed.expoPushToken !== "string" || !EXPO_TOKEN.test(parsed.expoPushToken)))
      || typeof parsed.tokenGeneration !== "number"
      || !Number.isSafeInteger(parsed.tokenGeneration)
      || parsed.tokenGeneration < 0
      || (parsed.permission !== "granted" && parsed.permission !== "denied" && parsed.permission !== "undetermined")
    ) {
      return null;
    }
    return {
      version: 1,
      installationId: parsed.installationId,
      expoPushToken: parsed.expoPushToken,
      tokenGeneration: parsed.tokenGeneration,
      permission: parsed.permission,
    };
  } catch {
    return null;
  }
}

function makeEmptyState(randomUuid: () => string): PushInstallationState {
  const installationId = randomUuid().toLowerCase();
  if (!UUID.test(installationId)) {
    throw new PushInstallationError("invalid_native_state", "Mobile push installation UUID is invalid");
  }
  return {
    version: 1,
    installationId,
    expoPushToken: null,
    tokenGeneration: 0,
    permission: "undetermined",
  };
}

async function writeState(
  state: PushInstallationState,
  deps: PushInstallationDeps,
): Promise<PushInstallationState> {
  await deps.secureStore.setItemAsync(
    INSTALLATION_STORAGE_KEY,
    JSON.stringify(state),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  return state;
}

async function readOrCreateState(deps: PushInstallationDeps): Promise<PushInstallationState> {
  return enqueueStorageMutation(async () => {
    const existing = parseStoredState(await deps.secureStore.getItemAsync(INSTALLATION_STORAGE_KEY));
    return existing ?? writeState(makeEmptyState(deps.randomUuid), deps);
  });
}

/** Parallel callers share one initial SecureStore read/write, never two identities. */
export function loadOrCreatePushInstallation(
  deps: PushInstallationDeps = defaultDeps,
): Promise<PushInstallationState> {
  if (initialization) return initialization;
  const current = readOrCreateState(deps);
  initialization = current;
  void current.finally(() => {
    if (initialization === current) initialization = null;
  });
  return current;
}

function normalizePermission(
  permissions: Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>,
  deps: PushInstallationDeps,
): PushPermission {
  if (deps.platform === "ios" && permissions.ios !== undefined) {
    const status = permissions.ios.status;
    if (
      status === deps.notifications.iosAuthorization.AUTHORIZED
      || status === deps.notifications.iosAuthorization.PROVISIONAL
      || status === deps.notifications.iosAuthorization.EPHEMERAL
    ) {
      return "granted";
    }
    return status === deps.notifications.iosAuthorization.DENIED ? "denied" : "undetermined";
  }
  if (permissions.status === deps.notifications.permissionStatus.GRANTED) return "granted";
  if (permissions.status === deps.notifications.permissionStatus.DENIED) return "denied";
  return "undetermined";
}

/**
 * Android 13 needs a channel before the OS will show the permission
 * prompt/token. Existing channels are deliberately left alone: their current
 * importance is the Human's system-level choice, not a setting Mobile may
 * overwrite during reconciliation.
 */
async function ensurePushNotificationChannel(
  deps: PushInstallationDeps = defaultDeps,
): Promise<void> {
  if (deps.platform !== "android") return;
  const existing = await deps.notifications.getNotificationChannelAsync(
    NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID,
  );
  if (existing !== null) return;
  await deps.notifications.setNotificationChannelAsync(NAUTILO_IMPORTANT_MESSAGES_CHANNEL_ID, {
    name: "Important messages",
    importance: deps.notifications.androidImportanceDefault,
  });
}

async function persistObservedState(
  previous: PushInstallationState,
  input: { permission: PushPermission; token: string | null; epoch?: number },
  deps: PushInstallationDeps,
): Promise<PushInstallationState> {
  return enqueueStorageMutation(async () => {
    if (input.epoch !== undefined && input.epoch < committedTokenEpoch) {
      const current = parseStoredState(await deps.secureStore.getItemAsync(INSTALLATION_STORAGE_KEY));
      return current ?? previous;
    }
    const current = parseStoredState(await deps.secureStore.getItemAsync(INSTALLATION_STORAGE_KEY)) ?? previous;
    const tokenChanged = current.expoPushToken !== input.token;
    const next: PushInstallationState = {
      ...current,
      expoPushToken: input.token,
      // A denied/off permission removes the locally usable token but never
      // rolls this CAS generation backward. Re-granting a token advances it.
      tokenGeneration: input.token === null
        ? current.tokenGeneration
        : tokenChanged
          ? Math.max(1, current.tokenGeneration + 1)
          : current.tokenGeneration,
      permission: input.permission,
    };
    if (input.epoch !== undefined) committedTokenEpoch = input.epoch;
    return writeState(next, deps);
  });
}

export interface RefreshPushInstallationOptions {
  /** Call only from an explicit settings/onboarding action when a prompt is appropriate. */
  readonly requestPermission?: boolean;
}

/**
 * Obtain a current Expo token for the pinned project ID after checking the
 * actual native permission. This does not register with any server.
 */
export async function refreshPushInstallation(
  options: RefreshPushInstallationOptions = {},
  deps: PushInstallationDeps = defaultDeps,
): Promise<PushInstallationState> {
  // Fence every async permission/token observation before any native await so
  // an older request cannot later erase a newer token or permission result.
  const epoch = ++tokenEpoch;
  const existing = await loadOrCreatePushInstallation(deps);
  await ensurePushNotificationChannel(deps);
  let nativePermission = await deps.notifications.getPermissionsAsync();
  let permission = normalizePermission(nativePermission, deps);
  if (permission === "undetermined" && options.requestPermission === true) {
    nativePermission = await deps.notifications.requestPermissionsAsync();
    permission = normalizePermission(nativePermission, deps);
  }
  if (permission !== "granted") {
    return persistObservedState(existing, { permission, token: null, epoch }, deps);
  }
  const token = await deps.notifications.getExpoPushTokenAsync({ projectId: NAUTILO_EAS_PROJECT_ID });
  if (typeof token.data !== "string" || !EXPO_TOKEN.test(token.data)) {
    throw new PushInstallationError("token_unavailable", "Expo returned an invalid push token");
  }
  return persistObservedState(existing, { permission, token: token.data, epoch }, deps);
}

export interface PushTokenRotationSubscription {
  readonly remove: () => void;
}

/**
 * The later coordinator subscribes explicitly; this module never installs a
 * root listener or changes active-server auth. Late native callbacks cannot
 * overwrite a newer token observation.
 */
export function subscribeToPushTokenRotations(
  onState: (state: PushInstallationState) => void,
  onError: (error: unknown) => void,
  deps: PushInstallationDeps = defaultDeps,
): PushTokenRotationSubscription {
  const subscription = deps.notifications.addPushTokenListener((token) => {
    const epoch = ++tokenEpoch;
    void (async () => {
      const existing = await loadOrCreatePushInstallation(deps);
      if (typeof token.data !== "string" || !EXPO_TOKEN.test(token.data)) {
        throw new PushInstallationError("token_unavailable", "Expo rotated to an invalid push token");
      }
      const state = await persistObservedState(
        existing,
        { permission: "granted", token: token.data, epoch },
        deps,
      );
      onState(state);
    })().catch(onError);
  });
  return { remove: () => subscription.remove() };
}
