import { describe, expect, test } from "bun:test";
import { canViewOwnSessionTranscripts } from "../../src/lib/session-transcript-access";

describe("session-transcript-access (M133, capability-derived)", () => {
  test("allows viewers holding read_memories; denies guests and missing caps", () => {
    expect(canViewOwnSessionTranscripts(["read_memories"])).toBe(true);
    expect(canViewOwnSessionTranscripts([])).toBe(false);
    expect(canViewOwnSessionTranscripts(undefined)).toBe(false);
    expect(canViewOwnSessionTranscripts(["manage_rooms"])).toBe(false);
  });
});
