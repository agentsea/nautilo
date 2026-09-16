import { describe, expect, test } from "bun:test";

import { clampSoulPreview } from "../../src/components/soul-preview";

describe("ContextPanel helpers", () => {
  test("clampSoulPreview compacts whitespace and truncates long souls", () => {
    expect(clampSoulPreview("one\n\n two   three", 100)).toBe("one two three");
    expect(clampSoulPreview("a".repeat(20), 8)).toBe("aaaaaaaa…");
  });
});
