import { describe, expect, test } from "bun:test";

import { selectDomainKeyCatchUpRoomId } from
  "../../src/routes/domain-key-authority";

describe("Domain key catch-up Room selection", () => {
  test("selects the canonical Room that owns the requested Namespace", () => {
    expect(selectDomainKeyCatchUpRoomId([
      { roomId: "target-namespace-room" },
    ])).toBe("target-namespace-room");
  });

  test("fails closed when the Namespace Room is missing or ambiguous", () => {
    expect(selectDomainKeyCatchUpRoomId([])).toBeNull();
    expect(selectDomainKeyCatchUpRoomId([
      { roomId: "first-room" },
      { roomId: "second-room" },
    ])).toBeNull();
  });
});
