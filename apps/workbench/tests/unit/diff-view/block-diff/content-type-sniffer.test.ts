import { describe, expect, test } from "bun:test";
import { pickDiffAlgo } from "../../../../src/components/diff-view/block-diff/content-type-sniffer";

describe("pickDiffAlgo", () => {
  test("code-like tags → chars", () => {
    expect(pickDiffAlgo("script")).toBe("chars");
    expect(pickDiffAlgo("SCRIPT")).toBe("chars");
    expect(pickDiffAlgo("style")).toBe("chars");
    expect(pickDiffAlgo("pre")).toBe("chars");
    expect(pickDiffAlgo("code")).toBe("chars");
  });

  test("prose-like tags → wordsWithSpace", () => {
    expect(pickDiffAlgo("p")).toBe("wordsWithSpace");
    expect(pickDiffAlgo("li")).toBe("wordsWithSpace");
    expect(pickDiffAlgo("nw-slide")).toBe("wordsWithSpace");
    expect(pickDiffAlgo("div")).toBe("wordsWithSpace");
  });
});
