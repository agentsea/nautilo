import { describe, test, expect } from "bun:test";
import { findShareTargetRoom } from "@nautilo/trust";

describe("findShareTargetRoom (M078 edge)", () => {
  test("returns null when any id is missing", async () => {
    expect(
      await findShareTargetRoom({
        requesterActorId: "",
        targetActorId: "40000000-0000-4000-8000-000000000004",
        agentId: "20000000-0000-4000-8000-000000000002",
      }),
    ).toBeNull();
  });
});
