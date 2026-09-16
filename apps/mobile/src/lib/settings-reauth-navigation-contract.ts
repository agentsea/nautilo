export type SettingsReauthIntent = "reset-pin" | "regenerate-account-codes";

export type SettingsReauthNavigation =
  | Readonly<{ kind: "intent"; intent: SettingsReauthIntent }>
  | Readonly<{ kind: "verification-incomplete" }>;

export const MOBILE_WEB_SECURITY_PATH = "/mobile/settings/security";

const INTENT_PARAM = "reauth";
const NOTICE_PARAM = "verification";
const VERIFICATION_INCOMPLETE = "incomplete";

export function settingsReauthReturnPath(intent: SettingsReauthIntent): string {
  const query = new URLSearchParams({ [INTENT_PARAM]: intent });
  return `${MOBILE_WEB_SECURITY_PATH}?${query}`;
}

export function settingsVerificationIncompletePath(): string {
  const query = new URLSearchParams({ [NOTICE_PARAM]: VERIFICATION_INCOMPLETE });
  return `${MOBILE_WEB_SECURITY_PATH}?${query}`;
}

export function readSettingsReauthNavigation(
  value: string,
  currentOrigin: string,
): Readonly<{ navigation: SettingsReauthNavigation; cleanupPath: string }> | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const candidate = new URL(value, origin);
    if (candidate.origin !== origin || candidate.pathname !== MOBILE_WEB_SECURITY_PATH || candidate.hash) {
      return null;
    }

    const intent = candidate.searchParams.get(INTENT_PARAM);
    const verification = candidate.searchParams.get(NOTICE_PARAM);
    const knownIntent = intent === "reset-pin" || intent === "regenerate-account-codes";
    const knownNotice = verification === VERIFICATION_INCOMPLETE;
    if (Number(knownIntent) + Number(knownNotice) !== 1) return null;

    for (const key of candidate.searchParams.keys()) {
      if (key !== INTENT_PARAM && key !== NOTICE_PARAM) return null;
    }

    return {
      navigation: knownIntent
        ? { kind: "intent", intent }
        : { kind: "verification-incomplete" },
      cleanupPath: MOBILE_WEB_SECURITY_PATH,
    };
  } catch {
    return null;
  }
}
