import { describe, expect, test } from "bun:test";
import { searchLocalExecutionOutput } from "../../electron/local-execution-search";

function search(text: string, literal: string, options: {
  cursor?: number; availableFrom?: number; settled?: boolean;
} = {}) {
  const output = Buffer.from(text);
  return searchLocalExecutionOutput({ output, produced: (options.availableFrom ?? 0) + output.length,
    cursor: options.cursor ?? 0, literal, settled: options.settled ?? false });
}

describe("literal retained execution output search", () => {
  test("finds literal punctuation rather than a regular expression", () => {
    expect(search("a.*b\n", ".*").matchedAt).toBe(1);
    expect(search("ab\n", ".*", { settled: true }).complete).toBe(true);
  });

  test("reports absolute UTF-8 byte offsets and advances one complete code point", () => {
    const first = search("α😀β😀β", "😀β");
    expect(first.matchedAt).toBe(2);
    expect(first.nextSearchCursor).toBe(6);
    expect(first.complete).toBe(false);
    expect(search("α😀β😀β", "😀β", { cursor: first.nextSearchCursor }).matchedAt).toBe(8);
  });

  test("returns overlapping matches without repeating a match", () => {
    let cursor = 0;
    const matches: number[] = [];
    for (;;) {
      const result = search("banana", "ana", { cursor, settled: true });
      cursor = result.nextSearchCursor;
      if (result.matchedAt === null) { expect(result.complete).toBe(true); break; }
      expect(result.complete).toBe(false);
      matches.push(result.matchedAt);
    }
    expect(matches).toEqual([1, 3]);
  });

  test("an open miss preserves a candidate crossing the next append", () => {
    const first = search("prefix ab", "abcd");
    expect(first.matchedAt).toBeNull();
    expect(first.complete).toBe(false);
    expect(search("prefix abcd", "abcd", { cursor: first.nextSearchCursor }).matchedAt).toBe(7);
  });

  test("cross-append multibyte candidates never resume inside a code point", () => {
    const first = search("α😀", "😀β");
    expect(first.nextSearchCursor).toBe(2);
    expect(search("α😀β", "😀β", { cursor: first.nextSearchCursor }).matchedAt).toBe(2);
  });

  test("empty output and misses are incomplete while the process is open", () => {
    expect(search("", "needle")).toMatchObject({ matchedAt: null, nextSearchCursor: 0, complete: false });
    expect(search("needleless", "absent", { settled: true })).toMatchObject({ matchedAt: null,
      nextSearchCursor: 10, complete: true });
    expect(search("needle", "needle", { settled: true }).complete).toBe(false);
  });

  test("continuation cannot regress below the requested cursor or retained head", () => {
    expect(search("α😀", "long literal", { cursor: 6 }).nextSearchCursor).toBe(6);
    expect(search("β", "long literal", { availableFrom: 10 })).toMatchObject({ gap: true,
      availableFrom: 10, produced: 12, nextSearchCursor: 10 });
  });

  test("evicted candidates disclose a gap even when the retained suffix is exhausted", () => {
    const result = search("tail", "missing", { availableFrom: 20, cursor: 0, settled: true });
    expect(result).toEqual({ matchedAt: null, nextSearchCursor: 24, complete: true,
      gap: true, availableFrom: 20, produced: 24 });
    expect(search("target", "target", { availableFrom: 20 })).toMatchObject({ matchedAt: 20, gap: true });
  });

  test("never misses a cross-append candidate for every character boundary", () => {
    const text = "α😀β😀β雪banana.*";
    for (const literal of ["α😀", "😀β", "β😀β雪", "雪banana", "ana", ".*", "absent"]) {
      for (let chars = 0; chars <= [...text].length; chars += 1) {
        const prefix = [...text].slice(0, chars).join("");
        const first = search(prefix, literal);
        if (first.matchedAt !== null) continue;
        const expectedIndex = text.indexOf(literal);
        const expected = expectedIndex < 0 ? null : Buffer.byteLength(text.slice(0, expectedIndex));
        expect(search(text, literal, { cursor: first.nextSearchCursor }).matchedAt).toBe(expected);
      }
    }
  });

  test("does not mutate its only retained output buffer", () => {
    const output = Buffer.from("one target two");
    const original = Buffer.from(output);
    const result = searchLocalExecutionOutput({ output, produced: output.length, cursor: 0,
      literal: "target", settled: true });
    expect(result.matchedAt).toBe(4);
    expect(output.equals(original)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["availableFrom", "complete", "gap", "matchedAt", "nextSearchCursor", "produced"]);
  });

  test("rejects empty or malformed literals and invalid byte coordinates", () => {
    for (const literal of ["", "\ud800", "\udc00", "ok\ud800bad"]) {
      expect(() => search("text", literal)).toThrow("SEARCH_INVALID");
    }
    for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 5]) {
      expect(() => search("text", "x", { cursor })).toThrow("SEARCH_INVALID");
    }
    expect(() => search("😀", "x", { cursor: 1 })).toThrow("CURSOR_INVALID");
    expect(() => searchLocalExecutionOutput({ output: Buffer.from("text"), produced: 3,
      cursor: 0, literal: "x", settled: false })).toThrow("SEARCH_INVALID");
  });
});
