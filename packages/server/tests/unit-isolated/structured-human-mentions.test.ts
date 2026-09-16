import { describe, expect, test } from "bun:test";
import {
  parseStructuredHumanMentionIds,
  StructuredHumanMentionError,
} from "../../src/messaging/structured-human-mentions";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const AGENT_OWNER = "33333333-3333-4333-8333-333333333333";

const room = {
  members: [
    {
      actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "user" as const,
      userId: ALICE,
      displayName: "Alice",
      roomRole: "member" as const,
    },
    {
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "user" as const,
      userId: BOB,
      displayName: "Bob",
      roomRole: "member" as const,
    },
    {
      actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      kind: "agent" as const,
      agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      displayName: "Genie",
      roomRole: "member" as const,
    },
  ],
};

describe("parseStructuredHumanMentionIds", () => {
  test("normalizes exact duplicates and preserves stable order", () => {
    expect(parseStructuredHumanMentionIds([BOB, ALICE, BOB], room)).toEqual([
      BOB,
      ALICE,
    ]);
  });

  test("rejects malformed, Agent-owner, stale, and oversized recipients", () => {
    for (const value of [
      ["not-a-uuid"],
      [AGENT_OWNER],
      ["44444444-4444-4444-8444-444444444444"],
      Array.from(
        { length: 33 },
        (_, index) =>
          `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      ),
    ]) {
      expect(() => parseStructuredHumanMentionIds(value, room)).toThrow(
        StructuredHumanMentionError,
      );
    }
  });

  test("rejects non-array input and accepts absence", () => {
    expect(() => parseStructuredHumanMentionIds(ALICE, room)).toThrow(
      "must be an array",
    );
    expect(parseStructuredHumanMentionIds(undefined, room)).toEqual([]);
  });
});
