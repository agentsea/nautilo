import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const listHumans = mock(async () => [{ userId: "ada", displayName: "Ada", handle: "ada" }]);
mock.module("../../../lib/api", () => ({ apiClient: { admin: { accessControl: { listHumans } } } }));
const { CreateSharedAccessDialog, createSharedAccessOperation } = await import("./create-shared-access-dialog");

const catalogue = {
  capabilities: [{ slug: "use_terminal", description: "", category: "" }],
  roles: [{ id: "mobile", slug: "mobile", label: "Mobile", isSystem: false, capabilitySlugs: ["use_terminal"], groupCount: 0 }],
  groups: [],
};

afterEach(() => { cleanup(); listHumans.mockClear(); });

describe("CreateSharedAccessDialog", () => {
  test("selects an existing Permission set for an atomic reviewed operation", () => {
    reapplyHappyDomGlobals();
    const view = render(<CreateSharedAccessDialog catalogue={catalogue} canCreateExisting canCreateNew canDelegate={() => true} onClose={() => undefined} onReview={() => undefined} />);
    fireEvent.click(view.getByRole("radio", { name: "Use existing custom Permission set" }));
    expect(view.getByLabelText("Existing Permission set").hasAttribute("disabled")).toBe(false);
    expect(view.getByText(/selected existing Permission set atomically/)).toBeTruthy();
    expect(createSharedAccessOperation({ source: "existing", groupLabel: "Mobile developers", roleLabel: "", capabilities: [], existingRoleSlug: "mobile", ownerUserId: "owner", memberUserIds: ["ada"] })).toEqual({
      kind: "shared_access.assign_existing", roleSlug: "mobile",
      group: { groupType: "custom:mobile-developers", label: "Mobile developers", ownerUserId: "owner" }, memberUserIds: ["ada"],
    });
  });

  test("marks the new Permission-set path atomic and restores focus", async () => {
    reapplyHappyDomGlobals();
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const close = mock(() => undefined);
    const view = render(<CreateSharedAccessDialog catalogue={catalogue} canCreateExisting canCreateNew canDelegate={() => true} onClose={close} onReview={() => undefined} />);
    await waitFor(() => expect(view.getByLabelText(/Ada/)).toBeTruthy());
    expect(view.getByRole("button", { name: "Review atomic change" })).toBeTruthy();
    expect(view.getByText(/Both paths use one atomic reviewed operation/i)).toBeTruthy();
    view.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Close create shared access" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  test("keeps the new Permission-set atomic operation shape", () => {
    expect(createSharedAccessOperation({ source: "new", groupLabel: "Mobile developers", roleLabel: "Mobile development", capabilities: ["use_terminal"], existingRoleSlug: "", ownerUserId: "owner", memberUserIds: ["ada"] })).toEqual({
      kind: "shared_access.create",
      role: { slug: "mobile-development", label: "Mobile development", capabilities: ["use_terminal"] },
      group: { groupType: "custom:mobile-developers", label: "Mobile developers", ownerUserId: "owner" }, memberUserIds: ["ada"],
    });
  });

  test("disables only the new Permission-set path without manage_roles", () => {
    reapplyHappyDomGlobals();
    const view = render(<CreateSharedAccessDialog catalogue={catalogue} canCreateExisting canCreateNew={false} canDelegate={() => true} onClose={() => undefined} onReview={() => undefined} />);
    expect(view.getByRole("radio", { name: "Create new Permission set" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("radio", { name: "Use existing custom Permission set" }).hasAttribute("disabled")).toBe(false);
    expect(view.getByLabelText("Existing Permission set")).toBeTruthy();
  });

  test("shows a Human-directory error and permits retry", async () => {
    reapplyHappyDomGlobals();
    listHumans.mockImplementationOnce(async () => { throw new Error("directory unavailable"); });
    const view = render(<CreateSharedAccessDialog catalogue={catalogue} canCreateExisting canCreateNew canDelegate={() => true} onClose={() => undefined} onReview={() => undefined} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("directory unavailable"));
    expect((view.getByRole("button", { name: "Review atomic change" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Retry loading Humans" }));
    await waitFor(() => expect(view.getByLabelText(/Ada/)).toBeTruthy());
  });
});
