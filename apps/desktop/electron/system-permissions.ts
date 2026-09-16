/**
 * Desktop-wide macOS permission registry.
 *
 * This module deliberately reports operating-system truth and exposes only
 * the small, predefined recovery actions Nautilo can safely offer. It never
 * treats a renderer toggle as authority and it never accepts a renderer URL.
 */

import { app, shell, systemPreferences } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askForMicrophoneAccess,
  getMicrophoneStatus,
  openSystemMicSettings,
  type MicStatus,
} from "./media";
import {
  requestScreenRecordingPermission,
  resolveScreenRecordingPermissionHelper,
  type ScreenRecordingPermissionRequestResult,
} from "./screen-recording-permission";

export type SystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone";
export type SystemPermissionState =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown"
  | "unsupported";
export type SystemPermissionAction = "request" | "open-settings" | null;
export type SystemPermissionRestart = "not-required" | "required";
export type SystemPermissionFeature = "computer-use" | "voice";

export type SystemPermissionRow = {
  readonly id: SystemPermissionId;
  readonly label: string;
  readonly reason: string;
  readonly requiredFor: readonly SystemPermissionFeature[];
  readonly state: SystemPermissionState;
  readonly action: SystemPermissionAction;
  readonly restart: SystemPermissionRestart;
};

export type SystemPermissionsSnapshot = {
  readonly version: 1;
  readonly platform: "macos" | "other";
  readonly permissions: readonly SystemPermissionRow[];
};

export type SystemPermissionsPlatformAdapter = {
  readonly platform: NodeJS.Platform;
  readonly isTrustedAccessibilityClient: (prompt: boolean) => boolean;
  readonly getScreenRecordingStatus: () => string;
  readonly getMicrophoneStatus: () => MicStatus;
  readonly askForMicrophoneAccess: () => Promise<MicStatus>;
  /** The one-purpose host-child bridge for CGRequestScreenCaptureAccess. */
  readonly requestScreenRecordingPermission: () => Promise<ScreenRecordingPermissionRequestResult>;
  readonly openMicrophoneSettings: () => Promise<void>;
  readonly openSystemSettings: (url: string) => Promise<unknown>;
};

const SYSTEM_PERMISSION_IDS = [
  "accessibility",
  "screen-recording",
  "microphone",
] as const satisfies readonly SystemPermissionId[];

const SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function nativeAdapter(): SystemPermissionsPlatformAdapter {
  const devVendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
  return {
    platform: process.platform,
    isTrustedAccessibilityClient: (prompt) =>
      systemPreferences.isTrustedAccessibilityClient(prompt),
    getScreenRecordingStatus: () => systemPreferences.getMediaAccessStatus("screen"),
    getMicrophoneStatus,
    askForMicrophoneAccess,
    requestScreenRecordingPermission: () => requestScreenRecordingPermission(
      resolveScreenRecordingPermissionHelper({
        platform: process.platform,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath ?? null,
        devVendorRoot,
      }),
    ),
    openMicrophoneSettings: openSystemMicSettings,
    openSystemSettings: (url) => shell.openExternal(url),
  };
}

function isKnownMediaStatus(value: string): value is Exclude<
  SystemPermissionState,
  "unsupported"
> {
  return (
    value === "not-determined" ||
    value === "granted" ||
    value === "denied" ||
    value === "restricted" ||
    value === "unknown"
  );
}

function mediaState(value: string): Exclude<SystemPermissionState, "unsupported"> {
  return isKnownMediaStatus(value) ? value : "unknown";
}

function actionFor(
  id: SystemPermissionId,
  state: SystemPermissionState,
  screenRecordingSettingsFallback: boolean,
): SystemPermissionAction {
  if (
    state === "granted" ||
    state === "restricted" ||
    state === "unsupported"
  ) {
    return null;
  }
  if (id === "accessibility") return "request";
  if (id === "screen-recording") return screenRecordingSettingsFallback ? "open-settings" : "request";
  if (id === "microphone" && state === "not-determined") return "request";
  return "open-settings";
}

function row(
  id: SystemPermissionId,
  label: string,
  reason: string,
  requiredFor: readonly SystemPermissionFeature[],
  state: SystemPermissionState,
  restart: SystemPermissionRestart = "not-required",
  screenRecordingSettingsFallback = false,
): SystemPermissionRow {
  return {
    id,
    label,
    reason,
    requiredFor,
    state,
    action: actionFor(id, state, screenRecordingSettingsFallback),
    restart,
  };
}

