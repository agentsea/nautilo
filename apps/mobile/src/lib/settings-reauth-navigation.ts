export {
  MOBILE_WEB_SECURITY_PATH,
  readSettingsReauthNavigation,
  settingsReauthReturnPath,
  settingsVerificationIncompletePath,
  type SettingsReauthIntent,
  type SettingsReauthNavigation,
} from "./settings-reauth-navigation-contract";

import type { SettingsReauthNavigation } from "./settings-reauth-navigation-contract";

/** Native authentication never leaves the process, so it has no URL state. */
export function consumeSettingsReauthNavigation(): SettingsReauthNavigation | null {
  return null;
}
