/**
 * M106 — Members settings section smoke.
 * M273 — freshly-created invites present the server-issued code and URL.
 */
import "../bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realUseCan = await import("../../src/hooks/use-can");

const inviteResult = {
  id: "00000000-0000-4000-8000-000000000273",
  url: "https://community.example/redeem/inv_m273_exact",
  token: "inv_m273_exact",
  kind: "server" as const,
  expiresAt: null,
  maxUses: 1,
  mutation: {
    stateChanged: true as const,
    auditRecorded: true as const,
    retrySafe: false,
    receiptId: "00000000-0000-4000-8000-000000000273",
    recovery: [],
  },
};

const inviteRow = {
  id: inviteResult.id,
  kind: "server" as const,
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  displayName: null,
  targetRoomId: "00000000-0000-4000-8000-000000000001",
  targetRoomLabel: "Community",
  targetRoleSlug: "guest",
};

let inviteRows: Array<typeof inviteRow> = [];
const listInvites = mock(async () => ({
  invites: inviteRows,
  page: { hasMore: false, nextCursor: null },
}));
const listInvitableRooms = mock(async () => []);
const createInvite = mock(async () => {
  inviteRows = [inviteRow];
  return inviteResult;
});
const revokeInvite = mock(async () => ({ ok: true as const }));
const writeText = mock(async (_value: string) => {});

mock.module("../../src/lib/api", () => ({
  apiClient: {
    listInvites,
    listInvitableRooms,
    createInvite,
    revokeInvite,
  },
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "create_invites",
}));

const { InvitePeopleSection } = await import(
  "../../src/pages/settings/sections/members-section"
);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  inviteRows = [];
  listInvites.mockClear();
  listInvitableRooms.mockClear();
  createInvite.mockClear();
  revokeInvite.mockClear();
  writeText.mockClear();
  writeText.mockImplementation(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterAll(() => {
  cleanup();
  mock.module("../../src/hooks/use-can", () => realUseCan);
});

async function createFreshInvite() {
  const view = render(<InvitePeopleSection />);
  await view.findByRole("button", { name: "New invite" });
  fireEvent.click(view.getByRole("button", { name: "New invite" }));
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

  test("shows Community as unavailable for enrollment", async () => {
    const view = render(<InvitePeopleSection />);
    fireEvent.click(await view.findByRole("button", { name: "New invite" }));

    const option = view.getByRole("option", {
      name: "Community — unavailable until personal-key chat launches",
    }) as HTMLOptionElement;
    expect(option.disabled).toBeTrue();
  });

  test("shows one create response's exact code and server-issued URL", async () => {
    const view = await createFreshInvite();

    expect(createInvite).toHaveBeenCalledTimes(1);
    expect((view.getByLabelText("Invite code") as HTMLInputElement).value).toBe(
      inviteResult.token,
    );
    expect((view.getByLabelText("Invite URL") as HTMLInputElement).value).toBe(
      inviteResult.url,
    );
    expect(view.getByText(/won't be shown again/i)).toBeTruthy();
  });

  test("copies code and URL independently", async () => {
    const view = await createFreshInvite();

    fireEvent.click(view.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(inviteResult.url));
    expect(view.getByRole("button", { name: "URL copied" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy code" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(inviteResult.token));
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  test("gives manual-copy recovery when clipboard access fails", async () => {
    writeText.mockImplementation(async () => {
      throw new Error("clipboard unavailable");
    });
    const view = await createFreshInvite();

    fireEvent.click(view.getByRole("button", { name: "Copy URL" }));

    expect(
      await view.findByText(
        "Could not copy the invite URL. Select it and copy it manually.",
      ),
    ).toBeTruthy();
    expect((view.getByLabelText("Invite URL") as HTMLInputElement).value).toBe(
      inviteResult.url,
    );
  });

  test("does not reconstruct invite URLs in the client", () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        "../../src/pages/settings/sections/members-section.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("url: res.url");
    expect(source).not.toContain("rebuildInviteUrlFromToken");
    expect(source).not.toContain("window.location.origin");
  });
});
