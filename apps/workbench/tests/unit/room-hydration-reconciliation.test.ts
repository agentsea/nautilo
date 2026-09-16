import { describe, expect, test } from "bun:test";
import {
  liveArrivalsSince,
  isLatestRoomHydration,
  mergeHydratedRoomMessages,
  type RoomHydrationRequest,
} from "../../src/adapters/room-hydration-reconciliation";

type Message = { id: string; text: string };

describe("room hydration reconciliation", () => {
  test("retains a live event delivered after a stale history request began", () => {
    const request: RoomHydrationRequest = { roomId: "room-a", generation: 1, liveSequenceAtStart: 5 };
    const live = liveArrivalsSince(request, [
      { roomId: "room-a", sequence: 6, message: { id: "live", text: "new" } },
    ]);
    expect(mergeHydratedRoomMessages([{ id: "old", text: "old" }], live)).toEqual([
      { id: "old", text: "old" },
      { id: "live", text: "new" },
    ]);
  });

  test("history wins a duplicate canonical id and live-only arrivals retain order", () => {
    const merged = mergeHydratedRoomMessages<Message>(
      [{ id: "1", text: "server truth" }],
      [{ id: "1", text: "older event" }, { id: "2", text: "first" }, { id: "3", text: "second" }],
    );
    expect(merged).toEqual([
      { id: "1", text: "server truth" },
      { id: "2", text: "first" },
      { id: "3", text: "second" },
    ]);
  });

  test("does not mix another Room's arrivals into the target request", () => {
    const request: RoomHydrationRequest = { roomId: "room-a", generation: 2, liveSequenceAtStart: 10 };
    expect(liveArrivalsSince(request, [
      { roomId: "room-b", sequence: 11, message: { id: "b", text: "wrong room" } },
      { roomId: "room-a", sequence: 10, message: { id: "old", text: "before request" } },
      { roomId: "room-a", sequence: 12, message: { id: "a", text: "right room" } },
    ])).toEqual([{ id: "a", text: "right room" }]);
  });

  test("rejects an out-of-order older generation", () => {
    const older: RoomHydrationRequest = { roomId: "room-a", generation: 4, liveSequenceAtStart: 10 };
    const newer: RoomHydrationRequest = { roomId: "room-a", generation: 5, liveSequenceAtStart: 12 };
    expect(isLatestRoomHydration(older, newer)).toBe(false);
    expect(isLatestRoomHydration(newer, newer)).toBe(true);
  });

  test("keeps a live-only event when an empty snapshot completes", () => {
    const request: RoomHydrationRequest = { roomId: "room-a", generation: 1, liveSequenceAtStart: 0 };
    const live = liveArrivalsSince(request, [
      { roomId: "room-a", sequence: 1, message: { id: "persisted", text: "not lost" } },
    ]);
    expect(mergeHydratedRoomMessages([], live)).toEqual([{ id: "persisted", text: "not lost" }]);
  });
});
