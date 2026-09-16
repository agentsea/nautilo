/**
 * D212 P4 — locks the conservative emoji-only gate (MR2).
 *
 * If these regress, the "big emoji" render path either misfires on
 * ordinary text (giant surprise messages) or fails to fire on genuine
 * emoji-only sends.
 */
import { describe, expect, test } from "bun:test";
import { isEmojiOnlyMessage, MAX_EMOJI_ONLY } from "../../src/lib/emoji-only";

describe("isEmojiOnlyMessage — positive cases", () => {
  test("single emoji", () => {
    expect(isEmojiOnlyMessage("🎉")).toBe(true);
  });
  test("emoji with surrounding whitespace", () => {
    expect(isEmojiOnlyMessage("  🎉  ")).toBe(true);
  });
  test("emoji separated by spaces", () => {
    expect(isEmojiOnlyMessage("👍 👍")).toBe(true);
  });
  test("exactly MAX_EMOJI_ONLY emoji", () => {
    expect(isEmojiOnlyMessage("👀😄🎉")).toBe(true);
  });
});

describe("isEmojiOnlyMessage — negative cases", () => {
  test("empty string", () => {
    expect(isEmojiOnlyMessage("")).toBe(false);
  });
  test("whitespace only", () => {
    expect(isEmojiOnlyMessage("   \n\t ")).toBe(false);
  });
  test("plain text", () => {
    expect(isEmojiOnlyMessage("hello")).toBe(false);
  });
  test("emoji mixed with text", () => {
    expect(isEmojiOnlyMessage("nice 🎉")).toBe(false);
    expect(isEmojiOnlyMessage("🎉 party")).toBe(false);
  });
  test("over the cap (MAX_EMOJI_ONLY + 1)", () => {
    expect(isEmojiOnlyMessage("👀😄🎉🔥")).toBe(false);
  });
});

describe("isEmojiOnlyMessage — invariants", () => {
  test("MAX_EMOJI_ONLY is 3 (MR2 conservative gate)", () => {
    expect(MAX_EMOJI_ONLY).toBe(3);
  });
  test("idempotent across repeated calls (no leaked regex lastIndex)", () => {
    for (let i = 0; i < 5; i++) {
      expect(isEmojiOnlyMessage("🎉")).toBe(true);
      expect(isEmojiOnlyMessage("nice 🎉")).toBe(false);
    }
  });
});
