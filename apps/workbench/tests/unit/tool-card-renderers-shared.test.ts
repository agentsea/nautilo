/**
 * D083 Phase 2b — unit tests for the shared renderer parsers
 * (`shared.ts`). These are the pure helpers the per-tool renderers
 * rely on; the renderers themselves are live-verified in Electron
 * because the workbench doesn't have a jsdom/RTL setup (matches
 * the cited-paths / tool-card-helpers convention).
 */

import { describe, test, expect } from "bun:test";
import {
  pickPath,
  pickZonedPath,
  pickLineRange,
  pickQuery,
  previewLines,
  parseSearchResult,
  parseListResult,
  looksLikeToolError,
} from "../../src/components/tool-card/renderers/shared";

// ---------------------------------------------------------------------------
// Arg pickers
// ---------------------------------------------------------------------------

describe("pickPath (D083 Phase 2b)", () => {
  test("picks 'path' first", () => {
    expect(pickPath({ path: "/tmp/a", file: "/tmp/b" })).toBe("/tmp/a");
  });

  test("falls back through file / filename / target / filepath", () => {
    expect(pickPath({ file: "/a" })).toBe("/a");
    expect(pickPath({ filename: "b" })).toBe("b");
    expect(pickPath({ target: "c" })).toBe("c");
    expect(pickPath({ filepath: "d" })).toBe("d");
  });

  test("returns empty string when no path-shaped key present", () => {
    expect(pickPath({})).toBe("");
    expect(pickPath({ query: "not a path" })).toBe("");
  });

  test("rejects non-string values (defensive against LLM drift)", () => {
    expect(pickPath({ path: 42 as unknown as string })).toBe("");
  });
});

describe("pickZonedPath (D083 Phase 2b)", () => {
  test("prepends zone when present", () => {
    expect(pickZonedPath({ zone: "home", path: "notes.md" })).toBe("home/notes.md");
    expect(pickZonedPath({ zone: "scratch", path: "tmp.txt" })).toBe("scratch/tmp.txt");
  });

  test("omits zone when absent or empty", () => {
    expect(pickZonedPath({ path: "/abs/path" })).toBe("/abs/path");
    expect(pickZonedPath({ zone: "", path: "x" })).toBe("x");
  });

  test("returns empty string when path missing even if zone present", () => {
    expect(pickZonedPath({ zone: "home" })).toBe("");
  });
});

describe("pickLineRange (D083 Phase 2b)", () => {
  test("picks canonical startLine/endLine", () => {
    expect(pickLineRange({ startLine: 10, endLine: 40 })).toEqual({ start: 10, end: 40 });
  });

  test("falls back to start/end", () => {
    expect(pickLineRange({ start: 1, end: 5 })).toEqual({ start: 1, end: 5 });
  });

  test("falls back to fromLine/toLine", () => {
    expect(pickLineRange({ fromLine: 7, toLine: 9 })).toEqual({ start: 7, end: 9 });
  });

  test("returns null when neither side present or types wrong", () => {
    expect(pickLineRange({})).toBe(null);
    expect(pickLineRange({ startLine: "10", endLine: "40" })).toBe(null);
    expect(pickLineRange({ startLine: 10 })).toBe(null); // half-pair
  });
});

