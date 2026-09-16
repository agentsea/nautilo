import { describe, expect, test } from "bun:test";
import { formatRoomMembershipSystemLine } from "@nautilo/trust";

describe("formatRoomMembershipSystemLine", () => {
  test("join / leave copy", () => {
    expect(
      formatRoomMembershipSystemLine({
        kind: "member_added",
        actorId: "a1",
        actorKind: "agent",
        displayName: "Genie",
      }),
    ).toBe("Genie joined the room");
    expect(
      formatRoomMembershipSystemLine({
        kind: "member_removed",
        actorId: "a1",
        actorKind: "agent",
        displayName: "Genie",
      }),
    ).toBe("Genie left the room");
  });
});
