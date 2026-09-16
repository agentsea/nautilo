/**
 * D246 mixed-deployment compatibility — explorer roster fallback behavior.
 *
 * Proves `useExplorerData` keeps the zero-N+1 fast path when every room
 * summary carries a roster array, and hydrates ONLY missing rosters via
 * `GET /api/rooms/:id` when an old server omits the optional field.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { RoomMemberDto } from "@nautilo/types";
import type { WorkbenchRoomSummary } from "../../../../rooms/room-navigation-types";

const VIEWER = "actor-viewer";
const AGENT_G = "actor-genie";
const AGENT_G_ID = "agent-genie-id";

interface Deferred {
  resolve: (detail: { members: RoomMemberDto[]; conductorMode: "advanced" | "standard" }) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, Deferred>();
const allPending = new Map<string, Deferred[]>();
const getRoomCalls: string[] = [];

mock.module("../../../../lib/api", () => ({
  apiClient: {
    getRoom: (roomId: string) => {
      getRoomCalls.push(roomId);
      return new Promise<{ members: RoomMemberDto[]; conductorMode: "advanced" | "standard" }>(
        (resolve, reject) => {
          const deferred = {
            resolve: resolve as Deferred["resolve"],
            reject,
          };
          pending.set(roomId, deferred);
          allPending.set(roomId, [...(allPending.get(roomId) ?? []), deferred]);
        },
      );
    },
  },
}));

let navState: {
  rooms: WorkbenchRoomSummary[];
  activeRoomId: string | null;
  status: "guest" | "loading" | "ready" | "error";
  roomListError: string | null;
  setActiveRoom: (id: string) => void;
  refreshRooms: () => Promise<void>;
};

mock.module("../../../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => navState,
}));
mock.module("../../../../notifications/notification-state-context", () => ({
  useNotificationState: () => ({ snapshot: null }),
}));

let viewerActorId = VIEWER;
let viewerGeneration = 1;
let isVerified = true;

mock.module("../../../../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      sessionActorId: viewerActorId,
      isVerified,
    },
    viewerGeneration,
  }),
}));

mock.module("../../../../hooks/use-profile", () => ({
  useProfile: () => ({
    response: {
      ownedAgents: [{ agentId: AGENT_G_ID, displayName: "Genie" }],
    },
  }),
}));

const { useExplorerData, resetExplorerRosterFallbackForTests } = await import("../use-explorer-data");

const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

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

beforeEach(() => {
  resetExplorerRosterFallbackForTests();
  pending.clear();
  allPending.clear();
  getRoomCalls.length = 0;
  viewerActorId = VIEWER;
  viewerGeneration = 1;
  isVerified = true;
  navState = {
    rooms: [],
    activeRoomId: null,
    status: "ready",
    roomListError: null,
    setActiveRoom: () => {},
    refreshRooms: async () => {},
  };
});

function mkRoom(
  partial: Partial<WorkbenchRoomSummary> & Pick<WorkbenchRoomSummary, "id" | "label">,
): WorkbenchRoomSummary {
  return {
    type: "private",
    graphThreadId: `room:${partial.id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 2,
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    unreadCount: 0,
    pinned: false,
    tabOpen: false,
    closedTab: false,
    lastOpenedAt: null,
    tabOrder: null,
    ...partial,
  };
}

function withRoster(
  room: WorkbenchRoomSummary,
  roster: Array<Record<string, unknown>>,
): WorkbenchRoomSummary {
  return {
    ...room,
    memberCount: roster.length,
    roster: roster as unknown as WorkbenchRoomSummary["roster"],
  };
}

function sectionRowLabels(result: ReturnType<typeof useExplorerData>, kind: string): string[] {
  const section = result.current.sections.find((s) => s.kind === kind);
  return section?.rows.map((r) => r.label) ?? [];
}

describe("useExplorerData — mixed-deployment roster fallback", () => {
  test("all embedded rosters (including empty arrays) issue zero detail requests", async () => {
    navState.rooms = [
      withRoster(mkRoom({ id: "r1", label: "Genie room" }), [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ]),
      mkRoom({ id: "r2", label: "Empty roster", memberCount: 0, roster: [] }),
    ];

    const { result } = renderHook(() => useExplorerData());

    expect(result.current.ready).toBe(true);
    expect(getRoomCalls).toEqual([]);
    expect(sectionRowLabels(result, "my-agents")).toContain("Genie");

    await act(async () => {
      await Promise.resolve();
    });
    expect(getRoomCalls).toEqual([]);
  });

  test("missing summary roster hydrates via getRoom and self-corrects classification", async () => {
    navState.rooms = [
      mkRoom({
        id: "dm-casey",
        label: "Owner · Casey",
        kind: "private",
        memberCount: 2,
      }),
    ];

    const { result, rerender } = renderHook(() => useExplorerData());

    expect(result.current.ready).toBe(true);
    expect(getRoomCalls).toEqual(["dm-casey"]);
    // Heuristic: private 2-member room without roster → synthetic agent row.
    expect(sectionRowLabels(result, "other-agents")).toContain("Casey");
    expect(sectionRowLabels(result, "people")).toHaveLength(0);

    pending.get("dm-casey")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        {
          actorId: "actor-casey",
          kind: "user",
          displayName: "Casey",
          userId: "u-casey",
          roomRole: "member",
        },
      ],
      conductorMode: "advanced",
    });

    await waitFor(() => {
      expect(sectionRowLabels(result, "people")).toContain("Casey");
    });
    expect(sectionRowLabels(result, "other-agents")).toHaveLength(0);

    rerender();
    expect(getRoomCalls).toEqual(["dm-casey"]);
  });

  test("mixed payload hydrates only missing-roster rooms", async () => {
    navState.rooms = [
      withRoster(mkRoom({ id: "embedded", label: "Embedded" }), [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ]),
      mkRoom({ id: "legacy-a", label: "Legacy A", memberCount: 2 }),
      mkRoom({ id: "legacy-b", label: "Legacy B", memberCount: 2 }),
    ];

    renderHook(() => useExplorerData());

    expect(getRoomCalls.sort()).toEqual(["legacy-a", "legacy-b"]);

    pending.get("legacy-a")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID, roomRole: "member" },
      ],
      conductorMode: "advanced",
    });
    pending.get("legacy-b")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID, roomRole: "member" },
      ],
      conductorMode: "advanced",
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(getRoomCalls.filter((id) => id === "embedded")).toHaveLength(0);
  });

  test("failed fallback settles once and does not refetch continuously", async () => {
    navState.rooms = [mkRoom({ id: "broken", label: "Broken", memberCount: 2 })];

    const { rerender } = renderHook(() => useExplorerData());
    expect(getRoomCalls).toEqual(["broken"]);

    pending.get("broken")?.reject(new Error("network"));
    await act(async () => {
      await Promise.resolve();
    });

    getRoomCalls.length = 0;
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(getRoomCalls).toEqual([]);
  });

  test("removed room drops fallback cache and ignores stale detail responses", async () => {
    navState.rooms = [mkRoom({ id: "gone", label: "Gone", memberCount: 2 })];

    const { result, rerender } = renderHook(() => useExplorerData());
    expect(getRoomCalls).toEqual(["gone"]);

    navState = {
      ...navState,
      rooms: [],
    };
    rerender();

    pending.get("gone")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        {
          actorId: "actor-casey",
          kind: "user",
          displayName: "Casey",
          userId: "u-casey",
          roomRole: "member",
        },
      ],
      conductorMode: "advanced",
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sections.flatMap((s) => s.rows)).toHaveLength(0);
  });

  test("same actor with a new viewer generation resets settled fallback state", async () => {
    navState.rooms = [mkRoom({ id: "shared", label: "Shared", memberCount: 2 })];

    const { rerender } = renderHook(() => useExplorerData());
    expect(getRoomCalls).toEqual(["shared"]);

    pending.get("shared")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID, roomRole: "member" },
      ],
      conductorMode: "advanced",
    });
    await act(async () => {
      await Promise.resolve();
    });

    getRoomCalls.length = 0;
    viewerGeneration = 2;
    rerender();

    await waitFor(() => {
      expect(getRoomCalls).toEqual(["shared"]);
    });
  });

  test("an old promise cannot delete the newer generation's in-flight request", async () => {
    navState.rooms = [mkRoom({ id: "shared", label: "Shared", memberCount: 2 })];

    const { rerender } = renderHook(() => useExplorerData());
    expect(getRoomCalls).toEqual(["shared"]);
    const oldPromise = allPending.get("shared")?.[0];

    viewerGeneration = 2;
    rerender();
    expect(getRoomCalls).toEqual(["shared", "shared"]);
    const newPromise = allPending.get("shared")?.[1];

    oldPromise?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Old Me", userId: "u-me", roomRole: "admin" },
        { actorId: AGENT_G, kind: "agent", displayName: "Old Genie", agentId: AGENT_G_ID, roomRole: "member" },
      ],
      conductorMode: "advanced",
    });
    await act(async () => {
      await Promise.resolve();
    });

    navState = { ...navState, rooms: [...navState.rooms] };
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(getRoomCalls).toEqual(["shared", "shared"]);

    newPromise?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "New Me", userId: "u-me", roomRole: "admin" },
        { actorId: AGENT_G, kind: "agent", displayName: "New Genie", agentId: AGENT_G_ID, roomRole: "member" },
      ],
      conductorMode: "advanced",
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  test("multiple hook instances join and apply the same in-flight result", async () => {
    navState.rooms = [
      mkRoom({
        id: "dm-casey",
        label: "Owner · Casey",
        kind: "private",
        memberCount: 2,
      }),
    ];

    const { result } = renderHook(() => [useExplorerData(), useExplorerData()] as const);
    expect(getRoomCalls).toEqual(["dm-casey"]);

    pending.get("dm-casey")?.resolve({
      members: [
        { actorId: VIEWER, kind: "user", displayName: "Me", userId: "u-me", roomRole: "admin" },
        {
          actorId: "actor-casey",
          kind: "user",
          displayName: "Casey",
          userId: "u-casey",
          roomRole: "member",
        },
      ],
      conductorMode: "advanced",
    });

    await waitFor(() => {
      expect(sectionRowLabels({ current: result.current[0] }, "people")).toContain("Casey");
      expect(sectionRowLabels({ current: result.current[1] }, "people")).toContain("Casey");
    });
    expect(getRoomCalls).toEqual(["dm-casey"]);
  });
});
