import { describe, expect, test } from "bun:test";
import { reflectionRecoveryFamilyRoomProven } from "../../src/lib/memory-recovery-service";

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";

describe("Reflection recovery family Room proof", () => {
  test("accepts an exact co-bound family whose members and invocation share one Room", () => {
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["record-a", "record-b"],
      eventAssociations: [
        { recordId: "record-a", roomId: ROOM },
        { recordId: "record-b", roomId: ROOM },
      ],
      attemptRoomIds: [ROOM],
    })).toBe(true);
  });

  test("rejects a co-bound family with a cross-Room or unproven member", () => {
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["record-a", "record-b"],
      eventAssociations: [
        { recordId: "record-a", roomId: ROOM },
        { recordId: "record-b", roomId: OTHER_ROOM },
      ],
      attemptRoomIds: [ROOM],
    })).toBe(false);
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["record-a", "record-b"],
      eventAssociations: [{ recordId: "record-a", roomId: ROOM }],
      attemptRoomIds: [ROOM],
    })).toBe(false);
  });

  test("permits only a singleton to derive Room proof solely from its exact invocation", () => {
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["derived-record"],
      eventAssociations: [],
      attemptRoomIds: [ROOM],
    })).toBe(true);
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["derived-a", "derived-b"],
      eventAssociations: [],
      attemptRoomIds: [ROOM],
    })).toBe(false);
    expect(reflectionRecoveryFamilyRoomProven({
      roomId: ROOM,
      memberRecordIds: ["derived-record"],
      eventAssociations: [],
      attemptRoomIds: [OTHER_ROOM],
    })).toBe(false);
  });
});
