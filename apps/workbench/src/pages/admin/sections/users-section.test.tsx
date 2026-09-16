/**
 * D220 Phase 2 — Users section list, federated stubs, disable flow, and role management.
 */
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LastOwnerError } from "@nautilo/api-client/browser";
import type { CapabilitySlug } from "@nautilo/types";
import type { AdminUserRow } from "./users/user-helpers";
import { LAST_OWNER_MESSAGE } from "./users/user-helpers";

const realUseCan = await import("../../../hooks/use-can");
const realUseAuth = await import("../../../hooks/use-auth");

let mockCaps: CapabilitySlug[] = ["manage_members"];
let mockRole: "owner" | "admin" = "owner";

const canonicalGroups = [
  { id: "g-owners", type: "owners", label: "Owners", roleSlugs: ["owner"] },
  { id: "g-admins", type: "admins", label: "Admins", roleSlugs: ["admin"] },
  { id: "g-superusers", type: "superusers", label: "Superusers", roleSlugs: ["superuser"] },
  { id: "g-members", type: "members", label: "Members", roleSlugs: ["member"] },
  {
    id: "g-uncontained",
    type: "uncontained_host_commands_grantees",
    label: "Uncontained Host Commands Grantees",
    roleSlugs: ["uncontained_host_commands_grantee"],
  },
];

const localUser: AdminUserRow = {
  id: "user-local",
  handle: "alice",
  displayName: "Alice Local",
  groups: [{ id: "g-members", type: "members", label: "Members", roleSlug: "member" }],
  server: null,
  lastSeenAt: "2026-06-01T12:00:00.000Z",
  createdAt: "2026-05-01T12:00:00.000Z",
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
};

const federatedUser: AdminUserRow = {
  id: "user-fed",
  handle: "bob",
  displayName: "Bob Remote",
  groups: [{ id: "g-members", type: "members", label: "Members", roleSlug: "member" }],
  server: "otherserver",
  lastSeenAt: null,
  createdAt: "2026-05-15T12:00:00.000Z",
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
};

const disableMock = mock(async (_id: string, _reason?: string) => ({ ok: true }));
const listMock = mock(async (_options?: {
  cursor?: string;
  limit?: number;
  includeFederated?: boolean;
  search?: string;
}) => ({
  users: [localUser, federatedUser],
  nextCursor: null as string | null,
}));
const getMock = mock(async (id: string) => {
  if (id === federatedUser.id) return federatedUser;
  return localUser;
});
const deleteUserMock = mock(async (_id: string) => ({ ok: true }));
const listGroupsMock = mock(async () => ({ groups: canonicalGroups }));
const addGroupMemberMock = mock(async (_groupId: string, _userId: string) => ({
  ok: true,
}));
const removeGroupMemberMock = mock(async (_groupId: string, _userId: string) => ({
  ok: true,
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({
    session: {
      state: "signed-in" as const,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => "token",
    },
    viewer: {
      role: mockRole,
      label: "Admin",
      userIdentity: "u",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      isVerified: true,
      capabilities: mockCaps,
      staleWhoami: false,
    },
    groups: [],
  }),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: {
      users: {
        list: listMock,
        get: getMock,
        disable: disableMock,
        enable: async () => ({ ok: true }),
        resetPassword: async () => ({
          ok: true,
          url: "https://example.test/reset",
          token: "tok",
        }),
        delete: deleteUserMock,
      },
    },
    groups: {
      listGroups: listGroupsMock,
      listGroupMembers: async () => ({ members: [] }),
      addGroupMember: addGroupMemberMock,
      removeGroupMember: removeGroupMemberMock,
    },
  },
}));

const { UsersSection } = await import("./users-section");

afterAll(() => {
  mock.module("../../../hooks/use-can", () => realUseCan);
  mock.module("../../../hooks/use-auth", () => realUseAuth);
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["manage_members"];
  mockRole = "owner";
  disableMock.mockClear();
  listMock.mockClear();
  getMock.mockClear();
  listGroupsMock.mockClear();
  addGroupMemberMock.mockClear();
  removeGroupMemberMock.mockClear();
  deleteUserMock.mockClear();
});

