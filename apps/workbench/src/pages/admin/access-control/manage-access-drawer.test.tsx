import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const { ManageAccessDrawer } = await import("./manage-access-drawer");

const access = {
  user: { id: "ada", displayName: "Ada", handle: "ada", server: null },
  highestRole: "member", capabilities: [], roles: [], groupRoleFacts: [],
  groups: [{ id: "members", type: "members", label: "Members", isSystem: true, ownerId: null, roleSlugs: ["member"] }],
};
const catalogue = { capabilities: [], roles: [
  { id: "member-role", slug: "member", label: "Member", isSystem: true, capabilitySlugs: [], groupCount: 1 },
  { id: "community-role", slug: "community", label: "Community", isSystem: true, capabilitySlugs: [], groupCount: 1 },
  { id: "mobile-role", slug: "mobile", label: "Mobile", isSystem: false, capabilitySlugs: ["control_home"], groupCount: 1 },
], groups: [
  { id: "members", type: "members", label: "Members", isSystem: true, ownerId: null, roleSlugs: ["member"], memberCount: 1 },
  { id: "communities", type: "communities", label: "Communities", isSystem: true, ownerId: null, roleSlugs: ["community"], memberCount: 0 },
  { id: "mobile", type: "custom:mobile", label: "Mobile", isSystem: false, ownerId: "owner", roleSlugs: ["mobile"], memberCount: 0 },
] };

afterEach(() => cleanup());

describe("ManageAccessDrawer", () => {
  test("traps focus, closes on Escape, and restores focus", () => {
    reapplyHappyDomGlobals();
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const close = mock(() => undefined);
    const view = render(<ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={["manage_members", "control_home"]} canCreateSharedAccessExisting canCreateSharedAccessNew onClose={close} onReview={() => undefined} onCreateSharedAccess={() => undefined} />);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Close manage access" }));
    const lastButton = view.getByRole("button", { name: "Create shared access" }); lastButton.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Close manage access" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  test("does not render a dead shared-access action without composite permissions", () => {
    reapplyHappyDomGlobals();
    const view = render(<ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={["manage_members", "control_home"]} canCreateSharedAccessExisting={false} canCreateSharedAccessNew={false} onClose={() => undefined} onReview={() => undefined} onCreateSharedAccess={() => undefined} />);
    expect(view.queryByRole("button", { name: "Create shared access" })).toBeNull();
    expect(view.getByText(/requires manage_groups and manage_members/)).toBeTruthy();
  });

  test("offers only the existing Permission-set path without manage_roles", () => {
    reapplyHappyDomGlobals();
    const view = render(<ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={["manage_members", "control_home"]} canCreateSharedAccessExisting canCreateSharedAccessNew={false} onClose={() => undefined} onReview={() => undefined} onCreateSharedAccess={() => undefined} />);
    expect(view.getByRole("button", { name: "Create shared access" })).toBeTruthy();
    expect(view.getByText(/existing Permission set/)).toBeTruthy();
  });

  test("disables membership changes when the target Group bundle exceeds the viewer", () => {
    reapplyHappyDomGlobals();
    const view = render(<ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={["manage_members"]} canCreateSharedAccessExisting={false} canCreateSharedAccessNew={false} onClose={() => undefined} onReview={() => undefined} onCreateSharedAccess={() => undefined} />);
    const mobile = view.getByText("Mobile").closest("label");
    expect((mobile?.querySelector("input") as HTMLInputElement).disabled).toBeTrue();
    expect(view.getByText(/Requires the target Group bundle: control_home/)).toBeTruthy();
  });

  test("shows Community but disables adding a non-member", () => {
    reapplyHappyDomGlobals();
    const view = render(<ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={["manage_members"]} canCreateSharedAccessExisting={false} canCreateSharedAccessNew={false} onClose={() => undefined} onReview={() => undefined} onCreateSharedAccess={() => undefined} />);
    const communities = view.getByText("Communities").closest("label");
    expect((communities?.querySelector("input") as HTMLInputElement).disabled).toBeTrue();
    expect(view.getByText(/Community enrollment is unavailable/)).toBeTruthy();
  });
});
