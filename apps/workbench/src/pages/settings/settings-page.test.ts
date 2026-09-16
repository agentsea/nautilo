import { expect, test } from "bun:test";
import { WORKBENCH_APPLICATION_TARGETS } from "../../lib/genie-application-targets";
import { visibleSettingsSections } from "./settings-page";
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
    .some((section) => section.id === "costs")).toBeFalse();
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

test("self-service invitations expose only bounded ladder targets", () => {
  expect(inviteRoleOptions(false)).toEqual(["member", "contributor", "guest"]);
  expect(inviteRoleOptions(true)).toEqual([
    "owner",
    "admin",
    "superuser",
    "member",
    "contributor",
    "guest",
  ]);
});
