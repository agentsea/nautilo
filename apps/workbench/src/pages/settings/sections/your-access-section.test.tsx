import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

let calls = 0;
let effectiveAccess = {
  user: { id: "ada", handle: "ada", displayName: "Ada", server: null },
  highestRole: "member",
  capabilities: [{ slug: "use_workstation_profiles", description: "", category: "", granted: true, provenance: [] }],
  groups: [], roles: [], groupRoleFacts: [],
};
mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true, label: "Ada", capabilities: ["manage_members"] } }),
}));
mock.module("../../../hooks/use-can", () => ({
  useCan: () => (cap: string) => cap === "manage_members",
}));
mock.module("../../../lib/api", () => ({
  apiClient: {
    accessControl: {
      getMyEffectiveAccess: async () => {
        calls += 1;
        return effectiveAccess;
      },
    },
  },
}));

const { YourAccessSection } = await import("./your-access-section");

afterEach(() => {
  cleanup();
  effectiveAccess = {
    user: { id: "ada", handle: "ada", displayName: "Ada", server: null },
    highestRole: "member",
    capabilities: [{ slug: "use_workstation_profiles", description: "", category: "", granted: true, provenance: [] }],
    groups: [], roles: [], groupRoleFacts: [],
  };
});

describe("YourAccessSection", () => {
  test("uses the auth viewer and one provenance read", async () => {
    reapplyHappyDomGlobals();
    calls = 0;
    const view = render(<MemoryRouter><YourAccessSection /></MemoryRouter>);
    await waitFor(() => expect(view.getByText("use_workstation_profiles")).toBeTruthy());
    expect(view.getByText(/Signed in as Ada/)).toBeTruthy();
    expect(calls).toBe(1);
    expect(view.getByRole("link", { name: "Open access control" })).toBeTruthy();
  });

  test("shows the exact protected Group-to-Role grant and canonical role floor without calling it activation", async () => {
    reapplyHappyDomGlobals();
    effectiveAccess = {
      ...effectiveAccess,
      highestRole: "superuser",
      groups: [{
        id: "grant-group",
        type: "uncontained_host_commands_grantees",
        label: "Uncontained host commands grantees",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["uncontained_host_commands_grantee"],
      }],
      groupRoleFacts: [{
        groupId: "grant-group",
        groupType: "uncontained_host_commands_grantees",
        groupLabel: "Uncontained host commands grantees",
        groupIsSystem: true,
        groupOwnerId: null,
        roleSlug: "uncontained_host_commands_grantee",
        roleLabel: "Uncontained host commands grantee",
        roleIsSystem: true,
        capabilitySlugs: [],
      }],
    };
    const view = render(<MemoryRouter><YourAccessSection /></MemoryRouter>);

    await waitFor(() => expect(view.getByText("Positive grant:")).toBeTruthy());
    expect(view.getAllByText("Granted")).toHaveLength(2);
    expect(view.getByText(/Uncontained host commands grantees → Uncontained host commands grantee/)).toBeTruthy();
    expect(view.getByText(/Canonical role floor: Superuser-or-above/)).toBeTruthy();
    expect(view.getByText(/does not evaluate server policy or activate/i)).toBeTruthy();
  });

  test("fails closed when the protected Group has no matching protected Role provenance", async () => {
    reapplyHappyDomGlobals();
    effectiveAccess = {
      ...effectiveAccess,
      groups: [{
        id: "grant-group",
        type: "uncontained_host_commands_grantees",
        label: "Uncontained host commands grantees",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["wrong_role"],
      }],
      groupRoleFacts: [{
        groupId: "grant-group",
        groupType: "uncontained_host_commands_grantees",
        groupLabel: "Uncontained host commands grantees",
        groupIsSystem: true,
        groupOwnerId: null,
        roleSlug: "wrong_role",
        roleLabel: "Wrong role",
        roleIsSystem: true,
        capabilitySlugs: [],
      }],
    };
    const view = render(<MemoryRouter><YourAccessSection /></MemoryRouter>);

    await waitFor(() => expect(view.getByText("Positive grant:")).toBeTruthy());
    expect(view.getByText("Not granted")).toBeTruthy();
    expect(view.queryByText(/^Source:/)).toBeNull();
  });

  test("fails closed when the protected Group has no role provenance", async () => {
    reapplyHappyDomGlobals();
    effectiveAccess = {
      ...effectiveAccess,
      groups: [{
        id: "grant-group",
        type: "uncontained_host_commands_grantees",
        label: "Uncontained host commands grantees",
        isSystem: true,
        ownerId: null,
        roleSlugs: [],
      }],
    };
    const view = render(<MemoryRouter><YourAccessSection /></MemoryRouter>);

    await waitFor(() => expect(view.getByText("Positive grant:")).toBeTruthy());
    expect(view.getByText("Not granted")).toBeTruthy();
    expect(view.queryByText(/^Source:/)).toBeNull();
  });
});
