import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearRoomPanelMessageCountOptimisticOverlay,
  filterRoomsByQuery,
  handleRoomPanelJobDispatched,
  handleRoomPanelJobStatus,
  partitionRoomsForPanel,
  roomPanelActivityLine,
  roomPanelContextLine,
  resetRoomPanelMessageCountSyncStateForTests,
  ROOM_PANEL_CAP_CLOSED,
  ROOM_PANEL_CAP_RECENT,
} from "../../src/rooms/rooms-panel-model";
import { fixtureWorkbenchRoom } from "./test-room-fixtures";

describe("ISSUE-D163 room message count sync", () => {
  beforeEach(() => {
    resetRoomPanelMessageCountSyncStateForTests();
  });

  test("job.dispatched then first job.status completed adds +2 to activity line", () => {
    const room = fixtureWorkbenchRoom({
      id: "room-a",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-05-16T12:00:00.000Z",
    });
    expect(handleRoomPanelJobDispatched({ jobId: "job-1", roomId: "room-a" })).toBe(true);
    expect(roomPanelActivityLine(room)).toBe("1 message · created May 16");
    const afterAgent = handleRoomPanelJobStatus({
      jobId: "job-1",
      roomId: "room-a",
      status: "completed",
    });
    expect(afterAgent.didMutateOptimistic).toBe(true);
    expect(afterAgent.shouldRefetchRooms).toBe(true);
    expect(roomPanelActivityLine(room)).toBe("2 messages · created May 16");
  });

  test("duplicate job.dispatched or completed does not over-count", () => {
    const room = fixtureWorkbenchRoom({
      id: "room-a",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-05-16T12:00:00.000Z",
    });
    expect(handleRoomPanelJobDispatched({ jobId: "job-1", roomId: "room-a" })).toBe(true);
    expect(handleRoomPanelJobDispatched({ jobId: "job-1", roomId: "room-a" })).toBe(false);
    handleRoomPanelJobStatus({ jobId: "job-1", roomId: "room-a", status: "completed" });
    const secondCompleted = handleRoomPanelJobStatus({
      jobId: "job-1",
      roomId: "room-a",
      status: "completed",
    });
    expect(secondCompleted.didMutateOptimistic).toBe(false);
    expect(secondCompleted.shouldRefetchRooms).toBe(false);
    expect(roomPanelActivityLine(room)).toBe("2 messages · created May 16");
  });

  test("second room is unaffected; clear overlay + server count reconciles without double bump", () => {
    const roomA = fixtureWorkbenchRoom({
      id: "room-a",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-05-16T12:00:00.000Z",
    });
    const roomB = fixtureWorkbenchRoom({
      id: "room-b",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-05-16T12:00:00.000Z",
    });
    handleRoomPanelJobDispatched({ jobId: "job-a1", roomId: "room-a" });
    handleRoomPanelJobDispatched({ jobId: "job-b1", roomId: "room-b" });
    expect(roomPanelActivityLine(roomA)).toContain("1 message");
    expect(roomPanelActivityLine(roomB)).toContain("1 message");
    handleRoomPanelJobStatus({ jobId: "job-a1", roomId: "room-a", status: "completed" });
    expect(roomPanelActivityLine(roomA)).toBe("2 messages · created May 16");
    expect(roomPanelActivityLine(roomB)).toBe("1 message · created May 16");

    clearRoomPanelMessageCountOptimisticOverlay();
    const serverA = { ...roomA, messageCount: 2 };
    const serverB = { ...roomB, messageCount: 1 };
    expect(roomPanelActivityLine(serverA)).toBe("2 messages · created May 16");
    expect(roomPanelActivityLine(serverB)).toBe("1 message · created May 16");
  });

  test("after optimistic bumps, refetch wins when server messageCount differs", () => {
    const room = fixtureWorkbenchRoom({
      id: "room-x",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-05-07T00:00:00.000Z",
    });
    handleRoomPanelJobDispatched({ jobId: "jx", roomId: "room-x" });
    handleRoomPanelJobStatus({ jobId: "jx", roomId: "room-x", status: "completed" });
    expect(roomPanelActivityLine(room)).toContain("2 messages");
    clearRoomPanelMessageCountOptimisticOverlay();
    const reconciled = { ...room, messageCount: 7 };
    expect(roomPanelActivityLine(reconciled)).toBe("7 messages · created May 7");
  });
});

