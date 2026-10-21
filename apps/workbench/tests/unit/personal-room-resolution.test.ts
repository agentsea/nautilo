import { describe, expect, test } from "bun:test";
import type { RoomSummaryDto } from "@nautilo/types";
import { resolveOwnedPersonalRoom } from "../../src/genie-customization/personal-room-resolution";

function room(overrides: Partial<RoomSummaryDto> = {}): RoomSummaryDto {
  return {
    id: "personal",
    label: "Human · Genie",
    type: "private",
    kind: "private",
    graphThreadId: "room:personal",
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 2,
    roster: [
      { actorId: "viewer-actor", kind: "user", userId: "viewer-user", displayName: "Human" },
      { actorId: "genie-actor", kind: "agent", agentId: "owned-genie", displayName: "Genie" },
    ],
    ...overrides,
  };
}

describe("resolveOwnedPersonalRoom", () => {
  test("accepts only the exact private Human and owned-Genie roster", () => {
    const candidates = [
      room({ id: "public", type: "public" }),
      room({ id: "wrong-kind", kind: "group" }),
      room({ id: "foreign-human", roster: [
        { actorId: "other-actor", kind: "user", displayName: "Other" },
        { actorId: "genie-actor", kind: "agent", agentId: "owned-genie", displayName: "Genie" },
      ] }),
      room({ id: "foreign-agent", roster: [
        { actorId: "viewer-actor", kind: "user", displayName: "Human" },
        { actorId: "other-genie-actor", kind: "agent", agentId: "other-genie", displayName: "Other Genie" },
      ] }),
      room({ id: "multi-member", memberCount: 3, roster: [
        { actorId: "viewer-actor", kind: "user", displayName: "Human" },
        { actorId: "genie-actor", kind: "agent", agentId: "owned-genie", displayName: "Genie" },
        { actorId: "other", kind: "user", displayName: "Other" },
      ] }),
      room({ id: "exact" }),
    ];

    expect(resolveOwnedPersonalRoom(candidates, "viewer-actor", "owned-genie")?.id).toBe("exact");
  });

  test("prefers app:default, then oldest creation time, then id", () => {
    expect(resolveOwnedPersonalRoom([
      room({ id: "oldest", createdAt: "2020-01-01T00:00:00.000Z" }),
      room({ id: "legacy-z", graphThreadId: "app:default", createdAt: "2025-01-01T00:00:00.000Z" }),
      room({ id: "legacy-a", graphThreadId: "app:default", createdAt: "2025-01-01T00:00:00.000Z" }),
    ], "viewer-actor", "owned-genie")?.id).toBe("legacy-a");

    expect(resolveOwnedPersonalRoom([
      room({ id: "newer", createdAt: "2025-01-01T00:00:00.000Z" }),
      room({ id: "same-z", createdAt: "2020-01-01T00:00:00.000Z" }),
      room({ id: "same-a", createdAt: "2020-01-01T00:00:00.000Z" }),
    ], "viewer-actor", "owned-genie")?.id).toBe("same-a");
  });

  test("returns null when no candidate proves both exact members", () => {
    expect(resolveOwnedPersonalRoom([], "viewer-actor", "owned-genie")).toBeNull();
  });
});
