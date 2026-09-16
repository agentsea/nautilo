import { describe, expect, test } from "bun:test";
import type { RoomSummaryDto } from "@nautilo/types";
import {
  mergeRoomSummariesWithMetadata,
  sortWorkbenchRooms,
} from "../../src/rooms/room-navigation-merge";
import { ROOM_NAV_STORAGE_VERSION } from "../../src/rooms/room-navigation-storage";

function dto(id: string): RoomSummaryDto {
  return {
    id,
    label: id,
    type: "private",
    graphThreadId: `g-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 1,
  };
}

describe("room-navigation-merge", () => {
  test("merge applies pinned + tabOpen + closedTab + lastOpenedAt", () => {
    const merged = mergeRoomSummariesWithMetadata([dto("a")], {
      version: ROOM_NAV_STORAGE_VERSION,
      rooms: {
        a: { pinned: true, tabOpen: true, closedTab: false, lastOpenedAt: 99 },
      },
    });
    expect(merged[0]).toMatchObject({
      id: "a",
      pinned: true,
      tabOpen: true,
      closedTab: false,
      lastOpenedAt: 99,
    });
  });

  test("sort — pinned first, then lastOpenedAt desc, then createdAt desc", () => {
    const merged = mergeRoomSummariesWithMetadata(
      [
        { ...dto("old"), createdAt: "2020-01-01T00:00:00.000Z" },
        { ...dto("new"), createdAt: "2026-06-01T00:00:00.000Z" },
      ],
      {
        version: ROOM_NAV_STORAGE_VERSION,
        rooms: {
          old: { lastOpenedAt: 100 },
          new: { lastOpenedAt: 50 },
        },
      },
    );
    const sorted = sortWorkbenchRooms(merged);
    expect(sorted.map((r) => r.id)).toEqual(["old", "new"]);

    const pinned = sortWorkbenchRooms(
      mergeRoomSummariesWithMetadata([dto("a"), dto("b")], {
        version: ROOM_NAV_STORAGE_VERSION,
        rooms: {
          b: { pinned: true, lastOpenedAt: 1 },
          a: { lastOpenedAt: 999 },
        },
      }),
    );
    expect(pinned.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
