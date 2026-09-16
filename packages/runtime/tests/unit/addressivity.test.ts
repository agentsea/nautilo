import { describe, test, expect } from "bun:test";
import type { ConductorContext } from "@nautilo/runtime";
import {
  DEFAULT_ADDRESSIVITY_THRESHOLD,
  scoreAddressivity,
} from "../../src/conductor/addressivity";

function ctx(content: string): ConductorContext {
  return {
    roomId: "room-1",
    userActorId: "user-1",
    message: { content },
    members: [],
    now: new Date(),
  };
}

describe("scoreAddressivity (D302 P3 / R4)", () => {
  test("DEFAULT_ADDRESSIVITY_THRESHOLD is a low fail-open dial", () => {
    expect(DEFAULT_ADDRESSIVITY_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_ADDRESSIVITY_THRESHOLD).toBeLessThanOrEqual(0.25);
  });

  test("clear question scores high with interrogativity signal", () => {
    const result = scoreAddressivity(ctx("Are you available to help?"));
    expect(result.signals["interrogativity"]).toBeGreaterThan(0.5);
    expect(result.score).toBeGreaterThan(DEFAULT_ADDRESSIVITY_THRESHOLD);
    expect(result.bought).toBe(true);
    expect(Object.keys(result.signals).sort()).toEqual([
      "directed",
      "interrogativity",
      "relationalRecency",
    ]);
    expect(typeof result.signals["interrogativity"]).toBe("number");
    expect(typeof result.signals["directed"]).toBe("number");
    expect(typeof result.signals["relationalRecency"]).toBe("number");
  });

  test("wh-question without question mark still scores high", () => {
    const result = scoreAddressivity(ctx("what was that report about"));
    expect(result.signals["interrogativity"]).toBeGreaterThan(0.5);
    expect(result.score).toBeGreaterThan(DEFAULT_ADDRESSIVITY_THRESHOLD);
    expect(result.bought).toBe(true);
  });

  test("flat ambient third-person chatter scores low", () => {
    const result = scoreAddressivity(
      ctx("They were talking about the weather earlier today."),
    );
    expect(result.signals["interrogativity"]).toBe(0);
    expect(result.signals["directed"]).toBeLessThan(0.2);
    expect(result.score).toBeLessThan(DEFAULT_ADDRESSIVITY_THRESHOLD);
    expect(result.bought).toBe(false);
  });

  test("relational-recency raises score for otherwise weak text", () => {
    const without = scoreAddressivity(ctx("hello room"));
    const withRel = scoreAddressivity(ctx("hello room"), {
      hasRecentRelationship: true,
    });
    expect(withRel.signals["relationalRecency"]).toBe(1);
    expect(without.signals["relationalRecency"]).toBe(0);
    expect(withRel.score).toBeGreaterThan(without.score);
  });

  test("second-person directed phrasing boosts directed signal", () => {
    const result = scoreAddressivity(ctx("Could you take a look at this?"));
    expect(result.signals["directed"]).toBeGreaterThan(0.5);
    expect(result.score).toBeGreaterThan(DEFAULT_ADDRESSIVITY_THRESHOLD);
    expect(result.bought).toBe(true);
  });

  test("custom threshold moves the bought boundary", () => {
    const content = "They were talking about the weather earlier today.";
    const lowThreshold = scoreAddressivity(ctx(content), { threshold: 0 });
    const highThreshold = scoreAddressivity(ctx(content), { threshold: 1 });
    expect(lowThreshold.bought).toBe(true);
    expect(highThreshold.bought).toBe(false);
  });
});
