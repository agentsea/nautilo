import { describe, expect, test } from "bun:test";

import { EMOJI_MAX_LENGTH, isValidEmojiString } from "../../src/emoji";

describe("isValidEmojiString", () => {
  test("EMOJI_MAX_LENGTH is 32", () => {
    expect(EMOJI_MAX_LENGTH).toBe(32);
  });

  test("accepts single emoji and ZWJ family sequences", () => {
    expect(isValidEmojiString("🎉")).toBe(true);
    expect(isValidEmojiString("👩‍👩‍👧‍👦")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidEmojiString("")).toBe(false);
  });

  test("rejects over max length", () => {
    expect(isValidEmojiString("a".repeat(33))).toBe(false);
  });

  test("rejects control characters", () => {
    expect(isValidEmojiString("\u0000")).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(isValidEmojiString(123)).toBe(false);
    expect(isValidEmojiString(null)).toBe(false);
  });
});
