import type { ThemePreference } from "@/providers/theme";
import type { MobilePlatformCapabilities } from "@/platform/capability-contract";

export type SettingsRoute =
  | "/settings/profile" | "/settings/human-profile" | "/settings/voice" | "/settings/models"
  | "/settings/security" | "/settings/approvals" | "/settings/skills" | "/settings/commands"
  | "/settings/account-deletion" | "/settings/appearance" | "/settings/notifications"
  | "/settings/user-agreement" | "/settings/about";

export type SettingsRowId =
  | "profile" | "human-profile" | "voice" | "models" | "security" | "approvals"
  | "skills" | "commands" | "account-deletion" | "appearance" | "notifications"
  | "user-agreement" | "about";

export type SettingsSectionId = "agent" | "account" | "app";

export type SettingsViewerState = "loading" | "cached" | "verified" | "stale" | "none";

export type SettingsAuthState = "loading" | "signed-in" | "signed-out";

export interface SettingsLandingRow {
  readonly id: SettingsRowId;
  readonly label: string;
  readonly summary?: string;
  readonly route: SettingsRoute;
  readonly accessibilityHint: string;
}

export interface SettingsLandingSection {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly rows: readonly SettingsLandingRow[];
}

export interface SettingsLandingNotice {
  readonly tone: "info" | "warning" | "error";
  readonly message: string;
}

export interface SettingsLandingInput {
  readonly authState: SettingsAuthState;
  readonly viewerState: SettingsViewerState;
  readonly viewerName?: string | null;
  readonly themePreference: ThemePreference;
  readonly platformCapabilities: MobilePlatformCapabilities;
  /** Access is supplied by the concurrent Phase 2 route implementation. */
  readonly hasAccessDestination?: boolean;
}

export interface SettingsLandingModel {
  readonly sections: readonly SettingsLandingSection[];
  readonly notice?: SettingsLandingNotice;
}

const appearanceSummary: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Presentation-only Settings route inventory. Keeping visibility here makes a
 * row impossible to advertise without the route its press handler will push.
 */
export function createSettingsLanding(input: SettingsLandingInput): SettingsLandingModel {
  const signedIn = input.authState === "signed-in";
  const agentRows: SettingsLandingRow[] = signedIn ? [
    { id: "profile", label: "Agent profile", route: "/settings/profile", accessibilityHint: "Opens your Agent profile and Soul instructions." },
    ...(input.platformCapabilities.decisions.voice.status === "supported" ? [
      { id: "voice" as const, label: "Voice & playback", route: "/settings/voice" as const, accessibilityHint: "Opens Agent voice assignments and this phone's playback preference." },
    ] : []),
    { id: "models", label: "Models & defaults", route: "/settings/models", accessibilityHint: "Opens your Agent's default model selection." },
    { id: "skills", label: "Skills", route: "/settings/skills", accessibilityHint: "Browses your Agent's server-managed Skills." },
    { id: "commands", label: "Commands", route: "/settings/commands", accessibilityHint: "Manages your Agent's server-authoritative slash Commands." },
  ] : [];
  const accountRows: SettingsLandingRow[] = [];

  if (input.authState === "signed-in" && input.hasAccessDestination !== false) {
    accountRows.push({
      id: "human-profile",
      label: "Your profile",
      summary: input.viewerName?.trim() || undefined,
      route: "/settings/human-profile",
      accessibilityHint: "Opens your Human identity and portrait on this server.",
    });
    accountRows.push(
      { id: "security", label: "PIN, password & recovery", route: "/settings/security", accessibilityHint: "Opens your PIN, password, and separate recovery-code settings." },
      { id: "approvals", label: "Standing approvals", route: "/settings/approvals", accessibilityHint: "Opens your active standing tool approvals." },
      { id: "account-deletion", label: "Delete account", route: "/settings/account-deletion", accessibilityHint: "Opens permanent account deletion for this server." },
    );
  }

  return {
    sections: [
      { id: "agent", title: "Agent capabilities", rows: agentRows },
      { id: "account", title: "Your Account", rows: accountRows },
      {
        id: "app",
        title: "App",
        rows: [
          {
            id: "appearance",
            label: "Appearance",
            summary: appearanceSummary[input.themePreference],
            route: "/settings/appearance",
            accessibilityHint: "Opens theme appearance settings stored on this phone.",
          },
          ...(input.platformCapabilities.decisions.notifications.status === "supported" ? [{
            id: "notifications",
            label: "Notifications",
            route: "/settings/notifications",
            accessibilityHint: "Opens this device's push permission and badge settings, plus this server's notification policy.",
          } as const] : []),
          ...(signedIn && input.platformCapabilities.platform === "native" ? [{
            id: "user-agreement",
            label: "User agreement",
            route: "/settings/user-agreement",
            accessibilityHint: "Reviews the Mobile Community Rules and external-processing agreement.",
          } as const] : []),
          {
            id: "about",
            label: "About",
            route: "/settings/about",
            accessibilityHint: "Opens Nautilo app and connected-server information.",
          },
        ],
      },
    ],
    ...(landingNotice(input) ? { notice: landingNotice(input) } : {}),
  };
}

function landingNotice(input: SettingsLandingInput): SettingsLandingNotice | undefined {
  if (input.authState === "loading") {
    return { tone: "info", message: "Checking your account…" };
  }
  if (input.authState === "signed-out") {
    return { tone: "error", message: "Sign in to manage account settings." };
  }
  if (input.viewerState === "stale") {
    return {
      tone: "warning",
      message: "Account details may be out of date. Reconnect before making changes.",
    };
  }
  if (input.viewerState === "none") {
    return {
      tone: "error",
      message: "Account details are unavailable. Sign in again to continue.",
    };
  }
  return undefined;
}
