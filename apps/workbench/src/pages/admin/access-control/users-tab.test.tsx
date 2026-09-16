import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const effectiveAccess = {
  user: { id: "ada", handle: "ada", displayName: "Ada", server: null },
  highestRole: "member",
  capabilities: [{ slug: "use_workstation_profiles", description: "", category: "", granted: true, provenance: [] }],
  groups: [],
  roles: [],
  groupRoleFacts: [],
};

let getEffectiveAccess = async () => effectiveAccess;
let getCatalogue = async () => ({ capabilities: [], roles: [], groups: [] });
let listUsers = async () => ({ users: [{ id: "ada", handle: "ada", displayName: "Ada", server: null, groups: [], disabledAt: null }, { id: "ben", handle: "ben", displayName: "Ben", server: null, groups: [], disabledAt: null }], nextCursor: null });
mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: {
      users: { list: (options: { cursor?: string }) => listUsers(options) },
      accessControl: { getEffectiveAccess: (id: string) => getEffectiveAccess(id), getCatalogue: () => getCatalogue() },
    },
  },
}));

const { UsersTab } = await import("./users-tab");

afterEach(() => { cleanup(); getEffectiveAccess = async () => effectiveAccess; getCatalogue = async () => ({ capabilities: [], roles: [], groups: [] }); listUsers = async () => ({ users: [{ id: "ada", handle: "ada", displayName: "Ada", server: null, groups: [], disabledAt: null }, { id: "ben", handle: "ben", displayName: "Ben", server: null, groups: [], disabledAt: null }], nextCursor: null }); });

