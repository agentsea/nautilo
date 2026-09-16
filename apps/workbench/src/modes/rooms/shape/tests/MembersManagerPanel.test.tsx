/**
 * D279 — silence controls in the docked §4.7.4 MembersManagerPanel (full view).
 */
import { afterAll, beforeAll, describe, test, expect, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Window } from "happy-dom";
import type { RoomConductorMode, RoomMemberDto } from "@nautilo/types";
import { EXPLORER_ROOM_MANAGE_EVENT } from "../../explorer/sections/shared/ExplorerRow";

let roomSilenceCanManage = true;
let roomSilenceCurrent:
  | {
      id: string;
      kind: "mute" | "deaf";
      botActorId: string | null;
      botDisplayName: string | null;
      setByDisplayName: string;
      expiresAt: string;
    }
  | null = null;
const setRoomSilence = mock(async () => ({ silence: null, canManage: true }));
const clearRoomSilence = mock(async () => ({ silence: null, canManage: true }));
const setRoomConductorMode = mock(
  async (_roomId: string, conductorMode: RoomConductorMode) => ({ conductorMode }),
);
const avatarFetch = mock(async () => new Response(new Blob(["avatar"], { type: "image/png" })));
const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

mock.module("../../../../lib/api", () => ({
  apiClient: {
    getRoomSilence: async () => ({
      silence: roomSilenceCurrent,
      canManage: roomSilenceCanManage,
    }),
    setRoomSilence,
    clearRoomSilence,
    setRoomConductorMode,
    updateRoomMemberMode: async () => ({ ok: true }),
    getTokenProvider: () => async () => "test-token",
    getToken: () => "test-token",
  },
}));

mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: () => undefined, dismiss: () => undefined, _current: null }),
}));

mock.module("../../../../hooks/use-profile", () => ({
  useProfile: () => ({ response: null }),
}));

mock.module("../../../../adapters/runtime-contexts", () => ({
  useVoiceControls: () => ({
    enabled: false,
    toggle: () => undefined,
    isBusy: false,
  }),
  useRunningSubagents: () => ({
    list: [],
    heartbeat: { count: 0, line: "" },
  }),
}));

mock.module("../../../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({
    setActiveRoom: () => undefined,
    activeRoomId: null,
    activeRoom: null,
  }),
}));

mock.module("../../../../contexts/task-state/task-state-context", () => ({
  useTaskState: () => ({
    busyIds: new Set<string>(),
    pauseTask: () => undefined,
    unpauseTask: () => undefined,
    stopTask: () => undefined,
  }),
}));

const { MembersManagerPanel } = await import("../MembersManagerPanel");

beforeAll(() => {
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "CustomEvent",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }

  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    CustomEvent: happyWindow.CustomEvent,
    fetch: avatarFetch,
  });
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
  agentOwnerUserId: "u2",
  agentOwnerDisplayName: "Maya",
  agentAvatar: { kind: "uploaded", blobId: `${id}-avatar` },
  roomRole: role,
  ...(mode != null ? { agentResponseMode: mode } : {}),
});

const groupWithBots = [
  human("u1", "Room Admin", "admin"),
  human("u2", "Maya", "member"),
  agent("a1", "Genie", "mention_only"),
];
const humanOnlyRoom = [
  human("u1", "Room Admin", "admin"),
  human("u2", "Maya", "member"),
  human("u3", "Alex", "member"),
];
const searchableRoom = [
  human("u1", "Room Admin", "admin"),
  human("u2", "Maya", "member"),
  {
    ...agent("a1", "Nova", "active"),
    handle: "nova",
    agentOwnerDisplayName: "Maya",
    agentOwnerHandle: "maya",
  },
  {
    ...agent("a2", "Atlas", "active"),
    handle: "atlas",
    agentOwnerDisplayName: "Casey",
    agentOwnerHandle: "casey",
  },
] satisfies readonly RoomMemberDto[];

const TEST_ROOM_LABEL = "Strategy Room";

function dispatchRouting(state: "deciding" | "settled", roomId = "r1", userActorId = "u1"): void {
  window.dispatchEvent(
    new CustomEvent("nautilo:conductor-routing", {
      detail: { roomId, userActorId, state },
    }),
  );
}

