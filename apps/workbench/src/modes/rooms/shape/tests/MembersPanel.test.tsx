/**
 * MembersPanel SSR smoke + role-gate variants.
 *
 * Covers SSR behavior plus focused interactive room-management flows. Broader
 * integration smoke coverage remains outside this unit suite.
 */
import { afterAll, beforeAll, beforeEach, describe, test, expect, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { RoomConductorMode, RoomMemberDto, RoomKind } from "@nautilo/types";
import { ProtectedRoomAccessContext } from "../../../../adapters/runtime-contexts";

let manageDetailMembers: RoomMemberDto[] = [];
let manageDetailKind: RoomKind = "group";
let manageDetailConductorMode: RoomConductorMode = "advanced";
const archiveRoom = mock(async () => ({ ok: true }));
let addableUsers: Array<{ userId: string; handle: string; displayName: string }> = [];
let addableAgents: Array<{
  agentId: string;
  handle: string;
  displayName: string;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
}> = [];
const failingMemberKeys = new Set<string>();
let protectHumanAdds = false;
const markMembershipPending = mock(() => undefined);
const addRoomMember = mock(
  async (
    _roomId: string,
    input:
      | { kind: "user"; userId: string; roomRole: "member" }
      | { kind: "agent"; agentId: string; roomRole: "member" },
  ) => {
    const actorId = input.kind === "user" ? input.userId : input.agentId;
    if (failingMemberKeys.has(`${input.kind}:${actorId}`)) throw new Error("Add failed");
    return {
      ok: true as const,
      actorId,
      kind: input.kind,
      ...(protectHumanAdds && input.kind === "user"
        ? {
            protectedEncryption: {
              status: "pending" as const,
              namespaceId: "38608e92-a31f-46af-ad5e-a847c8a6b300",
              accessRevision: 2,
            },
          }
        : {}),
    };
  },
);
const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

mock.module("../../../../lib/api", () => ({
  apiClient: {
    getTokenProvider: () => async () => null,
    getRoomManageDetail: async () => ({
      id: "r1",
      label: "Test room",
      kind: manageDetailKind,
      conductorMode: manageDetailConductorMode,
      members: manageDetailMembers,
    }),
    getRoomPresence: async () => ({ members: [] }),
    listAddableUsersForRoom: async () => addableUsers,
    listAddableAgentsForRoom: async () => addableAgents,
    addRoomMember,
    removeRoomMember: async () => ({ ok: true, kind: "user" }),
    updateRoomMemberMode: async () => ({ ok: true }),
    setRoomVisibility: async () => ({ ok: true }),
    setRoomConductorMode: async (_roomId: string, conductorMode: RoomConductorMode) => ({
      conductorMode,
    }),
    archiveRoom,
    unarchiveRoom: async () => ({ ok: true }),
    renameRoom: async () => ({ ok: true }),
  },
}));

mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: () => undefined, dismiss: () => undefined, _current: null }),
}));

mock.module("../use-room-focus", () => ({
  useRoomFocus: () => ({
    ring: { kind: "none" },
    isTarget: () => false,
    isHeld: () => false,
    isExpiringSoon: () => false,
    secondsLeft: () => null,
    remainingFraction: () => null,
    reasonFor: () => null,
    isBusy: () => false,
    toggle: () => undefined,
    refresh: async () => undefined,
  }),
}));

const { MembersPanel, filterAddMemberCandidates } = await import("../MembersPanel");

beforeAll(() => {
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }

  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
});

beforeEach(() => {
  addableUsers = [];
  addableAgents = [];
  failingMemberKeys.clear();
  protectHumanAdds = false;
  markMembershipPending.mockClear();
  addRoomMember.mockClear();
});

afterAll(async () => {
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
});

const human = (id: string, name: string, role: "admin" | "member"): RoomMemberDto => ({
  actorId: id,
  kind: "user",
  displayName: name,
  userId: id,
  roomRole: role,
});

const agent = (
  id: string,
  name: string,
  mode: "active" | "mention_only" | "observe" | null,
  role: "admin" | "member" = "member",
): RoomMemberDto => ({
  actorId: id,
  kind: "agent",
  displayName: name,
  agentId: id,
  roomRole: role,
  ...(mode != null ? { agentResponseMode: mode } : {}),
});

