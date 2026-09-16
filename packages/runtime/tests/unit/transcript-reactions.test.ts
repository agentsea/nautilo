import { describe, expect, test } from "bun:test";

import { formatTranscriptLine } from "../../src/conductor/transcript-format";

const ts = new Date("2026-06-01T13:02:11Z");

const baseLine = {
  displayName: "Sender",
  handle: "sender",
  ts,
  content: "hello",
};

describe("formatTranscriptLine reactions (M121)", () => {
  test("formats multi-emoji counts; omits ×1", () => {
    const out = formatTranscriptLine({
      ...baseLine,
      reactions: [
        { emoji: "👀", count: 2 },
        { emoji: "🎉", count: 1 },
      ],
    });
    expect(out.endsWith("  ·reactions: 👀×2 🎉")).toBe(true);
  });

  test("no reactions field — byte-identical baseline line", () => {
    const out = formatTranscriptLine(baseLine);
    expect(out).toBe("[2026-06-01T13:02:11Z] Sender (@sender): hello");
  });

  test("empty reactions array — no suffix", () => {
    const out = formatTranscriptLine({ ...baseLine, reactions: [] });
    expect(out).toBe("[2026-06-01T13:02:11Z] Sender (@sender): hello");
  });

  test("single reaction count 1 — emoji only in suffix", () => {
    const out = formatTranscriptLine({
      ...baseLine,
      reactions: [{ emoji: "👍", count: 1 }],
    });
    expect(out.endsWith("  ·reactions: 👍")).toBe(true);
  });

  test("reaction suffix is count-only (no actor ids or handles)", () => {
    const out = formatTranscriptLine({
      ...baseLine,
      reactions: [
        { emoji: "👀", count: 3 },
        { emoji: "🔥", count: 2 },
      ],
    });
    const suffix = out.slice(out.indexOf("·reactions:"));
    expect(suffix).not.toMatch(/actor/i);
    expect(suffix).not.toContain("@");
    expect(suffix).not.toContain("sender");
    expect(suffix).toMatch(/^·reactions: (👀×3|🔥×2)( (👀×3|🔥×2))?$/);
  });
});