describe("UsersSection", () => {
  test("renders the user directory from admin.users.list", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("users-directory")).toBeTruthy();
    });

    expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    expect(view.getByText("@alice")).toBeTruthy();
    expect(view.getByTestId("user-row-user-fed")).toBeTruthy();
    expect(view.getByText("@bob@otherserver")).toBeTruthy();
    expect(listMock).toHaveBeenCalled();
    expect(listGroupsMock).toHaveBeenCalled();
  });

  test("searches the existing directory through the server-side users contract", async () => {
    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("users-directory")).toBeTruthy());

    const user = userEvent.setup({ document: globalThis.document });
    await user.type(view.getByRole("searchbox", { name: "Search users" }), "ada");
    fireEvent.click(view.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(listMock.mock.calls.some(([options]) =>
        options?.search === "ada" && options.includeFederated === true,
      )).toBe(true);
    });
  });

  test("offers separate Superuser promotion before Direct Mac access for a below-floor user", async () => {
    mockCaps = ["manage_members", "manage_uncontained_host_commands"];
    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));

    const promote = await waitFor(() => view.getByRole("button", { name: "Make Superuser" }));
    const grant = await waitFor(() =>
      view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement,
    );
    expect(grant.disabled).toBe(true);
    expect(grant.textContent).toBe("Grant access");

    fireEvent.click(promote);
    await waitFor(() => {
      expect(addGroupMemberMock).toHaveBeenCalledWith("g-superusers", "user-local");
    });
  });

  test("treats Admin as already eligible and grants through the protected existing Group", async () => {
    mockCaps = ["manage_members", "manage_uncontained_host_commands"];
    const adminUser: AdminUserRow = {
      ...localUser,
      groups: [{ id: "g-admins", type: "admins", label: "Admins", roleSlug: "admin" }],
    };
    listMock.mockImplementationOnce(async () => ({ users: [adminUser], nextCursor: null }));
    getMock.mockImplementationOnce(async () => adminUser);

    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));

    await waitFor(() => expect(view.getByText("Eligible · Admin")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Make Superuser" })).toBeNull();
    const grant = await waitFor(() =>
      view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement,
    );
    expect(grant.disabled).toBe(false);
    fireEvent.click(grant);

    await waitFor(() => {
      expect(addGroupMemberMock).toHaveBeenCalledWith("g-uncontained", "user-local");
    });
  });

  test("does not let a member manager grant Direct Mac access without its dedicated capability", async () => {
    const adminUser: AdminUserRow = {
      ...localUser,
      groups: [{ id: "g-admins", type: "admins", label: "Admins", roleSlug: "admin" }],
    };
    listMock.mockImplementationOnce(async () => ({ users: [adminUser], nextCursor: null }));
    getMock.mockImplementationOnce(async () => adminUser);

    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));

    const grant = await waitFor(() =>
      view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement,
    );
    expect(grant.disabled).toBe(true);
    expect(grant.title).toBe("Requires manage_uncontained_host_commands.");
    expect(addGroupMemberMock).not.toHaveBeenCalled();
  });

  test("revokes Direct Mac access through the protected existing Group", async () => {
    mockCaps = ["manage_members", "manage_uncontained_host_commands"];
    const grantedUser: AdminUserRow = {
      ...localUser,
      groups: [
        { id: "g-superusers", type: "superusers", label: "Superusers", roleSlug: "superuser" },
        {
          id: "g-uncontained",
          type: "uncontained_host_commands_grantees",
          label: "Uncontained Host Commands Grantees",
          roleSlug: "uncontained_host_commands_grantee",
        },
      ],
    };
    listMock.mockImplementationOnce(async () => ({ users: [grantedUser], nextCursor: null }));
    getMock.mockImplementationOnce(async () => grantedUser);

    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));
    const revoke = await waitFor(() => view.getByRole("button", { name: "Revoke access" }));
    fireEvent.click(revoke);

    await waitFor(() => {
      expect(removeGroupMemberMock).toHaveBeenCalledWith("g-uncontained", "user-local");
    });
  });

  test("keeps secondary administration compact behind explicit disclosure actions", async () => {
    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));

    const rolesLabel = await waitFor(() => view.getByText("Roles & groups"));
    const rolesDetails = rolesLabel.closest("details") as HTMLDetailsElement;
    expect(rolesDetails.open).toBe(false);
    expect(rolesDetails.textContent).toContain("Effective role: Member · 1 group");
    expect(rolesDetails.textContent).toContain("Manage");

    const accountDetails = view.getByText("Account actions").closest("details") as HTMLDetailsElement;
    const dangerDetails = view.getByText("Danger zone").closest("details") as HTMLDetailsElement;
    expect(accountDetails.open).toBe(false);
    expect(dangerDetails.open).toBe(false);
  });

  test("federated row shows badge and disables account actions", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-fed")).toBeTruthy();
    });

    expect(view.getAllByTestId("user-status-federated").length).toBeGreaterThan(0);

    fireEvent.click(view.getByTestId("user-row-user-fed"));

    await waitFor(() => {
      expect(view.getByTestId("user-detail-panel")).toBeTruthy();
    });

    const disableBtn = view.getByRole("button", { name: "Disable" });
    expect((disableBtn as HTMLButtonElement).disabled).toBe(true);
    expect(disableBtn.getAttribute("title")).toBe(
      "Federated users are managed on their home server.",
    );

    const resetBtn = view.getByRole("button", { name: "Reset password" });
    expect((resetBtn as HTMLButtonElement).disabled).toBe(true);
    expect(resetBtn.getAttribute("title")).toBe(
      "Federated users are managed on their home server.",
    );
  });

  test("disable calls client.admin.users.disable for a local user", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    let disableBtn: HTMLElement | undefined;
    await waitFor(() => {
      disableBtn = view.getByRole("button", { name: "Disable" });
      expect(disableBtn).toBeTruthy();
    });

    fireEvent.click(disableBtn!);

    let confirmBtn: HTMLElement | undefined;
    await waitFor(() => {
      confirmBtn = view.getByRole("button", { name: "Confirm disable" });
      expect(confirmBtn).toBeTruthy();
    });

    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      expect(disableMock).toHaveBeenCalledWith("user-local", undefined);
    });
  });

  test("the explicit Add action adds the user to the admins group", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    let adminsToggle: HTMLButtonElement | undefined;
    await waitFor(() => {
      adminsToggle = view.getByTestId("group-toggle-admins") as HTMLButtonElement;
      expect(adminsToggle.disabled).toBe(false);
      expect(adminsToggle.textContent).toBe("Add");
      expect(adminsToggle.getAttribute("aria-label")).toBe("Add to Admins");
    });

    fireEvent.click(adminsToggle!);

    await waitFor(() => {
      expect(addGroupMemberMock).toHaveBeenCalledWith("g-admins", "user-local");
    });
  });

  test("the explicit Remove action removes the user from the members group", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    let membersToggle: HTMLButtonElement | undefined;
    await waitFor(() => {
      membersToggle = view.getByTestId("group-toggle-members") as HTMLButtonElement;
      expect(membersToggle.textContent).toBe("Remove");
      expect(membersToggle.getAttribute("aria-label")).toBe("Remove from Members");
    });

    fireEvent.click(membersToggle!);

    await waitFor(() => {
      expect(removeGroupMemberMock).toHaveBeenCalledWith("g-members", "user-local");
    });
  });

  test("warns when a membership change applied without an audit record", async () => {
    addGroupMemberMock.mockImplementationOnce(async () => ({ ok: true, auditRecorded: false }));
    const view = render(<UsersSection />);
    await waitFor(() => expect(view.getByTestId("user-row-user-local")).toBeTruthy());
    fireEvent.click(view.getByTestId("user-row-user-local"));
    await waitFor(() => expect(view.getByTestId("group-toggle-admins")).toBeTruthy());
    fireEvent.click(view.getByTestId("group-toggle-admins"));
    await waitFor(() => expect(view.getByTestId("membership-audit-warning").textContent).toContain("Do not retry"));
    expect(addGroupMemberMock).toHaveBeenCalledWith("g-admins", "user-local");
  });

  test("the owners toggle is owner-only (disabled without manage_server_settings)", async () => {
    mockRole = "admin";
    mockCaps = ["manage_members"];

    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    await waitFor(() => {
      const ownersToggle = view.getByTestId(
        "group-toggle-owners",
      ) as HTMLButtonElement;
      expect(ownersToggle.disabled).toBe(true);
      const adminsToggle = view.getByTestId(
        "group-toggle-admins",
      ) as HTMLButtonElement;
      expect(adminsToggle.disabled).toBe(false);
    });
  });

  test("an admin with manage_server_settings can use the owners toggle", async () => {
    mockRole = "admin";
    mockCaps = ["manage_members", "manage_server_settings"];

    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    let ownersToggle: HTMLButtonElement | undefined;
    await waitFor(() => {
      ownersToggle = view.getByTestId("group-toggle-owners") as HTMLButtonElement;
      expect(ownersToggle.disabled).toBe(false);
      expect(ownersToggle.textContent).toBe("Add");
    });

    fireEvent.click(ownersToggle!);

    await waitFor(() => {
      expect(addGroupMemberMock).toHaveBeenCalledWith("g-owners", "user-local");
    });
  });

  test("last_owner 409 on a membership change surfaces an error", async () => {
    removeGroupMemberMock.mockImplementationOnce(async () => {
      throw new LastOwnerError();
    });

    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    let membersToggle: HTMLButtonElement | undefined;
    await waitFor(() => {
      membersToggle = view.getByTestId("group-toggle-members") as HTMLButtonElement;
      expect(membersToggle.textContent).toBe("Remove");
    });

    fireEvent.click(membersToggle!);

    await waitFor(() => {
      const err = view.getByTestId("user-action-error");
      expect(err.textContent).toBe(LAST_OWNER_MESSAGE);
    });
  });

  test("federated user's group toggles are disabled", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-fed")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-fed"));

    await waitFor(() => {
      expect(view.getByTestId("user-detail-panel")).toBeTruthy();
    });

    // Federated membership is managed on the home server — no toggles rendered.
    expect(view.queryByTestId("group-toggle-admins")).toBeNull();
  });

  test("clicking the selected user again deselects it", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));
    await waitFor(() => {
      expect(view.getByTestId("user-detail-panel")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));
    await waitFor(() => {
      // D298 — detail now lives in a right-side drawer; deselecting closes it.
      expect(view.queryByTestId("user-detail-panel")).toBeNull();
    });
  });

  test("the last owner cannot be disabled (button guarded)", async () => {
    const ownerUser: AdminUserRow = {
      ...localUser,
      id: "user-owner",
      handle: "olivia",
      displayName: "Olivia Owner",
      groups: [
        { id: "g-owners", type: "owners", label: "Owners", roleSlug: "owner" },
      ],
    };
    listMock.mockImplementationOnce(async () => ({
      users: [ownerUser],
      nextCursor: null,
    }));
    getMock.mockImplementationOnce(async () => ownerUser);

    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-owner")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-owner"));

    await waitFor(() => {
      const disableBtn = view.getByRole("button", { name: "Disable" });
      expect((disableBtn as HTMLButtonElement).disabled).toBe(true);
      expect(disableBtn.getAttribute("title")).toBe(
        "Cannot disable the last server owner. Assign another owner first.",
      );
    });

    // Delete is likewise guarded for the last owner: no actionable delete
    // button, and a disabled "Delete account" affordance with the tooltip.
    expect(view.queryByTestId("delete-user-button")).toBeNull();
    const deleteGuard = view.getByRole("button", { name: "Delete account" });
    expect((deleteGuard as HTMLButtonElement).disabled).toBe(true);
    expect(deleteGuard.getAttribute("title")).toBe(
      "Cannot delete the last server owner. Assign another owner first.",
    );
  });

  test("delete is a two-step confirm, then calls admin.users.delete", async () => {
    const view = render(<UsersSection />);

    await waitFor(() => {
      expect(view.getByTestId("user-row-user-local")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("user-row-user-local"));

    // Step 1: the delete affordance is present; confirm is not yet shown.
    await waitFor(() => {
      expect(view.getByTestId("delete-user-button")).toBeTruthy();
    });
    expect(view.queryByTestId("confirm-delete-button")).toBeNull();
    expect(deleteUserMock).not.toHaveBeenCalled();

    // Step 2: reveal the confirm, then commit.
    fireEvent.click(view.getByTestId("delete-user-button"));
    const confirmBtn = await waitFor(() =>
      view.getByTestId("confirm-delete-button"),
    );
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteUserMock).toHaveBeenCalledWith("user-local");
    });
  });

  test("renders nothing actionable when manage_members is absent", () => {
    mockCaps = [];

    const view = render(<UsersSection />);

    expect(
      view.getByText("You don't have permission to manage server users."),
    ).toBeTruthy();
    expect(view.queryByTestId("users-directory")).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });
});