describe("MembersPanel — room management", () => {
  test("does not notify parent membership changes for initial open refresh", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    const onMembershipChanged = mock(() => undefined);

    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={true}
        onClose={() => undefined}
        onMembershipChanged={onMembershipChanged}
      />,
    );

    await waitFor(() => {
      expect(view.getByText("Members (1)")).toBeTruthy();
    });
    expect(onMembershipChanged).not.toHaveBeenCalled();
    view.unmount();
  });

  test("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={false}
        onClose={() => undefined}
      />,
    );
    expect(html).toBe("");
  });

  test("renders header with member count and lists members", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
          agent("a1", "Genie", "mention_only"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Members (3)");
    expect(html).toContain("Room Admin");
    expect(html).toContain("Maya");
    expect(html).toContain("Genie");
  });

  test("admin viewer sees Add member button", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("members-panel-add");
    expect(html).toContain("+ Add member");
  });

  test("add-member picker stays compact, fills its result area, and shows Genie owners", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    addableAgents = [
      {
        agentId: "a-mara",
        handle: "mara-helper",
        displayName: "Compass",
        agentOwnerUserId: "mara",
        agentOwnerHandle: "mara",
        agentOwnerDisplayName: "Mara Voss",
      },
      {
        agentId: "a-alice",
        handle: "alice-helper",
        displayName: "Beacon",
        agentOwnerUserId: "alice",
        agentOwnerHandle: "alice",
        agentOwnerDisplayName: "Alice Reed",
      },
    ];
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={manageDetailMembers}
        open={true}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(view.getByTestId("members-panel-add"));
    const surface = await view.findByTestId("add-member-picker-surface");
    expect(surface.className).toContain("h-[480px]");
    expect(surface.className).toContain("w-full");
    expect(surface.className).toContain("max-w-md");
    expect(view.getByRole("listbox").className).toContain("flex-1");
    expect(view.getByRole("listbox").className).not.toContain("max-h-48");
    await view.findByText((_, element) => element?.textContent === "Mara Voss’s Genie · @mara-helper");

    view.unmount();
  });

  test("add-member picker selects several candidates before one explicit commit", async () => {
    protectHumanAdds = true;
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    addableUsers = [
      { userId: "u2", handle: "inez", displayName: "Inez Calder" },
      { userId: "u3", handle: "rowan", displayName: "Rowan Vale" },
    ];
    addableAgents = [
      {
        agentId: "a1",
        handle: "cat",
        displayName: "Cat",
        agentOwnerDisplayName: "Inez Calder",
      },
    ];
    const onMembershipChanged = mock(() => undefined);
    const view = render(
      <ProtectedRoomAccessContext.Provider value={{
        stateForRoom: () => null,
        markMembershipPending,
      }}>
        <MembersPanel
          roomId="r1"
          viewerActorId="u1"
          initialMembers={manageDetailMembers}
          open={true}
          onClose={() => undefined}
          onMembershipChanged={onMembershipChanged}
        />
      </ProtectedRoomAccessContext.Provider>,
    );

    fireEvent.click(view.getByTestId("members-panel-add"));
    fireEvent.click(await view.findByRole("option", { name: /Human · @inez/ }));
    fireEvent.click(view.getByRole("option", { name: /Cat/ }));

    expect(addRoomMember).not.toHaveBeenCalled();
    expect(view.getAllByTestId("member-chip")).toHaveLength(2);
    expect(view.getByText("2 members selected")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Add 2 members" }));

    await waitFor(() => expect(addRoomMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.queryByTestId("add-member-picker")).toBeNull());
    expect(onMembershipChanged).toHaveBeenCalledTimes(1);
    expect(addRoomMember).toHaveBeenCalledWith("r1", {
      kind: "user",
      userId: "u2",
      roomRole: "member",
    });
    expect(addRoomMember).toHaveBeenCalledWith("r1", {
      kind: "agent",
      agentId: "a1",
      roomRole: "member",
    });
    expect(markMembershipPending).toHaveBeenCalledTimes(1);
    expect(markMembershipPending).toHaveBeenCalledWith(
      "r1",
      "38608e92-a31f-46af-ad5e-a847c8a6b300",
    );
    view.unmount();
  });

  test("partial add keeps failed candidates selected for an exact retry", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    addableUsers = [{ userId: "u2", handle: "inez", displayName: "Inez Calder" }];
    addableAgents = [
      {
        agentId: "a1",
        handle: "cat",
        displayName: "Cat",
        agentOwnerDisplayName: "Inez Calder",
      },
    ];
    failingMemberKeys.add("user:u2");
    const onMembershipChanged = mock(() => undefined);
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={manageDetailMembers}
        open={true}
        onClose={() => undefined}
        onMembershipChanged={onMembershipChanged}
      />,
    );

    fireEvent.click(view.getByTestId("members-panel-add"));
    fireEvent.click(await view.findByRole("option", { name: /Human · @inez/ }));
    fireEvent.click(view.getByRole("option", { name: /Cat/ }));
    fireEvent.click(view.getByRole("button", { name: "Add 2 members" }));

    expect(
      await view.findByText(
        "Added 1. Could not add 1 member. The failed selection is still here to retry.",
      ),
    ).toBeTruthy();
    expect(view.getByTestId("add-member-picker")).toBeTruthy();
    expect(view.getAllByTestId("member-chip")).toHaveLength(1);
    expect(view.getByTestId("member-chip").textContent).toContain("Inez Calder");
    expect(view.queryByRole("option", { name: /Cat/ })).toBeNull();
    expect(view.getByRole("button", { name: "Retry 1" })).toBeTruthy();
    expect(onMembershipChanged).toHaveBeenCalledTimes(1);

    failingMemberKeys.clear();
    fireEvent.click(view.getByRole("button", { name: "Retry 1" }));
    await waitFor(() => expect(view.queryByTestId("add-member-picker")).toBeNull());
    expect(addRoomMember).toHaveBeenCalledTimes(3);
    expect(onMembershipChanged).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("add-member search matches a Genie by owner name or handle", () => {
    const candidates = [
      {
        kind: "agent" as const,
        id: "a-mara",
        handle: "compass",
        displayName: "Compass",
        agentOwnerHandle: "mara",
        agentOwnerDisplayName: "Mara Voss",
      },
      {
        kind: "agent" as const,
        id: "a-alice",
        handle: "beacon",
        displayName: "Beacon",
        agentOwnerHandle: "alice",
        agentOwnerDisplayName: "Alice Reed",
      },
    ];

    expect(filterAddMemberCandidates(candidates, "Mara").map((c) => c.id)).toEqual(["a-mara"]);
    expect(filterAddMemberCandidates(candidates, "mara").map((c) => c.id)).toEqual(["a-mara"]);
  });

  test("non-admin viewer does NOT see Add member button", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u2"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain("members-panel-add");
  });

  test("admin viewer gets aligned action slots for removable members (not self)", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    const actionMatches = html.match(/data-testid="members-panel-member-actions"/g) ?? [];
    expect(actionMatches).toHaveLength(1);
    expect(html).toContain("Actions for Maya");
    expect(html).not.toContain("Actions for Room Admin");
    expect(html).not.toContain("members-panel-remove");
  });

  test("member action menu reveals an explicit remove action", async () => {
    manageDetailMembers = [
      human("u1", "Room Admin", "admin"),
      human("u2", "Maya", "member"),
    ];
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={manageDetailMembers}
        open={true}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await view.findByLabelText("Actions for Maya"));
    expect(view.getByLabelText("Remove Maya")).toBeTruthy();
    view.unmount();
  });

  test("member action menus are exclusive and dismiss on an outside press", async () => {
    manageDetailMembers = [
      human("u1", "Room Admin", "admin"),
      human("u2", "Maya", "member"),
      human("u3", "Zara", "member"),
    ];
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={manageDetailMembers}
        open={true}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await view.findByLabelText("Actions for Maya"));
    expect(view.getByLabelText("Remove Maya")).toBeTruthy();

    fireEvent.click(view.getByLabelText("Actions for Zara"));
    expect(view.queryByLabelText("Remove Maya")).toBeNull();
    expect(view.getByLabelText("Remove Zara")).toBeTruthy();

    fireEvent.pointerDown(view.getByLabelText("Room name"));
    expect(view.queryByLabelText("Remove Zara")).toBeNull();
    view.unmount();
  });

  test("archive moved to room actions and requires confirmation", async () => {
    archiveRoom.mockClear();
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={manageDetailMembers}
        open={true}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await view.findByLabelText("Room actions"));
    fireEvent.click(view.getByText("Archive room…"));
    expect(view.getByText("It will disappear from active rooms for everyone. You can restore it later from the Archived rooms panel.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Archive room" }));
    await waitFor(() => expect(archiveRoom).toHaveBeenCalledWith("r1"));
    view.unmount();
  });

  test("non-admin viewer sees no Remove buttons", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u2"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain("members-panel-remove");
  });

  test("admins see an aligned response-mode select on agent rows", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
          agent("a1", "Genie", "mention_only"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    const selectMatches = html.match(/data-testid="members-panel-mode-select"/g) ?? [];
    expect(selectMatches).toHaveLength(1);
    expect(html).toContain("Response mode for Genie");
  });

  test("non-admin does NOT see response-mode controls (Q4 admin-gating)", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u2"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
          agent("a1", "Genie", "mention_only"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain("members-panel-mode-select");
  });

  test("agent row shows non-active mode in meta line", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          agent("a1", "Genie", "observe"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("observe-only");
  });

  test("admins are sorted before members; alpha within each role", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u3", "Zara", "member"),
          human("u1", "Bob", "admin"),
          human("u2", "Alpha Admin", "admin"),
          human("u4", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    // Admin Alpha comes before admin Bob comes before member Maya comes before member Zara
    const alphaIdx = html.indexOf("Alpha Admin");
    const bobIdx = html.indexOf("Bob");
    const mayaIdx = html.indexOf("Maya");
    const zaraIdx = html.indexOf("Zara");
    expect(alphaIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(mayaIdx);
    expect(mayaIdx).toBeLessThan(zaraIdx);
  });

  test('shows "(you)" suffix on viewer row', () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Maya", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("(you)");
  });

  test("renders empty state when no members yet", () => {
    const html = renderToStaticMarkup(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[]}
        open={true}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("No members yet");
  });

  test("manage_rooms viewer on group room sees visibility radio controls", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    manageDetailKind = "group";
    manageDetailConductorMode = "advanced";
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={true}
        onClose={() => undefined}
        viewerCanManageRooms={true}
      />,
    );
    await waitFor(() => {
      expect(view.getByTestId("visibility-radio-private")).toBeTruthy();
      expect(view.getByTestId("visibility-radio-public")).toBeTruthy();
    });
    view.unmount();
  });

  test("room admin on group room sees smart routing controls", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    manageDetailKind = "group";
    manageDetailConductorMode = "standard";
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={true}
        onClose={() => undefined}
        viewerCanManageRooms={true}
      />,
    );
    await waitFor(() => {
      expect(view.getByTestId("conductor-mode-radio-advanced")).toBeTruthy();
      expect(view.getByTestId("conductor-mode-radio-standard")).toBeTruthy();
    });
    view.unmount();
  });

  test("viewer without manage_rooms sees read-only visibility", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    manageDetailKind = "group";
    manageDetailConductorMode = "advanced";
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={true}
        onClose={() => undefined}
        viewerCanManageRooms={false}
      />,
    );
    await waitFor(() => {
      expect(view.getByTestId("members-panel-visibility").textContent).toContain("Private");
    });
    expect(view.container.querySelector('[data-testid="visibility-radio-public"]')).toBeNull();
    view.unmount();
  });

  test("non-admin viewer does NOT see smart routing controls", async () => {
    manageDetailMembers = [
      human("u1", "Room Admin", "admin"),
      human("u2", "Member", "member"),
    ];
    manageDetailKind = "group";
    manageDetailConductorMode = "advanced";
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u2"
        initialMembers={[
          human("u1", "Room Admin", "admin"),
          human("u2", "Member", "member"),
        ]}
        open={true}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(view.getByTestId("members-panel-conductor-mode").textContent).toContain("On");
    });
    expect(view.container.querySelector('[data-testid="conductor-mode-radio-advanced"]')).toBeNull();
    view.unmount();
  });

  test("non open/group kind renders read-only visibility even with manage_rooms", async () => {
    manageDetailMembers = [human("u1", "Room Admin", "admin")];
    manageDetailKind = "private";
    manageDetailConductorMode = "advanced";
    const view = render(
      <MembersPanel
        roomId="r1"
        viewerActorId="u1"
        initialMembers={[human("u1", "Room Admin", "admin")]}
        open={true}
        onClose={() => undefined}
        viewerCanManageRooms={true}
      />,
    );
    await waitFor(() => {
      expect(view.getByTestId("members-panel-visibility").textContent).toContain("Private");
    });
    expect(view.container.querySelector('[data-testid="visibility-radio-public"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="members-panel-conductor-mode"]')).toBeNull();
    view.unmount();
  });
});
