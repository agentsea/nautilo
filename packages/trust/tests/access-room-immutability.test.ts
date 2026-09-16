import { describe, expect, test } from "bun:test";

import {
  assertRoomAllowsDirectMembershipMutation,
  MembershipOpError,
} from "../src/queries";

describe("M258 access Room membership invariant", () => {
  test("rejects generic direct mutation for hidden access Rooms", () => {
    try {
      assertRoomAllowsDirectMembershipMutation("access");
      throw new Error("expected access Room mutation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MembershipOpError);
      expect((error as MembershipOpError).opCode).toBe("access_room_immutable");
    }
  });

  test("does not change existing conversational membership behavior", () => {
    for (const kind of ["default", "task", "subthread"] as const) {
      expect(() => assertRoomAllowsDirectMembershipMutation(kind)).not.toThrow();
    }
  });
});
