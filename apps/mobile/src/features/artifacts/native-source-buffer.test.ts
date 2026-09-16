import { describe, expect, test } from "bun:test";
import {
  clampSelection,
  commitNativeSourceBaseline,
  createNativeSourceBuffer,
  insertMarkdownLink,
  isSupportedMarkdownHref,
  setMarkdownBlockPrefix,
  updateNativeSourceBuffer,
  wrapMarkdown,
} from "./native-source-buffer";

describe("native source buffer", () => {
  test("tracks exact empty and Unicode native updates without history", () => {
    const buffer = createNativeSourceBuffer("東京");
    expect(Object.keys(buffer).sort()).toEqual([
      "baseline",
      "current",
      "selection",
    ]);
    expect(
      updateNativeSourceBuffer(buffer, "東京🫖", { start: 2, end: 4 }),
    ).toBe(true);
    expect(buffer.current).toBe("東京🫖");
    expect(buffer.selection).toEqual({ start: 2, end: 4 });
    expect(updateNativeSourceBuffer(buffer, "")).toBe(true);
    expect(updateNativeSourceBuffer(buffer, "東京")).toBe(false);
  });

  test("retains the qualified large source and long line byte-for-byte", () => {
    const longLine = "λ".repeat(8_000);
    const qualified = `${longLine}\n${"x".repeat(1_200)}`;
    expect(new TextEncoder().encode(qualified).byteLength).toBe(17_201);
    const buffer = createNativeSourceBuffer(qualified);
    expect(buffer.current).toBe(qualified);
    expect(updateNativeSourceBuffer(buffer, `${qualified}!`)).toBe(true);
    expect(buffer.current.slice(0, longLine.length)).toBe(longLine);
  });

  test("normalizes multiline, reversed, and out-of-range native selections", () => {
    const value = "first\nsecond\nthird";
    expect(clampSelection(value, { start: 12, end: 6 })).toEqual({
      start: 6,
      end: 12,
    });
    expect(clampSelection(value, { start: -20, end: 200 })).toEqual({
      start: 0,
      end: value.length,
    });
  });

  test("formatting preserves untouched source and returns exact explicit ranges", () => {
    expect(wrapMarkdown("abc", { start: 3, end: 1 }, "**")).toEqual({
      value: "a**bc**",
      selection: { start: 3, end: 5 },
    });
    expect(wrapMarkdown("abc", { start: 1, end: 1 }, "_")).toEqual({
      value: "a__bc",
      selection: { start: 2, end: 2 },
    });
    expect(
      insertMarkdownLink("before chosen after", { start: 7, end: 13 }),
    ).toEqual({
      value: "before [chosen](https://) after",
      selection: { start: 8, end: 14 },
    });
    expect(insertMarkdownLink("x", { start: 9, end: 9 })).toEqual({
      value: "x[link](https://)",
      selection: { start: 2, end: 6 },
    });
  });

  test("block formatting replaces prefixes idempotently and paragraph resets them", () => {
    expect(
      setMarkdownBlockPrefix(
        "# One\n- Two\n3. Three",
        { start: 0, end: 19 },
        "## ",
      ),
    ).toEqual({
      value: "## One\n## Two\n## Three",
      selection: { start: 3, end: 21 },
    });
    expect(
      setMarkdownBlockPrefix("## One\n## Two", { start: 0, end: 13 }, "## "),
    ).toEqual({
      value: "## One\n## Two",
      selection: { start: 3, end: 13 },
    });
    expect(
      setMarkdownBlockPrefix("## One\n- Two", { start: 0, end: 12 }, ""),
    ).toEqual({
      value: "One\nTwo",
      selection: { start: 0, end: 7 },
    });
  });

  test("block formatting respects exact line boundaries, empty lines, and normalized ranges", () => {
    expect(setMarkdownBlockPrefix("a\nb", { start: 0, end: 2 }, "# ")).toEqual({
      value: "# a\nb",
      selection: { start: 2, end: 4 },
    });
    expect(setMarkdownBlockPrefix("a\nb", { start: 2, end: 2 }, "# ")).toEqual({
      value: "a\n# b",
      selection: { start: 4, end: 4 },
    });
    expect(setMarkdownBlockPrefix("a\n\nb", { start: 2, end: 2 }, "- ")).toEqual({
      value: "a\n- \nb",
      selection: { start: 4, end: 4 },
    });
    expect(setMarkdownBlockPrefix("a\nb", { start: 99, end: -2 }, "# ")).toEqual({
      value: "# a\n# b",
      selection: { start: 2, end: 7 },
    });
  });

  test("Markdown links accept only the bounded Writer-safe href envelope", () => {
    expect(isSupportedMarkdownHref("https://example.com")).toBe(true);
    expect(isSupportedMarkdownHref("mailto:writer@example.com")).toBe(true);
    expect(isSupportedMarkdownHref(" https://example.com")).toBe(false);
    expect(isSupportedMarkdownHref("https://example .com")).toBe(false);
    expect(isSupportedMarkdownHref("https://example.com\u0000")).toBe(false);
    expect(isSupportedMarkdownHref(`https://x/${"a".repeat(2000)}`)).toBe(false);
    expect(isSupportedMarkdownHref("http:")).toBe(false);
    expect(isSupportedMarkdownHref("https:")).toBe(false);
    expect(isSupportedMarkdownHref("mailto:")).toBe(false);
    expect(isSupportedMarkdownHref("javascript:alert(1)")).toBe(false);
  });

  test("committing a save baseline preserves edits made during save", () => {
    const buffer = createNativeSourceBuffer("before");
    updateNativeSourceBuffer(buffer, "saved", { start: 5, end: 5 });
    updateNativeSourceBuffer(buffer, "saved plus", { start: 99, end: 99 });
    expect(commitNativeSourceBaseline(buffer, "saved")).toBe(true);
    expect(buffer).toEqual({
      baseline: "saved",
      current: "saved plus",
      selection: { start: 10, end: 10 },
    });
  });
});
