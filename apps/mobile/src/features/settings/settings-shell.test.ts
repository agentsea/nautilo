/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { createSettingsLanding } from "./settings-shell";
import { platformCapabilities as nativePlatform } from "@/platform/capabilities.native";
import { platformCapabilities as webPlatform } from "@/platform/capabilities.web";

describe("Settings landing route inventory", () => {
  test("maps every visible Phase 1 row to its native Settings route", () => {
    const landing = createSettingsLanding({
      authState: "signed-in",
      viewerState: "verified",
      viewerName: "Casey",
      themePreference: "system",
      platformCapabilities: nativePlatform,
    });

    const rows = landing.sections.flatMap((section) => section.rows);
    expect(rows.map((row) => [row.id, row.route])).toEqual([
      ["profile", "/settings/profile"],
      ["voice", "/settings/voice"],
      ["models", "/settings/models"],
      ["skills", "/settings/skills"],
      ["commands", "/settings/commands"],
      ["human-profile", "/settings/human-profile"],
      ["security", "/settings/security"],
      ["provider-keys", "/settings/provider-keys"],
      ["capability-models", "/settings/capability-models"],
      ["personal-costs", "/settings/personal-costs"],
      ["approvals", "/settings/approvals"],
      ["account-deletion", "/settings/account-deletion"],
      ["appearance", "/settings/appearance"],
      ["notifications", "/settings/notifications"],
      ["user-agreement", "/settings/user-agreement"],
      ["about", "/settings/about"],
    ]);
    expect(rows.every((row) => row.accessibilityHint.length > 0)).toBe(true);
  });

  test("keeps verified, cached, stale, and unavailable identity states explicit", () => {
    const verified = createSettingsLanding({
      authState: "signed-in",
      viewerState: "verified",
      viewerName: "@casey",
      themePreference: "dark",
      platformCapabilities: nativePlatform,
    });
    const stale = createSettingsLanding({
      authState: "signed-in",
      viewerState: "stale",
      viewerName: "@casey",
      themePreference: "dark",
      platformCapabilities: nativePlatform,
    });
    const unavailable = createSettingsLanding({
      authState: "signed-in",
      viewerState: "none",
      themePreference: "dark",
      platformCapabilities: nativePlatform,
    });

    expect(verified.sections.flatMap((section) => section.rows).some((row) => row.id === "human-profile")).toBe(true);
    expect(stale.notice?.tone).toBe("warning");
    expect(unavailable.notice?.tone).toBe("error");
  });

  test("does not advertise unavailable, later-wave, or admin destinations", () => {
    const landing = createSettingsLanding({
      authState: "signed-out",
      viewerState: "none",
      themePreference: "light",
      hasAccessDestination: false,
      platformCapabilities: nativePlatform,
    });

    const ids = landing.sections.flatMap((section) => section.rows.map((row) => row.id));
    expect(ids).toEqual(["appearance", "notifications", "about"]);
    expect(landing.sections[0]?.rows).toEqual([]);
    expect(landing.notice?.message).toContain("Sign in");
  });

  test("removes unavailable Web voice and notification destinations", () => {
    const rows = createSettingsLanding({
      authState: "signed-in",
      viewerState: "verified",
      themePreference: "system",
      platformCapabilities: webPlatform,
    }).sections.flatMap((section) => section.rows);
    expect(rows.some((row) => row.id === "voice")).toBe(false);
    expect(rows.some((row) => row.id === "notifications")).toBe(false);
    expect(rows.some((row) => row.id === "user-agreement")).toBe(false);
    expect(rows.some((row) => row.id === "security")).toBe(true);
  });
});


test("personal settings keep their native header and back navigation visible", async () => {
  const layout = await Bun.file(new URL("../../app/(drawer)/(tabs)/settings/_layout.tsx", import.meta.url)).text();
  for (const route of ["provider-keys", "personal-costs", "capability-models", "capability-model-picker"]) {
    expect(layout).toContain(`name="${route}" options={{ headerShown: true }}`);
    const screen = await Bun.file(new URL(`../../app/(drawer)/(tabs)/settings/${route}.tsx`, import.meta.url)).text();
    expect(screen).toContain("<AppBar");
    expect(screen).toContain("<AppBarBackButton");
  }
});


test("capability-model account actions resolve to existing settings screens", async () => {
  const screen = await Bun.file(new URL("../../app/(drawer)/(tabs)/settings/capability-models.tsx", import.meta.url)).text();
  const destinations = [...screen.matchAll(/router\.push\("\/\(drawer\)\/\(tabs\)\/settings\/([^"/]+)"\)/g)];
  expect(destinations.length).toBeGreaterThan(0);
  for (const [, destination] of destinations) {
    expect(await Bun.file(new URL(`../../app/(drawer)/(tabs)/settings/${destination}.tsx`, import.meta.url)).exists()).toBe(true);
  }
});
