import { describe, expect, test } from "bun:test";
import { parseVisionCandidateIds } from "../../src/chat/vision-candidates";

describe("parseVisionCandidateIds", () => {
  test("splits on comma and newline, dedupes, trims", () => {
    expect(parseVisionCandidateIds("a, b\na\nanthropic:x")).toEqual(["a", "b", "anthropic:x"]);
  });
});
