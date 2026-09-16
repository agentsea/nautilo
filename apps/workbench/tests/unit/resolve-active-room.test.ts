import { describe, expect, test } from "bun:test";
import { resolveActiveRoom } from "../../src/rooms/resolve-active-room";
import type { WorkbenchRoomSummary } from "../../src/rooms/room-navigation-types";

function room(id: string, overrides: Partial<WorkbenchRoomSummary> = {}): WorkbenchRoomSummary {
  return {
    id,
    label: id,
    type: "private",
    graphThreadId: `g-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 1,
    pinned: false,
    closedTab: false,
    lastOpenedAt: null,
    ...overrides,
  };
}

describe("resolveActiveRoom", () => {
  test("route id wins when present in list", () => {
    const rooms = [room("a"), room("b")];
    expect(
      resolveActiveRoom({
        routeRoomId: "b",
        storedRoomId: "a",
        rooms,
      }),
    ).toEqual({ kind: "selected", roomId: "b" });
  });

  test("stale URL id yields missing", () => {
    const rooms = [room("a")];
    expect(
      resolveActiveRoom({
        routeRoomId: "ghost",
        storedRoomId: "a",
        rooms,
      }),
    ).toEqual({ kind: "missing", roomId: "ghost" });
  });

  test("restricted viewer falls back from a suppressed route to a visible room", () => {
    const rooms = [room("invited"), room("public")];
    expect(
      resolveActiveRoom({
        routeRoomId: "personal-agent-room",
        storedRoomId: "personal-agent-room",
        rooms,
        fallbackWhenRouteMissing: true,
      }),
    ).toEqual({ kind: "selected", roomId: "invited" });
  });

  test("no route uses stored when valid", () => {
    const rooms = [room("a"), room("b")];
    expect(
      resolveActiveRoom({
        routeRoomId: undefined,
        storedRoomId: "b",
        rooms,
      }),
    ).toEqual({ kind: "selected", roomId: "b" });
  });

  test("stale stored id falls back to first room", () => {
    const rooms = [room("x"), room("y")];
    expect(
      resolveActiveRoom({
        routeRoomId: undefined,
        storedRoomId: "gone",
        rooms,
      }),
    ).toEqual({ kind: "selected", roomId: "x" });
  });

  test("empty list yields none", () => {
    expect(
      resolveActiveRoom({
        routeRoomId: undefined,
        storedRoomId: "a",
        rooms: [],
      }),
    ).toEqual({ kind: "none" });
  });

  test("empty route id string ignored like undefined — uses stored", () => {
    const rooms = [room("a")];
    expect(
      resolveActiveRoom({
        routeRoomId: "",
        storedRoomId: "a",
        rooms,
      }),
    ).toEqual({ kind: "selected", roomId: "a" });
  });
});
