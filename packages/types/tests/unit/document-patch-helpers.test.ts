import { describe, expect, test } from "bun:test";
import {
  applyAnchoredTextPatch,
  deriveExactAnchoredTextPatch,
  deriveAnchoredTextPatch,
  findAnchorMatches,
  sha256HexForText,
} from "../../src/document-patch-helpers";

describe("deriveAnchoredTextPatch", () => {
  test("single-line replace derives a whole-line anchor", () => {
    const patch = deriveAnchoredTextPatch("hello world\n", "hello there\n");
    expect(patch).toEqual({
      kind: "anchored_text",
      oldString: "hello world\n",
      newString: "hello there\n",
    });
  });

  test("keeps the first whole-line span that is unique", () => {
    const original = "section A\nsame\nold\n\nsection B\nsame\nold\n";
    const updated = "section A\nsame\nnew\n\nsection B\nsame\nold\n";
    const patch = deriveAnchoredTextPatch(original, updated);
    expect(patch?.oldString).toBe("same\nold\n\n");
    expect(patch?.newString).toBe("same\nnew\n\n");
  });

  test("empty original returns null", () => {
    expect(deriveAnchoredTextPatch("", "created\n")).toBeNull();
  });
});

describe("applyAnchoredTextPatch", () => {
  test("applies a unique anchor on exact base", () => {
    const patch = deriveAnchoredTextPatch("a\nb\nc\n", "a\nB\nc\n")!;
    const result = applyAnchoredTextPatch("a\nb\nc\n", patch);
    expect(result).toEqual({ ok: true, text: "a\nB\nc\n" });
  });

  test("stale-compatible rebase when anchor still unique", () => {
    const patch = deriveAnchoredTextPatch("a\nb\nc\n", "a\nB\nc\n")!;
    const result = applyAnchoredTextPatch("prefix\na\nb\nc\n", patch);
    expect(result).toEqual({ ok: true, text: "prefix\na\nB\nc\n" });
  });

  test("missing anchor rejects", () => {
    const result = applyAnchoredTextPatch("a\nB\nc\n", {
      kind: "anchored_text",
      oldString: "b\n",
      newString: "B\n",
    });
    expect(result).toEqual({ ok: false, reason: "anchor_not_found" });
  });

  test("ambiguous anchor rejects", () => {
    const result = applyAnchoredTextPatch("a\nb\nb\n", {
      kind: "anchored_text",
      oldString: "b\n",
      newString: "B\n",
    });
    expect(result).toEqual({ ok: false, reason: "anchor_ambiguous" });
  });

  test("replaceAll replaces every scoped occurrence", () => {
    const result = applyAnchoredTextPatch("foo\nbar\nfoo\n", {
      kind: "anchored_text",
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

describe("deriveExactAnchoredTextPatch", () => {
  test("keeps the compact candidate when it exactly reconstructs the updated text", () => {
    expect(deriveExactAnchoredTextPatch("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      kind: "anchored_text",
      oldString: "b\n",
      newString: "B\n",
    });
  });

  test("uses a whole-document optimistic fallback for a partial candidate", () => {
    const original = "a\n\n\n\nb\n";
    const updated = "A\n\n \n\nb\n";
    const candidate = deriveAnchoredTextPatch(original, updated)!;
    const patch = deriveExactAnchoredTextPatch(original, updated)!;

    expect(applyAnchoredTextPatch(original, candidate)).not.toEqual({ ok: true, text: updated });
    expect(patch).toEqual({
      kind: "anchored_text",
      oldString: original,
      newString: updated,
    });
    expect(applyAnchoredTextPatch(original, patch)).toEqual({ ok: true, text: updated });
    expect(applyAnchoredTextPatch("prefix\n" + original, patch)).toEqual({
      ok: true,
      text: "prefix\n" + updated,
    });
  });

  test("preserves the existing empty-original behavior", () => {
    expect(deriveExactAnchoredTextPatch("", "created\n")).toBeNull();
  });
});

describe("sha256HexForText", () => {
  test("returns stable hex digest", async () => {
    const a = await sha256HexForText("hello");
    const b = await sha256HexForText("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