describe("pickQuery (D083 Phase 2b)", () => {
  test("picks query > pattern > q > term (in that order)", () => {
    expect(pickQuery({ query: "a", pattern: "b" })).toBe("a");
    expect(pickQuery({ pattern: "b", q: "c" })).toBe("b");
    expect(pickQuery({ q: "c", term: "d" })).toBe("c");
    expect(pickQuery({ term: "d" })).toBe("d");
  });

  test("returns empty string when nothing matches", () => {
    expect(pickQuery({ other: "foo" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// previewLines
// ---------------------------------------------------------------------------

describe("previewLines (D083 Phase 2b)", () => {
  test("returns empty result for empty / non-string input", () => {
    expect(previewLines("", 10)).toEqual({ preview: "", truncated: false, totalLines: 0, shownLines: 0 });
    expect(previewLines(undefined as unknown as string, 10)).toEqual({
      preview: "",
      truncated: false,
      totalLines: 0,
      shownLines: 0,
    });
  });

  test("passes through when within cap (no trailing newline)", () => {
    const r = previewLines("line1\nline2\nline3", 10);
    expect(r.totalLines).toBe(3);
    expect(r.shownLines).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.preview).toBe("line1\nline2\nline3");
  });

  test("strips a single trailing newline from the count (common for file reads)", () => {
    const r = previewLines("a\nb\n", 10);
    expect(r.totalLines).toBe(2);
    expect(r.preview).toBe("a\nb");
  });

  test("truncates with trailing marker when over cap", () => {
    const r = previewLines("a\nb\nc\nd\ne", 3);
    expect(r.totalLines).toBe(5);
    expect(r.shownLines).toBe(3);
    expect(r.truncated).toBe(true);
    expect(r.preview).toBe("a\nb\nc\n… (2 more lines)");
  });

  test("uses singular 'line' for 1 remaining", () => {
    const r = previewLines("a\nb\nc\nd", 3);
    expect(r.preview.endsWith("(1 more line)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSearchResult
// ---------------------------------------------------------------------------

describe("parseSearchResult (D083 Phase 2b)", () => {
  test("undefined input → empty object", () => {
    expect(parseSearchResult(undefined)).toEqual({});
  });

  test("empty string → empty object", () => {
    expect(parseSearchResult("")).toEqual({});
    expect(parseSearchResult("   \n  ")).toEqual({});
  });

  test("canonical 'N matches' header + path:line — preview body", () => {
    const raw = `3 matches for "ToolCard" in home (scanned 127 files):
  home/notes.md:42 — export function ToolCard(
  home/other.md:18 — import { ToolCard } from
  home/third.md:7 — <ToolCard />`;
    const p = parseSearchResult(raw);
    expect(p.header).toContain("3 matches for");
    expect(p.matches).toHaveLength(3);
    expect(p.matches?.[0]).toEqual({
      path: "home/notes.md",
      line: 42,
      preview: "export function ToolCard(",
    });
    expect(p.matches?.[2]?.line).toBe(7);
  });

  test("singular '1 match' header accepted", () => {
    const raw = `1 match for "x" in home:
  home/a.md:1 — preview`;
    const p = parseSearchResult(raw);
    expect(p.matches).toHaveLength(1);
  });

  test("No matches for ... → empty matches array (not raw)", () => {
    const p = parseSearchResult("No matches for \"missing\" in home");
    expect(p.header).toContain("No matches");
    expect(p.matches).toEqual([]);
  });

  test("non-conforming result → raw fallback", () => {
    const raw = "Error: path traversal attempted";
    const p = parseSearchResult(raw);
    expect(p.raw).toBe(raw);
    expect(p.matches).toBeUndefined();
  });

  test("match line missing number → line: null, still emits path", () => {
    const raw = `1 match for "x" in home:
  home/a.md — preview content`;
    const p = parseSearchResult(raw);
    expect(p.matches?.[0]?.path).toBe("home/a.md");
    expect(p.matches?.[0]?.line).toBe(null);
  });

  test("tolerates different dash separators (—, -, :)", () => {
    const raw = `2 matches for "x" in home:
  home/a.md:1 — em-dash
  home/b.md:2 - hyphen`;
    const p = parseSearchResult(raw);
    expect(p.matches).toHaveLength(2);
    expect(p.matches?.[0]?.preview).toBe("em-dash");
    expect(p.matches?.[1]?.preview).toBe("hyphen");
  });
});

// ---------------------------------------------------------------------------
// parseListResult
// ---------------------------------------------------------------------------

describe("parseListResult (D083 Phase 2b)", () => {
  test("undefined / empty → empty or []", () => {
    expect(parseListResult(undefined)).toEqual({});
    expect(parseListResult("")).toEqual({ entries: [] });
  });

  test("JSON array of strings", () => {
    const raw = JSON.stringify(["a.md", "b.txt", "sub/"]);
    const p = parseListResult(raw);
    expect(p.entries).toEqual([
      { name: "a.md", kind: "file" },
      { name: "b.txt", kind: "file" },
      { name: "sub/", kind: "dir" },
    ]);
  });

  test("JSON array of {name, type} objects", () => {
    const raw = JSON.stringify([
      { name: "a.md", type: "file" },
      { name: "docs", type: "dir" },
    ]);
    const p = parseListResult(raw);
    expect(p.entries).toEqual([
      { name: "a.md", kind: "file" },
      { name: "docs", kind: "dir" },
    ]);
  });

  test("newline-separated names", () => {
    const p = parseListResult("a.md\nb.txt\nsub/");
    expect(p.entries).toEqual([
      { name: "a.md", kind: "file" },
      { name: "b.txt", kind: "file" },
      { name: "sub/", kind: "dir" },
    ]);
  });

  test("strips a 'Contents of ...' header line", () => {
    const p = parseListResult("Contents of /tmp:\nfoo\nbar");
    expect(p.entries).toEqual([
      { name: "foo", kind: "file" },
      { name: "bar", kind: "file" },
    ]);
  });

  test("bails to raw when the output looks like English prose, not a listing", () => {
    const raw =
      "I listed /tmp for you. There are a few files in here. Notably, the log file.";
    const p = parseListResult(raw);
    expect(p.entries).toBeUndefined();
    expect(p.raw).toBe(raw);
  });

  test("malformed JSON array falls through to raw (not crashing)", () => {
    const raw = "[not actually json";
    const p = parseListResult(raw);
    expect(p.entries).toBeUndefined();
    expect(p.raw).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// looksLikeToolError
// ---------------------------------------------------------------------------

describe("looksLikeToolError (D083 Phase 2b)", () => {
  test("matches leading 'Error:'", () => {
    expect(looksLikeToolError("Error: path not found")).toBe(true);
    expect(looksLikeToolError("error: same but lowercase")).toBe(true);
  });

  test("does not match mid-string 'Error'", () => {
    expect(looksLikeToolError("no errors here")).toBe(false);
    expect(looksLikeToolError("the word error appears")).toBe(false);
  });

  test("handles undefined / empty gracefully", () => {
    expect(looksLikeToolError(undefined)).toBe(false);
    expect(looksLikeToolError("")).toBe(false);
  });

  test("tolerates leading whitespace", () => {
    expect(looksLikeToolError("  Error: thing")).toBe(true);
  });
});
