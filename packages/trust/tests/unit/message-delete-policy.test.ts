import { describe, expect, test } from "bun:test";
import { decideMessageDelete } from "../../src/membership";

const CALLER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function deleteInput(
  overrides: Partial<Parameters<typeof decideMessageDelete>[0]> = {},
): Parameters<typeof decideMessageDelete>[0] {
  return {
    messageExists: true,
    callerIsMember: true,
    messageRole: "user",
    sessionOwnerId: CALLER_ID,
    callerUserId: CALLER_ID,
    callerHasManageRooms: false,
    callerHasRoomStewardship: false,
    ...overrides,
  };
}

describe("decideMessageDelete (ISSUE-M172 §8.1)", () => {
  test("own role='user' message (sessionOwnerId === caller, member, no manage_rooms) → allowed", () => {
    expect(decideMessageDelete(deleteInput())).toBe("allowed");
  });

  test("non-author human deletes someone else's role='user' row (member, no manage_rooms) → forbidden", () => {
    expect(
      decideMessageDelete(
        deleteInput({ sessionOwnerId: OTHER_ID, callerUserId: CALLER_ID }),
      ),
    ).toBe("forbidden");
  });

  test("non-author human WITH manage_rooms deletes another human's row → allowed", () => {
    expect(
      decideMessageDelete(
        deleteInput({
          sessionOwnerId: OTHER_ID,
          callerUserId: CALLER_ID,
          callerHasManageRooms: true,
        }),
      ),
    ).toBe("allowed");
  });

  test("Room owner/admin deletes another human's row without global manage_rooms → allowed", () => {
    expect(
      decideMessageDelete(
        deleteInput({
          sessionOwnerId: OTHER_ID,
          callerUserId: CALLER_ID,
          callerHasRoomStewardship: true,
        }),
      ),
    ).toBe("allowed");
  });

  test("non-admin human deletes an agent's role='assistant' row (member, no manage_rooms) → forbidden", () => {
    expect(
      decideMessageDelete(
        deleteInput({ messageRole: "assistant", sessionOwnerId: OTHER_ID }),
      ),
    ).toBe("forbidden");
  });

  test("human WITH manage_rooms deletes an agent's role='assistant' row → allowed", () => {
    expect(
      decideMessageDelete(
        deleteInput({
          messageRole: "assistant",
          sessionOwnerId: OTHER_ID,
          callerHasManageRooms: true,
        }),
      ),
    ).toBe("allowed");
  });

  test("non-member (callerIsMember=false, messageExists=true) → not_found", () => {
    expect(
      decideMessageDelete(deleteInput({ callerIsMember: false })),
    ).toBe("not_found");
  });

  test("missing message (messageExists=false) → not_found", () => {
    expect(
      decideMessageDelete(deleteInput({ messageExists: false })),
    ).toBe("not_found");
  });
});