describe("filterRoomsByQuery", () => {
  test("empty query returns all", () => {
    const rooms = [fixtureWorkbenchRoom({ id: "1", label: "Alpha" })];
    expect(filterRoomsByQuery(rooms, "").map((r) => r.id)).toEqual(["1"]);
  });

  test("case-insensitive substring", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "1", label: "Trip PLAN" }),
      fixtureWorkbenchRoom({ id: "2", label: "Other" }),
    ];
    expect(filterRoomsByQuery(rooms, "plan").map((r) => r.id)).toEqual(["1"]);
  });

  test("trims whitespace", () => {
    const rooms = [fixtureWorkbenchRoom({ id: "1", label: "Beta" })];
    expect(filterRoomsByQuery(rooms, "  beta ").length).toBe(1);
  });

  test("sorts by latest room message activity by default", () => {
    const rooms = [
      fixtureWorkbenchRoom({
        id: "old",
        label: "Old",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
      }),
      fixtureWorkbenchRoom({
        id: "new",
        label: "New",
        lastMessageAt: "2026-05-01T00:00:00.000Z",
      }),
    ];
    expect(filterRoomsByQuery(rooms, "").map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("partitionRoomsForPanel", () => {
  test("with query, lists all matching in sections without older hint", () => {
    const sorted = [
      fixtureWorkbenchRoom({ id: "p", label: "Alpha pinned", pinned: true }),
      fixtureWorkbenchRoom({ id: "o", label: "Alpha open", closedTab: false }),
    ];
    const f = filterRoomsByQuery(sorted, "alpha");
    const part = partitionRoomsForPanel(f, "alpha");
    expect(part.olderHiddenCount).toBe(0);
    expect(part.pinned.map((r) => r.id)).toEqual(["p"]);
    expect(part.recent.map((r) => r.id)).toEqual(["o"]);
  });

  test("compact mode caps recent and closed", () => {
    const open = Array.from({ length: ROOM_PANEL_CAP_RECENT + 3 }, (_, i) =>
      fixtureWorkbenchRoom({ id: `o${i}`, label: `o${i}`, closedTab: false }),
    );
    const closed = Array.from({ length: ROOM_PANEL_CAP_CLOSED + 2 }, (_, i) =>
      fixtureWorkbenchRoom({
        id: `c${i}`,
        label: `c${i}`,
        closedTab: true,
        lastOpenedAt: 100 - i,
      }),
    );
    const sorted = [...open, ...closed];
    const part = partitionRoomsForPanel(sorted, "");
    expect(part.recent.length).toBe(ROOM_PANEL_CAP_RECENT);
    expect(part.closed.length).toBe(ROOM_PANEL_CAP_CLOSED);
    expect(part.olderHiddenCount).toBeGreaterThan(0);
  });
});

describe("roomPanelContextLine", () => {
  test("private owner room shows Owner / agent", () => {
    expect(
      roomPanelContextLine({
        roomType: "private",
        viewerRole: "owner",
        viewerLabel: "alex",
        agentName: "Genie",
      }),
    ).toBe("Owner / Genie");
  });
});

describe("roomPanelActivityLine", () => {
  test("shows message count and relative latest message time", () => {
    expect(
      roomPanelActivityLine(
        {
          messageCount: 6894,
          lastMessageAt: "2026-05-01T12:00:00.000Z",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        Date.parse("2026-05-02T12:00:00.000Z"),
      ),
    ).toBe("6,894 messages · last 1d ago");
  });

  test("falls back to created date when a room has no messages", () => {
    expect(
      roomPanelActivityLine({
        messageCount: 0,
        lastMessageAt: null,
        createdAt: "2026-04-07T00:00:00.000Z",
      }),
    ).toBe("0 messages · created Apr 7");
  });
});
