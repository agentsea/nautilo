export {
  MOBILE_WEB_SECURITY_PATH,
  readSettingsReauthNavigation,
  settingsReauthReturnPath,
  settingsVerificationIncompletePath,
  type SettingsReauthIntent,
  type SettingsReauthNavigation,
} from "./settings-reauth-navigation-contract";

import {
  readSettingsReauthNavigation,
  type SettingsReauthNavigation,
} from "./settings-reauth-navigation-contract";

/** Consume once with replacement navigation so Back/refresh cannot reopen it. */
export function consumeSettingsReauthNavigation(): SettingsReauthNavigation | null {
  if (typeof window === "undefined") return null;
  const result = readSettingsReauthNavigation(window.location.href, window.location.origin);
  if (!result) return null;
  window.history.replaceState(null, "", result.cleanupPath);
  return result.navigation;
}
