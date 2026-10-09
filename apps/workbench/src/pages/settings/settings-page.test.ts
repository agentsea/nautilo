import { expect, test } from "bun:test";
import { WORKBENCH_APPLICATION_TARGETS } from "../../lib/genie-application-targets";
import { activeSectionForHash, visibleSettingsSections } from "./settings-page";
import { inviteRoleOptions } from "./sections/members-section";

test("Desktop-only settings are reachable only in the Desktop shell", () => {
  const shared = {
    canCreateInvites: true,
  } as const;

  expect(visibleSettingsSections({ ...shared, isDesktopShell: true })
    .some((section) => section.id === "this-mac")).toBeTrue();
  expect(visibleSettingsSections({ ...shared, isDesktopShell: false })
    .some((section) => section.id === "this-mac")).toBeFalse();
  expect(WORKBENCH_APPLICATION_TARGETS["settings.desktop_permissions"].availability)
    .toEqual({ desktop: true });
  expect(WORKBENCH_APPLICATION_TARGETS["settings.startup"].availability)
    .toEqual({ desktop: true });
  expect("settings.playback" in WORKBENCH_APPLICATION_TARGETS).toBeFalse();
  expect(visibleSettingsSections({ ...shared, isDesktopShell: true })
    .some((section) => section.id === "invite-people")).toBeTrue();
  expect(WORKBENCH_APPLICATION_TARGETS["settings.invite_people"].availability)
    .toEqual({ anyCapabilities: ["create_invites"] });
});

test("Invite people is hidden without self-service invitation authority", () => {
  expect(visibleSettingsSections({
    isDesktopShell: true,
    canCreateInvites: false,
  }).some((section) => section.id === "invite-people")).toBeFalse();
});

test("personal API keys have a permanent Settings destination", () => {
  expect(activeSectionForHash("personal-provider-keys")).toBe("personal-provider-keys");
  for (const isDesktopShell of [false, true]) {
    const sections = visibleSettingsSections({ isDesktopShell, canCreateInvites: false });
    expect(sections.find((section) => section.id === "personal-provider-keys")?.label)
      .toBe("Personal API keys");
  }
  expect(WORKBENCH_APPLICATION_TARGETS["settings.personal_api_keys"].href)
    .toBe("/settings#personal-provider-keys");
  expect(WORKBENCH_APPLICATION_TARGETS["costs.personal"].href)
    .toBe("/account/costs");
});

test("personal costs deep-link through the personal API key area", () => {
  expect(activeSectionForHash("personal-costs")).toBe("personal-provider-keys");
});

test("self-service invitations expose only bounded ladder targets", () => {
  expect(inviteRoleOptions(false)).toEqual(["member", "contributor", "community", "guest"]);
  expect(inviteRoleOptions(true)).toEqual([
    "owner",
    "admin",
    "superuser",
    "member",
    "contributor",
    "community",
    "guest",
  ]);
});
