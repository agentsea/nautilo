import { describe, expect, test } from "bun:test";
import {
  applyAnchoredSplice,
  deriveAnchoredEdit,
  findAnchorMatches,
} from "../../src/tools/file/anchor";

describe("deriveAnchoredEdit", () => {
  test("single-line replace derives a whole-line anchor", () => {
    const edit = deriveAnchoredEdit("hello world\n", "hello there\n");
    expect(edit).toEqual({
      oldString: "hello world\n",
      newString: "hello there\n",
    });
  });

  test("keeps the first whole-line span that is unique", () => {
    const original = "section A\nsame\nold\n\nsection B\nsame\nold\n";
    const updated = "section A\nsame\nnew\n\nsection B\nsame\nold\n";
    const edit = deriveAnchoredEdit(original, updated);
    expect(edit?.oldString).toBe("same\nold\n\n");
    expect(edit?.newString).toBe("same\nnew\n\n");
  });

  test("pure insertion anchors on surrounding lines", () => {
    const edit = deriveAnchoredEdit("a\nb\n", "a\ninserted\nb\n");
    expect(edit).toEqual({
      oldString: "a\nb\n",
      newString: "a\ninserted\nb\n",
    });
  });

  test("insertion at BOF uses one-sided context", () => {
    const edit = deriveAnchoredEdit("body\n", "title\nbody\n");
    expect(edit).toEqual({
      oldString: "body\n",
      newString: "title\nbody\n",
    });
  });

  test("insertion at EOF uses one-sided context", () => {
    const edit = deriveAnchoredEdit("body\n", "body\nfooter\n");
    expect(edit).toEqual({
      oldString: "body\n",
      newString: "body\nfooter\n",
    });
  });

  test("multi-region edit becomes one earliest-to-latest span", () => {
    const edit = deriveAnchoredEdit("a\nb\nc\nd\n", "A\nb\nC\nd\n");
    expect(edit).toEqual({
      oldString: "a\nb\nc\n",
      newString: "A\nb\nC\n",
    });
  });

  test("duplicated block expands to a unique whole-line span", () => {
    const original = "one\nrepeat\nvalue\n\none\nrepeat\nvalue\n";
    const updated = "one\nrepeat\nVALUE\n\none\nrepeat\nvalue\n";
    const edit = deriveAnchoredEdit(original, updated);
    expect(edit?.oldString).toBe("repeat\nvalue\n\n");
    expect(edit?.newString).toBe("repeat\nVALUE\n\n");
  });

  test("empty original falls back to snapshot apply", () => {
    expect(deriveAnchoredEdit("", "created\n")).toBeNull();
  });
});

describe("applyAnchoredSplice", () => {
  test("applies a unique anchor", () => {
    const result = applyAnchoredSplice("a\nb\nc\n", {
      oldString: "b\n",
      newString: "B\n",
    });
    expect(result).toEqual({ ok: true, text: "a\nB\nc\n" });
  });

  test("reports not_found when the anchor changed", () => {
    const result = applyAnchoredSplice("a\nB\nc\n", {
      oldString: "b\n",
      newString: "B\n",
    });
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  test("reports ambiguous when the anchor is no longer unique", () => {
    const result = applyAnchoredSplice("a\nb\nb\n", {
      oldString: "b\n",
      newString: "B\n",
    });
    expect(result).toEqual({ ok: false, kind: "ambiguous" });
  });

  test("replaceAll replaces every scoped occurrence", () => {
    const result = applyAnchoredSplice("foo\nbar\nfoo\n", {
      oldString: "foo",
      newString: "baz",
      replaceAll: true,
      scope: { from: 1, to: 3 },
    });
    expect(result).toEqual({ ok: true, text: "baz\nbar\nbaz\n" });
  });

  test("findAnchorMatches returns every match offset in the window", () => {
    expect(findAnchorMatches("foo\nbar\nfoo\n", "foo", 0, 12)).toEqual([0, 8]);
  });
});
