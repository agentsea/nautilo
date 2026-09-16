import { describe, expect, test } from "bun:test";
import type { RoomSummaryDto } from "@nautilo/types";
import { isStrictHumanAgentRoom, roomsVisibleToViewer } from "./guest-room-visibility";

function room(id: string, roster: RoomSummaryDto["roster"]): RoomSummaryDto {
  return {
    id,
    label: id,
    type: "private",
    graphThreadId: `room:${id}`,
    createdAt: "2026-08-12T00:00:00.000Z",
    memberCount: roster?.length ?? 0,
    messageCount: 0,
    lastMessageAt: null,
    unreadCount: 0,
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    roster,
  };
}

const human = { actorId: "human", kind: "user" as const, displayName: "Guest" };
const agent = { actorId: "agent", kind: "agent" as const, displayName: "Genie" };
const staff = { actorId: "staff", kind: "user" as const, displayName: "Admin" };

describe("M259 Guest Room visibility", () => {
  test("filters only strict viewer-Agent rooms when invocation is unavailable", () => {
    const personal = room("personal", [human, agent]);
    const mixed = room("community", [human, staff, agent]);
    const humanDm = room("admin-dm", [human, staff]);
    const unknown = room("legacy", undefined);

    expect(isStrictHumanAgentRoom(personal, "human")).toBe(true);
    expect(roomsVisibleToViewer([personal, mixed, humanDm, unknown], {
      viewerActorId: "human",
      canInvokeAgents: false,
    }).map((candidate) => candidate.id)).toEqual(["community", "admin-dm", "legacy"]);
  });

  test("preserves all rooms for an authorized Human", () => {
    const personal = room("personal", [human, agent]);
    expect(roomsVisibleToViewer([personal], {
      viewerActorId: "human",
      canInvokeAgents: true,
    })).toEqual([personal]);
  });
});
