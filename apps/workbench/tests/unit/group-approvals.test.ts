import { describe, expect, test } from "bun:test";
import type { CommandApprovalRow } from "@nautilo/api-client";
import {
  groupApprovalsByScope,
  roomGroupTestId,
  roomGroupTitle,
  SERVER_GROUP_TITLE,
} from "../../src/components/approvals/group-approvals";

function row(
  overrides: Partial<CommandApprovalRow> & Pick<CommandApprovalRow, "id" | "scope">,
): CommandApprovalRow {
  return {
    roomId: null,
    roomLabel: null,
    toolPattern: "*",
    label: overrides.id,
    approvalKind: "tool",
    capabilitySlug: null,
    active: true,
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("groupApprovalsByScope", () => {
  test("splits server rows and groups room rows by room preserving order", () => {
    const rows = [
      row({
        id: "room-a-1",
        scope: "room",
        roomId: "room-a",
        roomLabel: "#infra-ops",
        label: "room rule 1",
      }),
      row({ id: "server-1", scope: "server", label: "server rule 1" }),
      row({
        id: "room-b-1",
        scope: "room",
        roomId: "room-b",
        roomLabel: "#general",
        label: "room rule 2",
      }),
      row({
        id: "room-a-2",
        scope: "room",
        roomId: "room-a",
        roomLabel: "#infra-ops",
        label: "room rule 3",
      }),
      row({ id: "server-2", scope: "server", label: "server rule 2" }),
    ];

    const grouped = groupApprovalsByScope(rows);

    expect(grouped.server.map((r) => r.id)).toEqual(["server-1", "server-2"]);
    expect(grouped.rooms).toHaveLength(2);
    expect(grouped.rooms[0]?.roomId).toBe("room-a");
    expect(grouped.rooms[0]?.rows.map((r) => r.id)).toEqual(["room-a-1", "room-a-2"]);
    expect(grouped.rooms[1]?.roomId).toBe("room-b");
    expect(grouped.rooms[1]?.rows.map((r) => r.id)).toEqual(["room-b-1"]);
  });

  test("room group titles and test ids use the room label with unknown fallback", () => {
    const group = {
      roomId: "room-x",
      roomLabel: null,
      rows: [row({ id: "r1", scope: "room", roomId: "room-x", roomLabel: null })],
    };

    expect(roomGroupTitle(group)).toBe("ROOM · (unknown)");
    expect(roomGroupTestId(group)).toBe("approval-group-ROOM · (unknown)");
    expect(SERVER_GROUP_TITLE).toBe("ALWAYS · SERVER-WIDE");
  });
});