describe("MembersManagerPanel — D279 silence section", () => {
  test("human-only full view keeps members and Manage but hides conductor chrome", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r-human"
        roomLabel="Humans"
        members={humanOnlyRoom}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-manage")).toBeTruthy();
    });
    expect(view.getByText("Members 3")).toBeTruthy();
    expect(view.getByText("Maya")).toBeTruthy();
    expect(view.getByText("Alex")).toBeTruthy();
    expect(view.queryByTestId("members-manager-conductor-mode")).toBeNull();
    expect(view.queryByTestId("members-manager-routing-status")).toBeNull();
    expect(view.queryByTestId("members-panel-silence")).toBeNull();
    await waitFor(() => {
      expect(view.container.querySelector('img[alt="Maya"]')).not.toBeNull();
      expect(view.container.querySelector('img[alt="Alex"]')).not.toBeNull();
    });
    expect(avatarFetch.mock.calls.some(([url]) => url === "/api/users/u2/avatar")).toBe(true);
    expect(avatarFetch.mock.calls.some(([url]) => url === "/api/users/u3/avatar")).toBe(true);
    view.unmount();
  });

  test("human-only rail omits the conductor status badge", async () => {
    const view = render(
      <MembersManagerPanel
        roomId="r-human"
        roomLabel="Humans"
        members={humanOnlyRoom}
        conductorMode="advanced"
        viewerActorId="u1"
        view="rail"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-manager-panel")).toBeTruthy();
    });
    expect(view.queryByTestId("members-rail-conductor-mode")).toBeNull();
    view.unmount();
  });

  test("shows silence controls for manager in group-with-bots (full view)", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-silence")).toBeTruthy();
    });
    expect(view.getByTestId("panel-silence-mute")).toBeTruthy();
    expect(view.getByTestId("panel-silence-deaf")).toBeTruthy();
    expect(view.getByTestId("panel-silence-duration")).toBeTruthy();
    expect(view.getByText("Bot silence")).toBeTruthy();
    expect(view.getByTestId("members-manager-routing-status").textContent).toContain("idle");
    expect(view.getByText("Mute")).toBeTruthy();
    expect(view.getByText("Deafen")).toBeTruthy();
    expect(view.getByText("Mute = quiet. Deafen = bots miss messages.")).toBeTruthy();
    expect(view.getByText("Maya's agent")).toBeTruthy();
    await waitFor(() => {
      expect(view.container.querySelector('img[alt="Genie"]')).not.toBeNull();
    });
    expect(avatarFetch.mock.calls.at(-1)?.[0]).toBe("/api/rooms/r1/agents/a1/avatar?v=a1-avatar");
    expect((avatarFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers).toEqual({
      Authorization: "Bearer test-token",
    });
    view.unmount();
  });

  test("clicking Mute calls apiClient.setRoomSilence", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;
    setRoomSilence.mockClear();
    clearRoomSilence.mockClear();

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("panel-silence-mute")).toBeTruthy();
    });
    view.getByTestId("panel-silence-mute").click();

    await waitFor(() => {
      expect(setRoomSilence).toHaveBeenCalledWith("r1", {
        kind: "mute",
        durationMs: 30 * 60 * 1000,
      });
    });
    expect(clearRoomSilence).not.toHaveBeenCalled();
    view.unmount();
  });

  test("clicking active Muted state clears the silence window", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = {
      id: "silence-1",
      kind: "mute",
      botActorId: null,
      botDisplayName: null,
      setByDisplayName: "Room Admin",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    setRoomSilence.mockClear();
    clearRoomSilence.mockClear();

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("panel-silence-mute").textContent ?? "").toContain("Muted");
    });
    view.getByTestId("panel-silence-mute").click();

    await waitFor(() => {
      expect(clearRoomSilence).toHaveBeenCalledWith("r1");
    });
    expect(setRoomSilence).not.toHaveBeenCalled();
    roomSilenceCurrent = null;
    view.unmount();
  });

  test("hides silence section in rail view (NO-OP guard)", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="standard"
        viewerActorId="u1"
        view="rail"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-manager-panel")).toBeTruthy();
    });
    expect(view.queryByTestId("members-panel-silence")).toBeNull();
    expect(view.getByTestId("members-rail-conductor-mode").textContent).toContain("Off");
    view.unmount();
  });

  test("shows routing status under Smart routing while conductor is deciding", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );
    dispatchRouting("deciding");

    await waitFor(() => {
      expect(view.getByTestId("members-manager-routing-status").textContent).toContain(
        "deciding",
      );
    });
    view.unmount();
  });

  test("rail mode uses compact routing badge while conductor is deciding", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="rail"
        onSetView={() => undefined}
      />,
    );
    dispatchRouting("deciding");

    await waitFor(() => {
      expect(view.getByTestId("members-rail-conductor-mode").textContent).toContain("R");
    });
    view.unmount();
  });

  test("manager can flip smart routing from the full panel", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;
    setRoomConductorMode.mockClear();

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="standard"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-manager-conductor-mode")).toBeTruthy();
    });
    view.getByTestId("manager-conductor-advanced").click();

    await waitFor(() => {
      expect(setRoomConductorMode).toHaveBeenCalledWith("r1", "advanced");
    });
    view.unmount();
  });

  test("hides silence section for non-manager (NO-OP guard)", async () => {
    roomSilenceCanManage = false;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u2"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-manager-panel")).toBeTruthy();
    });
    expect(view.queryByTestId("members-panel-silence")).toBeNull();
    view.unmount();
  });
});

