import { describe, expect, it } from "bun:test";
import { applyReactionDelta, applyActorReaction } from "./reaction-aggregate";
import type { ReactionAggregate } from "./ReactionStrip";

const ME = "actor-me";
const OTHER = "actor-other";

describe("applyReactionDelta (count-only)", () => {
  it("increments an existing emoji", () => {
    expect(applyReactionDelta([{ emoji: "👍", count: 2 }], "👍", 1)).toEqual([
      { emoji: "👍", count: 3 },
    ]);
  });

  it("adds a new emoji on +1", () => {
    expect(applyReactionDelta([], "🎉", 1)).toEqual([{ emoji: "🎉", count: 1 }]);
  });

  it("drops an entry that falls to zero", () => {
    expect(applyReactionDelta([{ emoji: "👍", count: 1 }], "👍", -1)).toEqual([]);
  });
});

describe("applyActorReaction (actor-aware, idempotent)", () => {
  it("adds the actor and increments when not already present", () => {
    const next = applyActorReaction(
      [{ emoji: "👍", count: 1, actorIds: [OTHER] }],
      "👍",
      1,
      ME,
    );
    expect(next).toEqual([{ emoji: "👍", count: 2, actorIds: [OTHER, ME] }]);
  });

  it("creates a new emoji entry seeded with the actor", () => {
    expect(applyActorReaction([], "❤️", 1, ME)).toEqual([
      { emoji: "❤️", count: 1, actorIds: [ME] },
    ]);
  });

  it("is idempotent on a repeated add of the same actor (optimistic + WS echo)", () => {
    const afterOptimistic = applyActorReaction([], "❤️", 1, ME);
    const afterEcho = applyActorReaction(afterOptimistic, "❤️", 1, ME);
    // Echo must NOT double-count — count stays 1, actor not duplicated.
    expect(afterEcho).toEqual([{ emoji: "❤️", count: 1, actorIds: [ME] }]);
  });

  it("removes the actor and decrements when present", () => {
    const next = applyActorReaction(
      [{ emoji: "👍", count: 2, actorIds: [OTHER, ME] }],
      "👍",
      -1,
      ME,
    );
    expect(next).toEqual([{ emoji: "👍", count: 1, actorIds: [OTHER] }]);
  });

  it("drops the entry when the last actor removes their reaction", () => {
    expect(
      applyActorReaction([{ emoji: "👍", count: 1, actorIds: [ME] }], "👍", -1, ME),
    ).toEqual([]);
  });

  it("is idempotent on a repeated remove of the same actor (optimistic + WS echo)", () => {
    const base: ReactionAggregate[] = [{ emoji: "👍", count: 1, actorIds: [OTHER] }];
    // ME never reacted with 👍 → removing ME is a no-op, no negative count.
    const once = applyActorReaction(base, "👍", -1, ME);
    expect(once).toEqual([{ emoji: "👍", count: 1, actorIds: [OTHER] }]);
  });

  it("round-trips: add then rollback (inverse) restores the baseline", () => {
    const baseline: ReactionAggregate[] = [
      { emoji: "🎉", count: 1, actorIds: [OTHER] },
    ];
    const optimistic = applyActorReaction(baseline, "🎉", 1, ME);
    expect(optimistic).toEqual([{ emoji: "🎉", count: 2, actorIds: [OTHER, ME] }]);
    // Rollback on a failed request = inverse delta with the same actor.
    const rolledBack = applyActorReaction(optimistic, "🎉", -1, ME);
    expect(rolledBack).toEqual([{ emoji: "🎉", count: 1, actorIds: [OTHER] }]);
  });

  it("falls back to a blind decrement when actorIds is unknown (truncated aggregate)", () => {
    // No actorIds (server truncated the >25-actor list) → still tracks count.
    const next = applyActorReaction([{ emoji: "👍", count: 9 }], "👍", -1, ME);
    expect(next).toEqual([{ emoji: "👍", count: 8, actorIds: [] }]);
  });

  it("does not mutate the input array or its entries", () => {
    const input: ReactionAggregate[] = [
      { emoji: "👍", count: 1, actorIds: [OTHER] },
    ];
    const snapshot = structuredClone(input);
    applyActorReaction(input, "👍", 1, ME);
    expect(input).toEqual(snapshot);
  });
});
