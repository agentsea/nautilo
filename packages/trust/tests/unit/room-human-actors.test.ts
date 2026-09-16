import { describe, test, expect } from "bun:test";

/**
 * M044 — `updateRoomHumanActors` invariant tests.
 *
 * The `rooms.human_actor_ids uuid[]` denormalization backs the
 * Room-subset rule (`rooms.human_actor_ids @> ARRAY[...]`). It must
 * stay in sync with `room_members JOIN actors WHERE kind='user'` —
 * any room_members mutation site must call `updateRoomHumanActors`
 * to keep the denormalized column honest.
 *
 * These tests unit-test the sort + filter contract of the helper
 * WITHOUT a live DB: they exercise the pure transformation
 * (members + kinds → sorted human-actor id array) that the helper
 * applies before the UPDATE. Integration coverage of the actual
 * DB round-trip lives in
 * `packages/trust/tests/integration/` once the test-env DB is
 * available; here we pin the invariant at the pure-logic layer.
 */

/**
 * Pure replica of `updateRoomHumanActors`'s in-memory transformation.
 * Extracted here so the invariant is testable without a DB
 * connection. Any behavior-level change in the real helper must
 * also update this mirror + tests.
 */
function selectAndSortHumanActorIds(
  memberRows: Array<{ actorId: string; kind: "user" | "agent" }>,
): string[] {
  return memberRows
    .filter((r) => r.kind === "user")
    .map((r) => r.actorId)
    .sort();
}

describe("M044 — updateRoomHumanActors invariant (pure-logic mirror)", () => {
  test("filters out agent-kind members (only humans populate subset-rule key)", () => {
    const members = [
      { actorId: "actor-owner", kind: "user" as const },
      { actorId: "actor-agent", kind: "agent" as const },
    ];
    expect(selectAndSortHumanActorIds(members)).toEqual(["actor-owner"]);
  });

  test("returns sorted stable order (so snapshot diffs are deterministic)", () => {
    const members = [
      { actorId: "11111111-2222-3333-4444-555555555555", kind: "user" as const },
      { actorId: "00000000-1111-2222-3333-444444444444", kind: "user" as const },
    ];
    expect(selectAndSortHumanActorIds(members)).toEqual([
      "00000000-1111-2222-3333-444444444444",
      "11111111-2222-3333-4444-555555555555",
    ]);
  });

  test("empty member list → empty array (not null, not undefined)", () => {
    expect(selectAndSortHumanActorIds([])).toEqual([]);
  });

  test("all-agent room produces empty human-actor set", () => {
    const members = [
      { actorId: "actor-agent-1", kind: "agent" as const },
      { actorId: "actor-agent-2", kind: "agent" as const },
    ];
    // A hypothetical multi-agent room with no humans has H = {} —
    // subset-rule lookup with H = {} returns the empty superset
    // (only rooms also containing no humans would match, which is
    // none in practice). This is the canonical degenerate case.
    expect(selectAndSortHumanActorIds(members)).toEqual([]);
  });

  test("mixed kinds preserve all humans, drop all agents", () => {
    const members = [
      { actorId: "actor-owner", kind: "user" as const },
      { actorId: "actor-agent-1", kind: "agent" as const },
      { actorId: "actor-household", kind: "user" as const },
      { actorId: "actor-agent-2", kind: "agent" as const },
    ];
    expect(selectAndSortHumanActorIds(members).sort()).toEqual(
      ["actor-household", "actor-owner"].sort(),
    );
  });
});
