import type { RoomSummaryDto } from "@nautilo/types";
import type { WorkbenchRoomSummary } from "../../src/rooms/room-navigation-types";

export function fixtureRoomDto(overrides: Partial<RoomSummaryDto> = {}): RoomSummaryDto {
  return {
    id: "room-default",
    label: "Owner · Genie",
    type: "private",
    graphThreadId: "g-default",
    createdAt: "2026-01-15T12:00:00.000Z",
    memberCount: 1,
    ...overrides,
  };
}

export function fixtureWorkbenchRoom(
  overrides: Partial<WorkbenchRoomSummary> = {},
): WorkbenchRoomSummary {
  const {
    pinned = false,
    tabOpen = false,
    closedTab = false,
    lastOpenedAt = null,
    tabOrder = null,
    id,
    label,
    type,
    graphThreadId,
    createdAt,
    memberCount,
  } = overrides;

  return {
    ...fixtureRoomDto({
      id,
      label,
      type,
      graphThreadId,
      createdAt,
      memberCount,
    }),
    pinned,
    tabOpen,
    closedTab,
    lastOpenedAt,
    tabOrder,
  };
}

export const FIXTURE_LONG_LABEL_ROOM = fixtureWorkbenchRoom({
  id: "room-long",
  label: "A very long chat label that should truncate in the tab strip UI",
});

export const FIXTURE_MANY_ROOMS: WorkbenchRoomSummary[] = [
  fixtureWorkbenchRoom({ id: "r1", label: "Alpha", lastOpenedAt: 300 }),
  fixtureWorkbenchRoom({ id: "r2", label: "Beta", lastOpenedAt: 200 }),
  fixtureWorkbenchRoom({ id: "r3", label: "Gamma", lastOpenedAt: 100 }),
  fixtureWorkbenchRoom({ id: "r4", label: "Delta", pinned: true, lastOpenedAt: 50 }),
  fixtureWorkbenchRoom({ id: "r5", label: "Epsilon", lastOpenedAt: 10 }),
];
