import { describe, expect, test } from "bun:test";
import { deriveSelfEmojis } from "./self-emojis";

describe("deriveSelfEmojis (D312)", () => {
  test("returns emoji when myActorId is in actorIds", () => {
    const reactions = [
      { emoji: "👍", count: 2, actorIds: ["me", "other"] },
      { emoji: "🎉", count: 1, actorIds: ["other"] },
    ];
    expect(deriveSelfEmojis(reactions, "me")).toEqual(new Set(["👍"]));
  });

  test("returns empty set when myActorId is not in any actorIds", () => {
    const reactions = [{ emoji: "👍", count: 1, actorIds: ["other"] }];
    expect(deriveSelfEmojis(reactions, "me")).toEqual(new Set());
  });

  test("skips reactions with missing actorIds", () => {
    const reactions = [
      { emoji: "👍", count: 1 },
      { emoji: "🎉", count: 1, actorIds: ["me"] },
    ];
    expect(deriveSelfEmojis(reactions, "me")).toEqual(new Set(["🎉"]));
  });

  test("returns empty set when myActorId is null or empty", () => {
    const reactions = [{ emoji: "👍", count: 1, actorIds: ["me"] }];
    expect(deriveSelfEmojis(reactions, null)).toEqual(new Set());
    expect(deriveSelfEmojis(reactions, undefined)).toEqual(new Set());
    expect(deriveSelfEmojis(reactions, "")).toEqual(new Set());
  });

  test("returns empty set when reactions is undefined or empty", () => {
    expect(deriveSelfEmojis(undefined, "me")).toEqual(new Set());
    expect(deriveSelfEmojis([], "me")).toEqual(new Set());
  });
});
