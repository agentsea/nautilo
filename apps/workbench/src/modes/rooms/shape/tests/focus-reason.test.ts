import { describe, expect, test } from "bun:test";
import { formatFocusReason, focusTooltipLabel } from "../focus-reason";

describe("formatFocusReason (D299)", () => {
  test("prefers live reason text over source mapping", () => {
    expect(
      formatFocusReason({ source: "inferred", reason: "  replied in thread  " }),
    ).toBe("replied in thread");
  });

  test("maps mention source", () => {
    expect(formatFocusReason({ source: "mention", reason: null })).toBe("@-mentioned");
  });

  test("maps reply source", () => {
    expect(formatFocusReason({ source: "reply", reason: null })).toBe("replied to");
  });

  test("maps ui source", () => {
    expect(formatFocusReason({ source: "ui", reason: null })).toBe("you focused");
  });

  test("maps inferred source", () => {
    expect(formatFocusReason({ source: "inferred", reason: null })).toBe("auto-routed");
  });

  test("returns null when not focused / no metadata", () => {
    expect(formatFocusReason({ source: null, reason: null })).toBeNull();
    expect(formatFocusReason({ source: null, reason: "   " })).toBeNull();
  });
});

describe("focusTooltipLabel (D299)", () => {
  test("joins display name and reason", () => {
    expect(focusTooltipLabel("Jeannie", "auto-routed")).toBe("Jeannie — auto-routed");
  });

  test("returns display name alone when no reason", () => {
    expect(focusTooltipLabel("Jeannie", null)).toBe("Jeannie");
  });
});
