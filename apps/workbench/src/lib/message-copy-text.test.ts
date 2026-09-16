import { describe, expect, test } from "bun:test";
import { extractFullMessageText } from "./message-copy-text";

describe("extractFullMessageText", () => {
  test("returns empty string for non-array content", () => {
    expect(extractFullMessageText(null)).toBe("");
    expect(extractFullMessageText(undefined)).toBe("");
    expect(extractFullMessageText("hello")).toBe("");
  });

  test("returns the single text part unchanged", () => {
    expect(extractFullMessageText([{ type: "text", text: "just one" }])).toBe("just one");
  });

  // The load-bearing assertion vs. the first-part-only `extractMessageText`:
  // a no-op that returned only the first part would produce "first" and fail here.
  test("joins ALL text parts (not just the first) with a blank line", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "tool-call", toolName: "search" },
      { type: "text", text: "second" },
    ];
    expect(extractFullMessageText(content)).toBe("first\n\nsecond");
  });

  test("skips malformed / non-text parts", () => {
    const content = [
      null,
      "raw-string",
      { type: "text" },
      { type: "text", text: 42 },
      { type: "image", url: "x" },
      { type: "text", text: "kept" },
    ];
    expect(extractFullMessageText(content)).toBe("kept");
  });

  test("empty array yields empty string", () => {
    expect(extractFullMessageText([])).toBe("");
  });
});