describe("MembersManagerPanel — D317 header", () => {
  test("full view shows room label as header title", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByText(TEST_ROOM_LABEL)).toBeTruthy();
    });
    expect(view.getByText(`Members ${groupWithBots.length}`)).toBeTruthy();
    view.unmount();
  });

  test("manage button dispatches explorer room manage event with members focus", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;
    const listener = mock((_event: Event) => undefined);
    window.addEventListener(EXPLORER_ROOM_MANAGE_EVENT, listener);

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-manage")).toBeTruthy();
    });
    view.getByTestId("members-panel-manage").click();

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]![0] as CustomEvent<{
      roomId: string;
      label: string;
      focus: string;
    }>;
    expect(event.type).toBe("nautilo:explorer-room-manage");
    expect(event.detail).toEqual({
      roomId: "r1",
      label: TEST_ROOM_LABEL,
      focus: "members",
    });

    window.removeEventListener(EXPLORER_ROOM_MANAGE_EVENT, listener);
    view.unmount();
  });

  test("rail view omits room title and manage button", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="standard"
        viewerActorId="u1"
        view="rail"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-manager-panel")).toBeTruthy();
    });
    expect(view.queryByText(TEST_ROOM_LABEL)).toBeNull();
    expect(view.queryByTestId("members-panel-manage")).toBeNull();
    view.unmount();
  });
});

describe("MembersManagerPanel — roster controls", () => {
  test("searches visible member identity case-insensitively, including agent owner cues", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r-search"
        roomLabel={TEST_ROOM_LABEL}
        members={searchableRoom}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-search")).toBeTruthy();
    });
    const user = userEvent.setup({ document: happyWindow.document });
    await user.type(view.getByTestId("members-panel-search"), "cAsEy");

    await waitFor(() => {
      expect(view.getByTestId("agent-card").getAttribute("data-actor-id")).toBe("a2");
      expect(view.queryByTestId("member-card")).toBeNull();
      expect(view.getByText("Casey's agent")).toBeTruthy();
    });
    view.unmount();
  });

  test("agents-only filter preserves the roster's existing sorted order", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r-search"
        roomLabel={TEST_ROOM_LABEL}
        members={searchableRoom}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-agents-only")).toBeTruthy();
    });
    fireEvent.click(view.getByTestId("members-panel-agents-only"));

    await waitFor(() => {
      expect(view.getByTestId("members-panel-agents-only").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(view.queryByTestId("member-card")).toBeNull();
      expect(
        view
          .getAllByTestId("agent-card")
          .map((card) => card.getAttribute("data-actor-id")),
      ).toEqual(["a2", "a1"]);
    });
    view.unmount();
  });

  test("full view keeps shell controls fixed and makes only the roster scrollable", async () => {
    roomSilenceCanManage = true;
    roomSilenceCurrent = null;

    const view = render(
      <MembersManagerPanel
        roomId="r1"
        roomLabel={TEST_ROOM_LABEL}
        members={groupWithBots}
        conductorMode="advanced"
        viewerActorId="u1"
        view="full"
        onSetView={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("members-panel-roster")).toBeTruthy();
    });
    const panel = view.getByTestId("members-manager-panel");
    const roster = view.getByTestId("members-panel-roster");
    const controls = view.getByTestId("members-panel-roster-controls");

    expect(panel.className).toContain("overflow-hidden");
    expect(panel.className).not.toContain("overflow-y-auto");
    expect(roster.className).toContain("overflow-y-auto");
    expect(roster.contains(controls)).toBe(false);
    expect(roster.contains(view.getByText(TEST_ROOM_LABEL))).toBe(false);
    expect(roster.contains(view.getByTestId("members-manager-conductor-mode"))).toBe(false);
    expect(roster.contains(view.getByTestId("members-panel-silence"))).toBe(false);
    view.unmount();
  });
});
