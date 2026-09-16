import { describe, expect, test } from "bun:test";
import {
  SETTINGS_NESTED_SECTIONS,
  SETTINGS_SECTIONS,
  activeSectionForHash,
  visibleSettingsSections,
} from "../../src/pages/settings/settings-page";

describe("desktop Settings section navigation", () => {
  test("puts My Agents and desktop-only This Mac immediately after the Human profile", () => {
    const profileIndex = SETTINGS_SECTIONS.findIndex((section) => section.id === "profile");
    expect(SETTINGS_SECTIONS[profileIndex]).toEqual({ id: "profile", label: "Profile", catalogueTarget: "settings.profile" });
    expect(SETTINGS_SECTIONS[profileIndex + 1]).toEqual({ id: "my-agents", label: "My Agents", catalogueTarget: "settings.my_agents" });
    expect(SETTINGS_SECTIONS[profileIndex + 2]).toEqual({ id: "this-mac", label: "This Mac", catalogueTarget: "settings.this_mac" });
    expect(SETTINGS_SECTIONS[profileIndex + 3]).toEqual({ id: "notifications", label: "Notifications", catalogueTarget: "settings.notifications" });
    expect(SETTINGS_SECTIONS.some((section) => section.id === "playback")).toBeFalse();
    expect(SETTINGS_SECTIONS.some((section) => section.id === "web-research")).toBeFalse();
    expect(activeSectionForHash("playback")).toBeNull();
    expect(activeSectionForHash("my-agents")).toBe("my-agents");
  });

  test("Agent Soul deep links highlight My Agents rather than the Human profile", () => {
    expect(activeSectionForHash("profile-soul")).toBe("my-agents");
  });

  test("nests Model and Model fallback under My Agents without losing deep links", () => {
    expect(SETTINGS_SECTIONS.some((section) => section.id === "model")).toBeFalse();
    expect(SETTINGS_SECTIONS.some((section) => section.id === "fallback")).toBeFalse();
    expect(SETTINGS_NESTED_SECTIONS).toEqual([
      { id: "model", label: "Model", catalogueTarget: "settings.model", parentId: "my-agents" },
      { id: "fallback", label: "Model fallback", catalogueTarget: "settings.fallback", parentId: "my-agents" },
      { id: "startup", label: "Ready at startup", catalogueTarget: "settings.startup", parentId: "this-mac" },
      { id: "current-folder", label: "Current folder", catalogueTarget: "settings.current_folder", parentId: "this-mac" },
      { id: "desktop-permissions", label: "macOS permissions", catalogueTarget: "settings.desktop_permissions", parentId: "this-mac" },
      { id: "workstation-access", label: "Workstation access", catalogueTarget: "settings.workstation_access", parentId: "this-mac" },
      { id: "mobile-access", label: "Mobile controllers", catalogueTarget: "settings.mobile_access", parentId: "devices" },
    ]);
    expect(activeSectionForHash("model")).toBe("my-agents");
    expect(activeSectionForHash("fallback")).toBe("my-agents");
  });

  test("nests all current-Mac controls, preserves deep links, and hides the group on web", () => {
    for (const id of ["startup", "current-folder", "desktop-permissions", "workstation-access"] as const) {
      expect(SETTINGS_SECTIONS.some((section) => section.id === id)).toBeFalse();
      expect(activeSectionForHash(id)).toBe("this-mac");
    }
    expect(activeSectionForHash("this-mac")).toBe("this-mac");

    const desktop = visibleSettingsSections({
      managedByCloud: false,
      isDesktopShell: true,
    });
    const web = visibleSettingsSections({
      managedByCloud: false,
      isDesktopShell: false,
    });
    expect(desktop.some((section) => section.id === "this-mac")).toBeTrue();
    expect(web.some((section) => section.id === "this-mac")).toBeFalse();
  });

  test("renames only personal Security to Account security", () => {
    expect(SETTINGS_SECTIONS.find((section) => section.id === "security")).toEqual({
      id: "security",
      label: "Account security",
      catalogueTarget: "settings.security",
    });
    expect(activeSectionForHash("security")).toBe("security");
  });

  test("nests Mobile controllers under Devices and preserves its deep link", () => {
    expect(SETTINGS_SECTIONS.find((section) => section.id === "devices")).toEqual({
      id: "devices",
      label: "Devices",
      catalogueTarget: "settings.devices",
    });
    expect(SETTINGS_SECTIONS.some((section) => section.id === "mobile-access")).toBeFalse();
    expect(activeSectionForHash("mobile-access")).toBe("devices");
  });
});
