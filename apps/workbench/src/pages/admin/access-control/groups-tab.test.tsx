import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

let capabilities: string[] = ["manage_members", "invoke_agents"];
const listHumans = mock(async () => [{ userId: "owner", displayName: "Owner", handle: "owner" }]);
const listGroupMembers = mock(async () => ({ members: [] }));
mock.module("../../../hooks/use-can", () => ({ useCan: () => (capability: string) => capabilities.includes(capability) }));
mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { capabilities } }),
}));
mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: { accessControl: { listHumans } },
    groups: { listGroupMembers },
  },
}));
mock.module("./access-control-context", () => ({
  useAccessControl: () => ({
    loading: false, error: null,
    catalogue: {
      capabilities: [],
      roles: [{ id: "role", slug: "member", label: "Member", isSystem: true, capabilitySlugs: ["invoke_agents"], groupCount: 1 }],
      groups: [
        { id: "system", type: "members", label: "Members", isSystem: true, ownerId: null, roleSlugs: ["member"], memberCount: 2 },
        { id: "custom", type: "custom:mobile-dev", label: "Mobile developers", isSystem: false, ownerId: "owner", roleSlugs: [], memberCount: 0 },
        { id: "custom-b", type: "custom:web-dev", label: "Web developers", isSystem: false, ownerId: "owner", roleSlugs: ["member"], memberCount: 0 },
      ],
    },
  }),
}));
const { GroupsTab } = await import("./groups-tab");
afterEach(() => { cleanup(); capabilities = ["manage_members", "invoke_agents"]; listHumans.mockClear(); listGroupMembers.mockClear(); });

describe("GroupsTab", () => {
  test("labels system groups protected and keeps custom groups separate", () => {
    reapplyHappyDomGlobals();
    const view = render(<GroupsTab onReview={() => undefined} />);
    fireEvent.click(view.getByText("Members"));
    expect(view.getByText(/Protected system-managed definition/)).toBeTruthy();
    expect(view.getByText(/Custom — user-managed, orthogonal to ladder/)).toBeTruthy();
  });

  test("loads owners for group managers without exposing membership controls", async () => {
    reapplyHappyDomGlobals();
    capabilities = ["manage_groups"];
    const view = render(<GroupsTab onReview={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "New custom group" }));
    await waitFor(() => expect(view.getByRole("option", { name: "Owner" })).toBeTruthy());
    fireEvent.click(view.getByText("Members"));
    expect(view.getByText(/Membership management requires manage_members/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Review add" })).toBeNull();
  });

  test("reloads the selected roster after an applied refresh", async () => {
    reapplyHappyDomGlobals();
    const view = render(<GroupsTab onReview={() => undefined} refreshKey={0} />);
    fireEvent.click(view.getByText("Members"));
    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledTimes(1));
    view.rerender(<GroupsTab onReview={() => undefined} refreshKey={1} />);
    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledTimes(2));
  });

  test("disables membership mutation without the target Group bundle", () => {
    reapplyHappyDomGlobals();
    capabilities = ["manage_members"];
    const view = render(<GroupsTab onReview={() => undefined} />);
    fireEvent.click(view.getByText("Members"));
    expect(view.getByText(/target Group bundle: invoke_agents/)).toBeTruthy();
    expect((view.getByRole("button", { name: "Review add" }) as HTMLButtonElement).disabled)
      .toBeTrue();
  });

  test("ignores an out-of-order roster response and reviews the matching Group/member", async () => {
    reapplyHappyDomGlobals();
    let resolveSystem!: (value: { members: Array<{ userId: string; displayName: string; handle: string }> }) => void;
    let resolveCustom!: (value: { members: Array<{ userId: string; displayName: string; handle: string }> }) => void;
    listGroupMembers.mockImplementation((groupId: string) => new Promise((resolve) => {
      if (groupId === "system") resolveSystem = resolve;
      else resolveCustom = resolve;
    }));
    const review = mock(() => undefined);
    const view = render(<GroupsTab onReview={review} />);
    fireEvent.click(view.getByText("Members"));
    fireEvent.click(view.getByText("Mobile developers"));
    resolveCustom({ members: [{ userId: "ben", displayName: "Ben", handle: "ben" }] });
    await waitFor(() => expect(view.getByText(/Ben \(@ben\)/)).toBeTruthy());
    resolveSystem({ members: [{ userId: "ada", displayName: "Ada", handle: "ada" }] });
    await waitFor(() => expect(view.queryByText(/Ada \(@ada\)/)).toBeNull());
    fireEvent.click(view.getByRole("button", { name: "Review removal" }));
    expect(review).toHaveBeenCalledWith({ kind: "membership.remove", groupId: "custom", userId: "ben" });
  });

  test("surfaces Human-directory failures and retries", async () => {
    reapplyHappyDomGlobals();
    listHumans.mockImplementationOnce(async () => { throw new Error("directory unavailable"); });
    const view = render(<GroupsTab onReview={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "New custom group" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("directory unavailable"));
    fireEvent.click(view.getByRole("button", { name: "Retry loading Humans" }));
    await waitFor(() => expect(view.getByRole("option", { name: "Owner" })).toBeTruthy());
  });

  test("closes A's editor on selection and hydrates B before reviewing B", () => {
    reapplyHappyDomGlobals();
    const review = mock(() => undefined);
    const view = render(<GroupsTab onReview={review} />);
    fireEvent.click(view.getByText("Mobile developers"));
    fireEvent.click(view.getByRole("button", { name: "Edit definition" }));
    fireEvent.change(view.getByDisplayValue("Mobile developers"), { target: { value: "A's stale label" } });
    fireEvent.click(view.getByText("Web developers"));
    expect(view.queryByDisplayValue("A's stale label")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Edit definition" }));
    expect(view.getByDisplayValue("Web developers")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Review change" }));
    expect(review).toHaveBeenCalledWith({ kind: "group.set_roles", groupId: "custom-b", roleSlugs: ["member"] });
  });
});
