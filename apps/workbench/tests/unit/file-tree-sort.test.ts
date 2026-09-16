import { describe, expect, test } from "bun:test";
import {
  compareEntries,
  type FileSortConfig,
} from "../../src/components/browser-column/file-tree-view";

type TestEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  expanded: boolean;
  childrenPaths: string[] | null;
  mtimeMs?: number;
  sizeBytes?: number;
};

function file(name: string, extra: Partial<TestEntry> = {}): TestEntry {
  return { name, path: `/r/${name}`, type: "file", expanded: false, childrenPaths: null, ...extra };
}
function dir(name: string, extra: Partial<TestEntry> = {}): TestEntry {
  return {
    name,
    path: `/r/${name}`,
    type: "directory",
    expanded: false,
    childrenPaths: null,
    ...extra,
  };
}

function sortNames(entries: TestEntry[], cfg: FileSortConfig): string[] {
  // structuredClone-free copy so the input order can't bias the result
  return [...entries].sort((a, b) => compareEntries(a, b, cfg)).map((e) => e.name);
}

describe("compareEntries", () => {
  test("name asc is case-insensitive-ish via localeCompare and folders pin on top", () => {
    const cfg: FileSortConfig = { mode: "name", dir: "asc", foldersFirst: true };
    const out = sortNames([file("zebra.txt"), dir("Archive"), file("alpha.md")], cfg);
    expect(out).toEqual(["Archive", "alpha.md", "zebra.txt"]);
  });

  test("name desc reverses the field but folders still pin on top", () => {
    const cfg: FileSortConfig = { mode: "name", dir: "desc", foldersFirst: true };
    const out = sortNames([file("a.txt"), dir("Zdir"), dir("Adir"), file("b.txt")], cfg);
    // Directories first (reversed among themselves), then files reversed.
    expect(out).toEqual(["Zdir", "Adir", "b.txt", "a.txt"]);
  });

  test("foldersFirst=false interleaves dirs and files by the chosen field", () => {
    const cfg: FileSortConfig = { mode: "name", dir: "asc", foldersFirst: false };
    const out = sortNames([file("b.txt"), dir("a-dir"), file("c.txt")], cfg);
    expect(out).toEqual(["a-dir", "b.txt", "c.txt"]);
  });

  test("modified sort orders by mtimeMs", () => {
    const cfg: FileSortConfig = { mode: "modified", dir: "asc", foldersFirst: false };
    const out = sortNames(
      [file("new.txt", { mtimeMs: 300 }), file("old.txt", { mtimeMs: 100 }), file("mid.txt", { mtimeMs: 200 })],
      cfg,
    );
    expect(out).toEqual(["old.txt", "mid.txt", "new.txt"]);
    const desc = sortNames(
      [file("new.txt", { mtimeMs: 300 }), file("old.txt", { mtimeMs: 100 }), file("mid.txt", { mtimeMs: 200 })],
      { ...cfg, dir: "desc" },
    );
    expect(desc).toEqual(["new.txt", "mid.txt", "old.txt"]);
  });

  test("size sort orders by sizeBytes", () => {
    const cfg: FileSortConfig = { mode: "size", dir: "asc", foldersFirst: false };
    const out = sortNames(
      [file("big", { sizeBytes: 900 }), file("small", { sizeBytes: 10 }), file("mid", { sizeBytes: 100 })],
      cfg,
    );
    expect(out).toEqual(["small", "mid", "big"]);
  });

  test("equal field values fall back to name as a stable tiebreaker", () => {
    const cfg: FileSortConfig = { mode: "modified", dir: "asc", foldersFirst: false };
    const out = sortNames(
      [file("c.txt", { mtimeMs: 100 }), file("a.txt", { mtimeMs: 100 }), file("b.txt", { mtimeMs: 100 })],
      cfg,
    );
    expect(out).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("missing mtime/size (pre-bridge-rebuild) degrade to 0 and sort by name tiebreak, not crash", () => {
    const cfg: FileSortConfig = { mode: "size", dir: "asc", foldersFirst: false };
    const out = sortNames([file("b.txt"), file("a.txt")], cfg);
    expect(out).toEqual(["a.txt", "b.txt"]);
  });
});