describe("UsersTab", () => {
  test("loads a bookmarkable Human selection and renders granted access", async () => {
    reapplyHappyDomGlobals();
    const view = render(
      <MemoryRouter initialEntries={["/admin/access-control/users/ada"]}>
        <Routes><Route path="/admin/access-control/users/:userId" element={<UsersTab userId="ada" />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByText("use_workstation_profiles")).toBeTruthy());
    expect(view.getByText("Granted")).toBeTruthy();
    expect(view.getByText("Canonical ladder:")).toBeTruthy();
  });

  test("does not let an older Human response overwrite the current selection or mutation target", async () => {
    reapplyHappyDomGlobals();
    let resolveAda!: (value: typeof effectiveAccess) => void;
    let resolveBen!: (value: typeof effectiveAccess) => void;
    getEffectiveAccess = (id: string) => new Promise((resolve) => {
      if (id === "ada") resolveAda = resolve;
      else resolveBen = resolve;
    });
    const review = mock(() => undefined);
    const view = render(<MemoryRouter><UsersTab userId="ada" onReview={review} /></MemoryRouter>);
    view.rerender(<MemoryRouter><UsersTab userId="ben" onReview={review} /></MemoryRouter>);
    resolveBen({ ...effectiveAccess, user: { ...effectiveAccess.user, id: "ben", displayName: "Ben" }, groups: [{ id: "team", type: "custom:team", label: "Team", isSystem: false, ownerId: "owner", roleSlugs: [] }] });
    await waitFor(() => expect(view.getByRole("heading", { name: "Ben" })).toBeTruthy());
    resolveAda({ ...effectiveAccess, user: { ...effectiveAccess.user, id: "ada", displayName: "Taylor" }, groups: [{ id: "old-team", type: "custom:old", label: "Old team", isSystem: false, ownerId: "owner", roleSlugs: [] }] });
    await waitFor(() => expect(view.queryByRole("heading", { name: "Taylor" })).toBeNull());
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    expect(review).toHaveBeenCalledWith({ kind: "membership.remove", groupId: "team", userId: "ben" });
  });

  test("does not open Manage access after its catalogue resolves for a previous Human", async () => {
    reapplyHappyDomGlobals();
    let resolveCatalogue!: (value: { capabilities: never[]; roles: never[]; groups: never[] }) => void;
    getCatalogue = () => new Promise((resolve) => { resolveCatalogue = resolve; });
    getEffectiveAccess = async (id) => id === "ben"
      ? { ...effectiveAccess, user: { ...effectiveAccess.user, id: "ben", displayName: "Ben" } }
      : effectiveAccess;
    const review = mock(() => undefined);
    const view = render(<MemoryRouter><UsersTab userId="ada" onReview={review} /></MemoryRouter>);
    await waitFor(() => expect(view.getByRole("heading", { name: "Ada" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Manage access" }));
    view.rerender(<MemoryRouter><UsersTab userId="ben" onReview={review} /></MemoryRouter>);
    await waitFor(() => expect(view.getByRole("heading", { name: "Ben" })).toBeTruthy());
    resolveCatalogue({ capabilities: [], roles: [], groups: [] });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("loads a later page without duplicates and can select that Human", async () => {
    reapplyHappyDomGlobals();
    listUsers = async ({ cursor }) => cursor === "page-2"
      ? { users: [{ id: "cora", handle: "cora", displayName: "Cora", server: null, groups: [], disabledAt: null }], nextCursor: null }
      : { users: [{ id: "ada", handle: "ada", displayName: "Ada", server: null, groups: [], disabledAt: null }], nextCursor: "page-2" };
    getEffectiveAccess = async (id) => ({ ...effectiveAccess, user: { ...effectiveAccess.user, id, displayName: id === "cora" ? "Cora" : "Ada" } });
    const view = render(<MemoryRouter><UsersTab /></MemoryRouter>);
    await waitFor(() => expect(view.getByText("@ada")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Load more users" }));
    await waitFor(() => expect(view.getByText("@cora")).toBeTruthy());
    expect(view.getAllByText("@ada")).toHaveLength(1);
    fireEvent.click(view.getByText("@cora"));
    expect(view.getByText("@cora").closest("a")?.getAttribute("href")).toBe("/admin/access-control/users/cora");
  });

  test("uses the existing membership machinery for the protected uncontained-host Group", async () => {
    reapplyHappyDomGlobals();
    getCatalogue = async () => ({
      capabilities: [],
      roles: [],
      groups: [{
        id: "uncontained-host-commands",
        type: "uncontained_host_commands_grantees",
        label: "Uncontained host commands grantees",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["uncontained_host_commands_grantee"],
        memberCount: 0,
      }],
    });
    const review = mock(() => undefined);
    const view = render(<MemoryRouter><UsersTab userId="ada" onReview={review} /></MemoryRouter>);

    await waitFor(() => expect(view.getByRole("heading", { name: "Ada" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Manage access" }));
    await waitFor(() => expect(view.getByText("Uncontained host commands grantees")).toBeTruthy());
    fireEvent.click(view.getByLabelText(/Uncontained host commands grantees/));
    fireEvent.click(view.getByRole("button", { name: "Review change" }));

    expect(review).toHaveBeenCalledWith({
      kind: "membership.add",
      groupId: "uncontained-host-commands",
      userId: "ada",
    });
  });

  test("uses the same machinery to remove the protected membership", async () => {
    reapplyHappyDomGlobals();
    const protectedGroup = {
      id: "uncontained-host-commands",
      type: "uncontained_host_commands_grantees",
      label: "Uncontained host commands grantees",
      isSystem: true,
      ownerId: null,
      roleSlugs: ["uncontained_host_commands_grantee"],
    };
    getEffectiveAccess = async () => ({ ...effectiveAccess, groups: [protectedGroup] });
    getCatalogue = async () => ({
      capabilities: [], roles: [], groups: [{ ...protectedGroup, memberCount: 1 }],
    });
    const review = mock(() => undefined);
    const view = render(<MemoryRouter><UsersTab userId="ada" onReview={review} /></MemoryRouter>);

    await waitFor(() => expect(view.getByRole("heading", { name: "Ada" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Manage access" }));
    await waitFor(() => expect(view.getByText("Uncontained host commands grantees")).toBeTruthy());
    fireEvent.click(view.getByLabelText(/Uncontained host commands grantees/));
    fireEvent.click(view.getByRole("button", { name: "Review change" }));

    expect(review).toHaveBeenCalledWith({
      kind: "membership.remove",
      groupId: "uncontained-host-commands",
      userId: "ada",
    });
  });
});