export function isSystemPermissionId(value: unknown): value is SystemPermissionId {
  return typeof value === "string" && (SYSTEM_PERMISSION_IDS as readonly string[]).includes(value);
}

/**
 * Creates the small detection/action boundary so unit tests can supply an
 * exact native facade without changing global process state.
 */
export function createSystemPermissionsRegistry(
  adapter: SystemPermissionsPlatformAdapter = nativeAdapter(),
) {
  const isMac = () => adapter.platform === "darwin";
  // Electron documents that a microphone grant changed in System Settings
  // after a denial does not take effect in this process until relaunch. The
  // denied process may never observe the new grant, so latch this only after
  // successfully opening Settings for a currently denied microphone row.
  // Initial grants, OS-prompt grants, and unknown states do not earn it.
  let microphoneSettingsRelaunchRequired = false;
  // Cua's pinned embedding contract makes CGRequestScreenCaptureAccess the
  // first recovery action. A false result is not enough to identify whether
  // macOS showed or suppressed its prompt, so offer the fixed Settings pane
  // only on the next explicit Human action. This avoids a surprise Settings
  // jump while the system dialog is still on screen.
  let screenRecordingSettingsFallback = false;

  const currentAccessibilityState = (): SystemPermissionState => {
    if (!isMac()) return "unsupported";
    try {
      // AX only exposes trusted/not-trusted. A false result is a real missing
      // permission; macOS does not expose a separate first-prompt state here.
      return adapter.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  };

  const currentScreenRecordingState = (): SystemPermissionState => {
    if (!isMac()) return "unsupported";
    try {
      return mediaState(adapter.getScreenRecordingStatus());
    } catch {
      return "unknown";
    }
  };

  const currentMicrophoneState = (): SystemPermissionState => {
    if (!isMac()) return "unsupported";
    try {
      return mediaState(adapter.getMicrophoneStatus());
    } catch {
      return "unknown";
    }
  };

  const status = (): SystemPermissionsSnapshot => {
    const microphoneState = currentMicrophoneState();
    const screenRecordingState = currentScreenRecordingState();
    if (screenRecordingState === "granted") screenRecordingSettingsFallback = false;
    return {
      version: 1,
      platform: isMac() ? "macos" : "other",
      // The order is an intentional Human setup sequence, not object iteration.
      permissions: [
      row(
        "accessibility",
        "Accessibility",
        "Lets Nautilo control apps when you ask a Genie to use your computer.",
        ["computer-use"],
        currentAccessibilityState(),
      ),
      row(
        "screen-recording",
        "Screen Recording",
        "Lets Nautilo see the desktop it needs to operate safely.",
        ["computer-use"],
        screenRecordingState,
        "not-required",
        screenRecordingSettingsFallback,
      ),
      row(
        "microphone",
        "Microphone",
        "Lets Nautilo hear you when you use voice.",
        ["voice"],
        microphoneState,
        microphoneSettingsRelaunchRequired &&
          (microphoneState === "denied" || microphoneState === "granted")
          ? "required"
          : "not-required",
      ),
    ],
    };
  };

  const resolve = async (
    id: SystemPermissionId,
  ): Promise<SystemPermissionsSnapshot> => {
    const before = status();
    const permission = before.permissions.find((candidate) => candidate.id === id);
    if (!permission || permission.action === null || !isMac()) return before;

    if (permission.action === "request") {
      if (id === "accessibility") {
        // Electron's documented API may show the supported macOS guidance. We
        // never construct an undocumented renderer-selected Settings URL.
        adapter.isTrustedAccessibilityClient(true);
      } else if (id === "screen-recording") {
        const result = await adapter.requestScreenRecordingPermission();
        if (!result.ok || !result.granted) screenRecordingSettingsFallback = true;
      } else {
        // The microphone is the only listed capability with an Electron API
        // for an in-context macOS request. The OS owns the prompt.
        await adapter.askForMicrophoneAccess();
      }
      return status();
    }

    if (id === "screen-recording") {
      await adapter.openSystemSettings(SCREEN_RECORDING_SETTINGS_URL);
    } else {
      await adapter.openMicrophoneSettings();
      if (permission.state === "denied") {
        microphoneSettingsRelaunchRequired = true;
      }
    }
    return status();
  };

  return { status, resolve };
}

const systemPermissions = createSystemPermissionsRegistry();

export function getSystemPermissionsSnapshot(): SystemPermissionsSnapshot {
  return systemPermissions.status();
}

export async function resolveSystemPermission(
  id: SystemPermissionId,
): Promise<SystemPermissionsSnapshot> {
  return await systemPermissions.resolve(id);
}
