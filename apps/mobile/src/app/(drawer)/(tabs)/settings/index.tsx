import { router, type Href } from "expo-router";
import { useMemo } from "react";

import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createSettingsLanding } from "@/features/settings/settings-shell";
import { useAuth } from "@/providers/auth";
import { useThemePreference } from "@/providers/theme";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";

/** Grouped native Settings landing. Only rows with live D465 routes are shown. */
export default function SettingsIndexScreen() {
  const openDrawer = useOpenAppDrawer();
  const { status, viewer, viewerState } = useAuth();
  const { preference } = useThemePreference();
  const platformCapabilities = usePlatformCapabilities();
  const landing = useMemo(
    () =>
      createSettingsLanding({
        authState: status,
        viewerState,
        viewerName: viewer?.displayName ?? viewer?.handle,
        themePreference: preference,
        platformCapabilities,
      }),
    [platformCapabilities, preference, status, viewer?.displayName, viewer?.handle, viewerState],
  );

  return (
    <>
      <AppBar title="Settings" onMenuPress={openDrawer} />
      <Screen edgeTop={false}>
        {landing.notice ? (
          <SettingsStatus tone={landing.notice.tone}>{landing.notice.message}</SettingsStatus>
        ) : null}
        {landing.sections
          .filter((section) => section.rows.length > 0)
          .map((section) => (
            <SettingsSection key={section.id} title={section.title}>
              {section.rows.map((row) => (
                <SettingsRow
                  key={row.id}
                  label={row.label}
                  summary={row.summary}
                  accessibilityHint={row.accessibilityHint}
                  onPress={() => router.push(row.route as Href)}
                />
              ))}
            </SettingsSection>
          ))}
      </Screen>
    </>
  );
}
