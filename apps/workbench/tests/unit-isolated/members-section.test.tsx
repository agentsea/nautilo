import "../bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InviteShareApiError } from "@nautilo/api-client/browser";

const realUseCan = await import("../../src/hooks/use-can");

const inviteResult = {
  id: "00000000-0000-4000-8000-000000000273",
  url: "https://community.example/redeem/inv_m273_exact",
  token: "inv_m273_exact",
  kind: "server" as const,
  expiresAt: null,
  maxUses: 1,
  mutation: { stateChanged: true as const, auditRecorded: true as const, retrySafe: false, receiptId: "receipt", recovery: [] },
};

const inviteRow = {
  id: inviteResult.id,
  kind: "server" as const,
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  displayName: "Community welcome",
  targetRoomId: "00000000-0000-4000-8000-000000000001",
  targetRoomLabel: "Community",
  targetRoleSlug: "guest",
  codeAvailable: true,
};

let inviteRows: Array<typeof inviteRow> = [];
let grantedCapabilities = new Set(["create_invites"]);
let publicJoinSelection = { inviteId: null as string | null, revision: 0, joinUrl: "https://community.example/join" };

const listInvites = mock(async () => ({ invites: inviteRows, page: { hasMore: false, nextCursor: null } }));
const listInvitableRooms = mock(async () => []);
const createInvite = mock(async () => { inviteRows = [inviteRow]; return inviteResult; });
const getInviteShare = mock(async () => ({ code: inviteResult.token, url: inviteResult.url }));
const revokeInvite = mock(async (id: string) => {
  inviteRows = inviteRows.filter((invite) => invite.id !== id);
  if (publicJoinSelection.inviteId === id) {
    publicJoinSelection = { ...publicJoinSelection, inviteId: null, revision: publicJoinSelection.revision + 1 };
  }
  return { ok: true as const };
});
const getPublicJoinSelection = mock(async () => publicJoinSelection);
const updatePublicJoinSelection = mock(async (input: { inviteId: string | null; revision: number }) => {
  publicJoinSelection = { inviteId: input.inviteId, revision: input.revision + 1, joinUrl: "https://community.example/join" };
  return publicJoinSelection;
});
const writeText = mock(async (_value: string) => {});

mock.module("../../src/lib/api", () => ({
  apiClient: { listInvites, listInvitableRooms, createInvite, getInviteShare, revokeInvite, getPublicJoinSelection, updatePublicJoinSelection },
}));
mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => grantedCapabilities.has(capability),
}));

const { InviteManagement, InvitePeopleSection } = await import("../../src/pages/settings/sections/members-section");

