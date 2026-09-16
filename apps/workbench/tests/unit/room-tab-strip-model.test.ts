import { describe, expect, test } from "bun:test";
import {
  defaultNewChatLabel,
  moveRoomIdBeforeTarget,
  pickNeighborTabId,
  roomTabDisplayLabel,
  selectRoomsForTabStrip,
} from "../../src/rooms/room-tab-strip-model";
import { fixtureWorkbenchRoom, FIXTURE_MANY_ROOMS } from "./test-room-fixtures";

describe("defaultNewChatLabel", () => {
  test("deterministic from timestamp", () => {
    expect(defaultNewChatLabel(Date.UTC(2026, 4, 2, 12, 0, 0))).toBe("New chat 2026-05-02");
  });
});

describe("roomTabDisplayLabel", () => {
  test("replaces the ambiguous generated private-room label with the other member", () => {
    const room = {
      ...fixtureWorkbenchRoom({
      label: "Owner · Genie",
      type: "private",
      memberCount: 2,
      }),
      roster: [
        { actorId: "owner", kind: "user", displayName: "Alex" },
        { actorId: "anna", kind: "agent", displayName: "Anna" },
      ],
    } as ReturnType<typeof fixtureWorkbenchRoom>;
    expect(roomTabDisplayLabel(room, "owner")).toBe("Anna");
  });

  test("preserves a user-controlled label", () => {
    const room = {
      ...fixtureWorkbenchRoom({
      label: "Marketing deck",
      type: "private",
      memberCount: 2,
      }),
      roster: [
        { actorId: "owner", kind: "user", displayName: "Alex" },
        { actorId: "anna", kind: "agent", displayName: "Anna" },
      ],
    } as ReturnType<typeof fixtureWorkbenchRoom>;
    expect(roomTabDisplayLabel(room, "owner")).toBe("Marketing deck");
  });
});

describe("selectRoomsForTabStrip", () => {
  test("uses explicit tab order instead of auto-moving selected rooms", () => {
    const rooms = [
      fixtureWorkbenchRoom({
        id: "u1",
        label: "u1",
        tabOpen: true,
        lastOpenedAt: 99,
        tabOrder: 1,
      }),
      fixtureWorkbenchRoom({
        id: "p1",
        label: "p1",
        pinned: true,
        lastOpenedAt: 5,
        tabOrder: 0,
      }),
    ];
    const out = selectRoomsForTabStrip(rooms, "u1");
    expect(out.map((r) => r.id)).toEqual(["p1", "u1"]);
  });

  test("lists every locally open tab for horizontal scroll (no silent drop)", () => {
    const rooms = [
      ...FIXTURE_MANY_ROOMS.map((r) => ({ ...r, tabOpen: true })),
      fixtureWorkbenchRoom({ id: "extra", label: "extra", tabOpen: true }),
    ];
    const out = selectRoomsForTabStrip(rooms, null);
    expect(out.length).toBe(rooms.length);
  });

  test("does not open durable server rooms without local tab state", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "history-a", label: "History A" }),
      fixtureWorkbenchRoom({ id: "history-b", label: "History B" }),
    ];
    const out = selectRoomsForTabStrip(rooms, null);
    expect(out).toEqual([]);
  });

  test("excludes closed tabs except active", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "a", tabOpen: true, closedTab: true }),
      fixtureWorkbenchRoom({ id: "b", tabOpen: true }),
    ];
    const out = selectRoomsForTabStrip(rooms, null);
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  test("includes active room even when it was previously closed locally", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "a", closedTab: true }),
      fixtureWorkbenchRoom({ id: "b", tabOpen: true }),
    ];
    const out = selectRoomsForTabStrip(rooms, "a");
    expect(out.map((r) => r.id)).toContain("a");
  });

  test("includes all pinned plus unpinned without dropping active", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "p1", pinned: true, tabOrder: 2 }),
      fixtureWorkbenchRoom({ id: "p2", pinned: true, tabOrder: 3 }),
      fixtureWorkbenchRoom({ id: "p3", pinned: true, tabOrder: 4 }),
      fixtureWorkbenchRoom({ id: "active", pinned: false, tabOrder: 0 }),
      fixtureWorkbenchRoom({ id: "u2", pinned: false, tabOpen: true, tabOrder: 1 }),
    ];
    const out = selectRoomsForTabStrip(rooms, "active");
    expect(out.map((r) => r.id)).toEqual(["active", "u2", "p1", "p2", "p3"]);
  });
});

describe("moveRoomIdBeforeTarget", () => {
  test("moves dragged room before drop target", () => {
    expect(moveRoomIdBeforeTarget(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  test("leaves order unchanged for same room", () => {
    expect(moveRoomIdBeforeTarget(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });
});

describe("pickNeighborTabId", () => {
  test("prefers right neighbor", () => {
    expect(pickNeighborTabId([{ id: "a" }, { id: "b" }, { id: "c" }], "b")).toBe("c");
  });

  test("falls back left", () => {
    expect(pickNeighborTabId([{ id: "a" }, { id: "b" }], "b")).toBe("a");
  });

  test("single tab → null", () => {
    expect(pickNeighborTabId([{ id: "only" }], "only")).toBeNull();
  });
});
