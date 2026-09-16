import { describe, expect, test } from "bun:test";

import {
  filterMobileEmoji,
  MOBILE_EMOJI_CATALOGUE,
  MOBILE_EMOJI_CATEGORIES,
  recordRecentEmoji,
} from "./mobile-emoji-catalogue";

describe("mobile emoji catalogue", () => {
  test("bundles a comprehensive categorized offline catalogue", () => {
    expect(MOBILE_EMOJI_CATALOGUE.length).toBeGreaterThan(1_500);
    expect(MOBILE_EMOJI_CATEGORIES.length).toBe(9);
    expect(MOBILE_EMOJI_CATALOGUE.some((entry) => entry.emoji === "🧭")).toBe(true);
  });

  test("searches human names and respects a selected category", () => {
    expect(filterMobileEmoji("compass", null).map((entry) => entry.emoji)).toContain("🧭");
    expect(filterMobileEmoji("heart", "animals_nature")).toEqual([]);
  });

  test("keeps bounded, unique most-recent choices", () => {
    const initial = Array.from({ length: 24 }, (_, index) => `emoji-${index}`);
    const next = recordRecentEmoji(initial, "emoji-12");
    expect(next[0]).toBe("emoji-12");
    expect(next).toHaveLength(24);
    expect(next.filter((entry) => entry === "emoji-12")).toHaveLength(1);
  });
});