beforeEach(() => {
  cleanup();
  localStorage.clear();
  inviteRows = [];
  grantedCapabilities = new Set(["create_invites"]);
  publicJoinSelection = { inviteId: null, revision: 0, joinUrl: "https://community.example/join" };
  for (const fn of [listInvites, listInvitableRooms, createInvite, getInviteShare, revokeInvite, getPublicJoinSelection, updatePublicJoinSelection, writeText]) fn.mockClear();
  writeText.mockImplementation(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(window, "confirm", { configurable: true, value: () => true });
});

afterAll(() => {
  cleanup();
  mock.module("../../src/hooks/use-can", () => realUseCan);
});

async function createFreshInvite() {
  const view = render(<InvitePeopleSection />);
  fireEvent.click(await view.findByRole("button", { name: "New invite" }));
  fireEvent.click(await view.findByRole("button", { name: "Create invite" }));
  await waitFor(() => {
    expect(view.getByDisplayValue(inviteResult.token)).toBeTruthy();
    expect(view.getByDisplayValue(inviteResult.url)).toBeTruthy();
  });
  return view;
}

describe("MembersSection invite presentation", () => {
  test("renders the existing invite entry point", async () => {
    const view = render(<InvitePeopleSection />);
    expect(await view.findByText("Invite people")).toBeTruthy();
    expect(view.getByRole("button", { name: "New invite" })).toBeTruthy();
  });

  test("creates a Community invitation through the normal role selector", async () => {
    const view = render(<InvitePeopleSection />);
    fireEvent.click(await view.findByRole("button", { name: "New invite" }));
    fireEvent.change(view.getByLabelText("Server Group role"), { target: { value: "community" } });
    fireEvent.click(view.getByRole("button", { name: "Create invite" }));
    await waitFor(() => expect(createInvite).toHaveBeenCalledWith(expect.objectContaining({ targetGroupRoleSlug: "community" })));
  });

  test("shows the create response without changing legacy browser storage", async () => {
    localStorage.setItem("nautilo.inviteCodes.v1", JSON.stringify({ stale: "inv_stale" }));
    localStorage.setItem("nautilo.inviteUrls.v1", JSON.stringify({ stale: "https://old.example/redeem/inv_stale" }));
    const before = { ...localStorage };
    const view = await createFreshInvite();
    expect((view.getByLabelText("Invite code") as HTMLInputElement).value).toBe(inviteResult.token);
    expect((view.getByLabelText("Invite URL") as HTMLInputElement).value).toBe(inviteResult.url);
    expect({ ...localStorage }).toEqual(before);
  });

  test("loads the share from the server after reload and supports repeat copy", async () => {
    inviteRows = [inviteRow];
    const view = render(<InvitePeopleSection />);
    fireEvent.click(await view.findByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(inviteResult.token));
    expect(getInviteShare).toHaveBeenCalledWith(inviteRow.id);
    fireEvent.click(view.getByRole("button", { name: /code copied|copy code/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(inviteResult.url));
    expect(getInviteShare).toHaveBeenCalledTimes(3);
  });

  test("gives manual-copy recovery when clipboard access fails", async () => {
    inviteRows = [inviteRow];
    writeText.mockImplementation(async () => { throw new Error("clipboard unavailable"); });
    const view = render(<InvitePeopleSection />);
    fireEvent.click(await view.findByRole("button", { name: "Copy URL" }));
    expect(await view.findByText("Could not copy the invite URL. Select it and copy it manually.")).toBeTruthy();
    expect((view.getByLabelText("Invite URL") as HTMLInputElement).value).toBe(inviteResult.url);
  });

  test("explains that an older unavailable code needs a replacement", async () => {
    inviteRows = [{ ...inviteRow, codeAvailable: false }];
    const view = render(<InvitePeopleSection />);
    expect(await view.findByText(/older invite's code cannot be recovered/i)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Copy code" })).toBeNull();
    expect(view.queryByRole("button", { name: "Copy URL" })).toBeNull();
  });

  test("handles a share becoming unavailable between list and copy", async () => {
    inviteRows = [inviteRow];
    getInviteShare.mockImplementationOnce(async () => {
      throw new InviteShareApiError(409, "invite_code_unavailable");
    });
    const view = render(<InvitePeopleSection />);
    fireEvent.click(await view.findByRole("button", { name: "Copy code" }));
    expect(await view.findByText(/older invite's code cannot be recovered/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  test("does not retain invite codes or reconstruct URLs in the client", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/pages/settings/sections/members-section.tsx"), "utf8");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("nautilo.inviteCodes");
    expect(source).not.toContain("nautilo.inviteUrls");
    expect(source).not.toContain("window.location.origin");
    expect(source).toContain("getInviteShare");
  });

  test("lets a doubly-authorized admin repeatedly select and clear the canonical /join invite", async () => {
    grantedCapabilities = new Set(["manage_members", "manage_server_enrollment"]);
    inviteRows = [{ ...inviteRow, targetRoleSlug: "community" }];
    const view = render(<InviteManagement adminSurface />);
    expect(await view.findByRole("link", { name: publicJoinSelection.joinUrl })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use for /join" }));
    await waitFor(() => expect(updatePublicJoinSelection).toHaveBeenCalledWith({ inviteId: inviteRow.id, revision: 0 }));
    expect(await view.findAllByText("Selected for /join")).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Clear /join" }));
    await waitFor(() => expect(updatePublicJoinSelection).toHaveBeenLastCalledWith({ inviteId: null, revision: 1 }));
    fireEvent.click(view.getByRole("button", { name: "Use for /join" }));
    await waitFor(() => expect(updatePublicJoinSelection).toHaveBeenLastCalledWith({ inviteId: inviteRow.id, revision: 2 }));
  });

  test("does not expose the /join selector without both capabilities", async () => {
    grantedCapabilities = new Set(["manage_members"]);
    inviteRows = [inviteRow];
    const view = render(<InviteManagement adminSurface />);
    await view.findByText("Community welcome");
    expect(view.queryByText("Public /join invite")).toBeNull();
    expect(getPublicJoinSelection).not.toHaveBeenCalled();
  });

  test("refreshes a revoked selected invite to /join unavailable without fallback", async () => {
    grantedCapabilities = new Set(["manage_members", "manage_server_enrollment"]);
    inviteRows = [inviteRow];
    publicJoinSelection = { ...publicJoinSelection, inviteId: inviteRow.id, revision: 4 };
    const view = render(<InviteManagement adminSurface />);
    await view.findAllByText("Selected for /join");
    fireEvent.click(view.getByRole("button", { name: "Revoke" }));
    expect(await view.findByText("The public join address is unavailable until you select an invite.")).toBeTruthy();
    expect(updatePublicJoinSelection).not.toHaveBeenCalled();
  });
});
