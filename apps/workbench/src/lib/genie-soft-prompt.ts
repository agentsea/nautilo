const STORAGE_PREFIX = "nautilo:d112:genie-soft-dismissed:";

export function genieSoftPromptStorageKey(sessionUserId: string): string {
  return `${STORAGE_PREFIX}${sessionUserId}`;
}

export function isGenieSoftPromptDismissed(
  sessionUserId: string | null,
  getItem: (key: string) => string | null,
): boolean {
  if (!sessionUserId) return true;
  try {
    return getItem(genieSoftPromptStorageKey(sessionUserId)) === "1";
  } catch {
    return true;
  }
}

export function shouldOfferGenieSoftPrompt(args: {
  setupState: string;
  genieCustomized: boolean | undefined;
  sessionUserId: string | null;
  getItem: (key: string) => string | null;
}): boolean {
  if (args.setupState !== "ready") return false;
  if (args.genieCustomized !== false) return false;
  if (!args.sessionUserId) return false;
  return !isGenieSoftPromptDismissed(args.sessionUserId, args.getItem);
}

export function markGenieSoftPromptDismissed(
  sessionUserId: string | null,
  setItem: (key: string, value: string) => void,
): void {
  if (!sessionUserId) return;
  try {
    setItem(genieSoftPromptStorageKey(sessionUserId), "1");
  } catch {
    // localStorage blocked — treat as ephemeral dismiss for this session only
  }
}

/** Primary CTA copy for the shared Desktop and browser customization journey. */
export function genieSoftPromptPrimaryLabel(hasDesktopBridge: boolean): string {
  void hasDesktopBridge;
  return "Customize Genie";
}

export function genieCustomizationPath(startAt?: "personality" | "avatar"): string {
  return startAt ? `/customize-genie?startAt=${startAt}` : "/customize-genie";
}

export function readWorkbenchTheme(
  getItem: (key: string) => string | null,
): "light" | "dark" | null {
  const stored = getItem("nautilo-theme");
  return stored === "light" || stored === "dark" ? stored : null;
}

type OnboardingOpen = (
  sessionToken: string | null,
  theme: "light" | "dark" | null,
) => Promise<void>;

/**
 * D162 — welcome-card primary action. Desktop: unified onboarding wizard
 * (same entry as Settings → Customize Genie). Browser: the authenticated
 * `/customize-genie` route.
 */
export async function launchGenieCustomizationFromSoftPrompt(args: {
  hasDesktopBridge: boolean;
  onboardingOpen?: OnboardingOpen;
  getAccessToken: () => Promise<string | null>;
  getTheme: () => "light" | "dark" | null;
  navigateToCustomization: () => void;
}): Promise<void> {
  if (args.hasDesktopBridge && args.onboardingOpen) {
    let token: string | null = null;
    let theme: "light" | "dark" | null = null;
    try {
      token = await args.getAccessToken();
      theme = args.getTheme();
    } catch {
      /* fall through with null token/theme — main tolerates both */
    }
    await args.onboardingOpen(token, theme);
    return;
  }
  args.navigateToCustomization();
}
