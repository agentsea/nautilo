/**
 * M107 — guard test: HANDLE_RE has exactly one source of truth in
 * `@nautilo/types`, and every consumer module re-exports / re-uses
 * that constant rather than re-inlining its own regex.
 *
 * If this test fails because you added a new HANDLE_RE inline
 * somewhere, replace the inline regex with
 * `import { HANDLE_RE } from "@nautilo/types"` instead of weakening
 * this test.
 *
 * The list below tracks the modules the M107 design touches. New
 * client/CLI surfaces that validate handles should:
 *   1. Import `HANDLE_RE` from `@nautilo/types`.
 *   2. Add their path to this test's grep allow-list if they need
 *      to literally write `HANDLE_RE` in source (e.g. re-export).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HANDLE_RE, isValidHandle, normalizeHandle } from "@nautilo/types";

describe("HANDLE_RE (shared)", () => {
  test("accepts canonical handles", () => {
    for (const h of ["bob", "alice", "user_42", "abc", "x_".padEnd(30, "a")]) {
      expect(HANDLE_RE.test(h)).toBe(true);
    }
  });

  test("rejects too-short, too-long, capital, leading-digit, leading-underscore, and special-char inputs", () => {
    for (const h of [
      "ab", // too short (2)
      "a".repeat(31), // too long
      "1bob", // leading digit
      "_bob", // leading underscore
      "Bob", // uppercase
      "bob!", // special char
      "bo b", // space
      "", // empty
    ]) {
      expect(HANDLE_RE.test(h)).toBe(false);
    }
  });

  test("normalizeHandle trims + lowercases without otherwise transforming", () => {
    expect(normalizeHandle("  Bob ")).toBe("bob");
    expect(normalizeHandle("Alice_42")).toBe("alice_42");
  });

  test("isValidHandle uses HANDLE_RE after normalization", () => {
    expect(isValidHandle("  Bob ")).toBe(true);
    expect(isValidHandle("1nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// "Only one source" guard — scan the repo for handle-shaped regex
// literals outside @nautilo/types/src/handle.ts and assert each
// remaining occurrence comes with an `import { HANDLE_RE } from
// "@nautilo/types"` in the same file.
// ---------------------------------------------------------------------

const REPO_ROOT = (() => {
  // jump from packages/server/tests/unit → repo root
  return join(import.meta.dir, "..", "..", "..", "..");
})();

const SCAN_ROOTS = [
  join(REPO_ROOT, "apps"),
  join(REPO_ROOT, "packages"),
  join(REPO_ROOT, "bin"),
];

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "out",
  "tests", // tests may keep example regexes for documentation; the guard test itself contains a literal
  "__fixtures__",
]);

// Substrings that mean a file inlines its own handle regex. Both
// pre-M107 variants are covered so a regression to the looser
// `[a-z0-9_]{3,32}` shape also fails.
const HANDLE_REGEX_LITERALS = [
  "/^[a-z][a-z0-9_]{2,29}$/",
  "/^[a-z0-9_]{3,32}$/",
];

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (
      st.isFile() &&
      (full.endsWith(".ts") || full.endsWith(".tsx"))
    ) {
      yield full;
    }
  }
}

describe("HANDLE_RE — single source of truth", () => {
  test("no source file (outside packages/types/src/handle.ts) inlines a handle regex literal", () => {
    const allowed = new Set<string>([
      join(REPO_ROOT, "packages", "types", "src", "handle.ts"),
    ]);
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        if (allowed.has(file)) continue;
        let body: string;
        try {
          body = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (HANDLE_REGEX_LITERALS.some((lit) => body.includes(lit))) {
          offenders.push(file.slice(REPO_ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
