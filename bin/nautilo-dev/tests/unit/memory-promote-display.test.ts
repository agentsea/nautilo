import { describe, expect, test } from "bun:test";
import { truncateContent } from "../../src/commands/memory-promote";

describe("memory promotion display", () => {
  test("distinguishes absent protected content from an ordinary empty body", () => {
    expect(truncateContent(null)).toBe(
      "[Protected content: ordinary representation unavailable]",
    );
    expect(truncateContent("")).toBe("");
  });

  test("preserves ordinary preview formatting", () => {
    expect(truncateContent("  first\n second  ")).toBe("first second");
    expect(truncateContent("abcdef", 3)).toBe("abc…");
  });
});
