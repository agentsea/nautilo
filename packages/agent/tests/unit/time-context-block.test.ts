import { describe, expect, test } from "bun:test";
import { buildTimeContextBlock, TIME_CONTEXT_HEADER } from "../../src/prompts/templates";

describe("buildTimeContextBlock", () => {
  const nowMs = Date.parse("2026-05-09T15:58:00Z");

  test("includes header, IANA tz name, UTC offset, and UTC ISO", () => {
    const block = buildTimeContextBlock({
      nowMs,
      userTimezone: "Europe/Athens",
      previousUserMessageAt: null,
    });
    expect(block.startsWith(TIME_CONTEXT_HEADER)).toBe(true);
    expect(block).toContain("Europe/Athens");
    expect(block).toContain("UTC+03:00");
    expect(block).toContain("UTC: 2026-05-09T15:58:00.000Z");
  });

  test("null previousUserMessageAt -> first-message line", () => {
    const block = buildTimeContextBlock({
      nowMs,
      userTimezone: "UTC",
      previousUserMessageAt: null,
    });
    expect(block).toContain("Last user message in this room: (this is the first message)");
  });

  test("bucketed elapsed line for a prior message", () => {
    const block = buildTimeContextBlock({
      nowMs,
      userTimezone: "UTC",
      previousUserMessageAt: new Date(nowMs - 3 * 3_600_000).toISOString(),
    });
    expect(block).toContain("Last user message in this room: 3 hours ago");
  });
});
