import type { SettingsDataStateController } from "@/features/settings/settings-data-state";

export type RecoveryCodeFamily = "pin" | "logto-account";

export interface RecoveryCodeFamilyCopy {
  family: RecoveryCodeFamily;
  title: string;
  confirmation: string;
}

export const RECOVERY_CODE_FAMILIES: Record<RecoveryCodeFamily, RecoveryCodeFamilyCopy> = {
  pin: {
    family: "pin",
    title: "PIN recovery codes",
    confirmation: "Regenerating invalidates all existing PIN recovery codes.",
  },
  "logto-account": {
    family: "logto-account",
    title: "Logto account recovery codes",
    confirmation: "Regenerating invalidates all existing Logto account recovery codes.",
  },
};

/** Navigation is the sole secret exit that asks for consent; background/auth exits clear immediately. */
export function recoveryExitDisposition(
  hasUnacknowledgedSecret: boolean,
  reason: "navigation" | "background" | "auth-boundary" | "error",
): "confirm-discard" | "clear-now" {
  return reason === "navigation" && hasUnacknowledgedSecret ? "confirm-discard" : "clear-now";
}

/** Store plaintext only in the supplied screen-owned Settings controller. */
export function revealRecoveryCodes(
  state: SettingsDataStateController<unknown, unknown>,
  codes: readonly string[],
): boolean {
  if (codes.length === 0 || codes.some((code) => !code)) return false;
  return state.revealSecret(codes.join("\n"));
}

/** A single exit path for dismiss, blur/navigation, background, logout and errors. */
export function clearRecoveryCodes(state: SettingsDataStateController<unknown, unknown>): void {
  state.clearSecret();
}
