import { describe, expect, test } from "bun:test";

import { directHumanPeerUserId } from "../../src/human-blocks";

describe("directHumanPeerUserId", () => {
  test("returns the other user only for an exact two-Human roster", () => {
    expect(directHumanPeerUserId([
      { kind: "user", userId: "human-a" },
      { kind: "user", userId: "human-b" },
    ], "human-a")).toBe("human-b");
  });

  test("rejects self-only, missing-user, Agent, and shared-room shapes", () => {
    expect(directHumanPeerUserId([
      { kind: "user", userId: "human-a" },
      { kind: "user", userId: "human-a" },
    ], "human-a")).toBeNull();
    expect(directHumanPeerUserId([
      { kind: "user", userId: "human-a" },
      { kind: "agent" },
    ], "human-a")).toBeNull();
    expect(directHumanPeerUserId([
      { kind: "user", userId: "human-a" },
      { kind: "user", userId: "human-b" },
      { kind: "user", userId: "human-c" },
    ], "human-a")).toBeNull();
  });
});
