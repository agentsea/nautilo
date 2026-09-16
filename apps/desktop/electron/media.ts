/**
 * Main-process media-permission helpers (D057 2a.5).
 *
 * macOS gates microphone access behind two orthogonal checks:
 *   1. Hardened runtime entitlement (com.apple.security.device.audio-input)
 *      — set in entitlements.mac.plist.
 *   2. TCC per-user consent — user clicks "OK" on the system prompt the
 *      first time the app asks. Electron exposes this via
 *      systemPreferences.{askForMediaAccess,getMediaAccessStatus}.
 *
 * Without BOTH (the entitlement and an affirmative TCC grant), a packaged
 * signed build silently fails getUserMedia({ audio: true }). The renderer
 * calls into this module via IPC to resolve the TCC state up front, so
 * mic-gated UI can respond correctly (prompt / proceed / explain).
 *
 * On non-macOS platforms these helpers return "granted" — Chromium
 * handles the permission prompt itself at the renderer layer.
 */

import { shell, systemPreferences } from "electron";

export type MicStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

/**
 * Current TCC status for the microphone (macOS only; "granted" elsewhere).
 * Does not trigger a prompt.
 */
export function getMicrophoneStatus(): MicStatus {
  if (process.platform !== "darwin") return "granted";
  try {
    const s = systemPreferences.getMediaAccessStatus("microphone");
    if (
      s === "not-determined" ||
      s === "granted" ||
      s === "denied" ||
      s === "restricted"
    ) {
      return s;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ask macOS to prompt the user for microphone access. Idempotent: if the
 * user has already decided, no prompt appears and the current status is
 * returned immediately. On non-macOS platforms resolves to "granted"
 * without side effects.
 */
export async function askForMicrophoneAccess(): Promise<MicStatus> {
  if (process.platform !== "darwin") return "granted";
  try {
    const ok = await systemPreferences.askForMediaAccess("microphone");
    return ok ? "granted" : getMicrophoneStatus();
  } catch {
    return "unknown";
  }
}

/**
 * Open the macOS System Settings panel scoped to microphone permissions,
 * so a user who denied can flip the toggle without hunting. No-op on
 * other platforms; callers should hide their "Open Settings" affordance
 * when platform !== "darwin".
 */
export async function openSystemMicSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  );
}
