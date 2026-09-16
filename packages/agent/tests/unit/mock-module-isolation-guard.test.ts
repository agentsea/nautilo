/**
 * Test-isolation guard.
 *
 * Bun's `mock.module()` is process-global and STICKY: `mock.restore()` resets
 * spies but does NOT undo a module replacement. So a file in the shared
 * `tests/unit/` process silently swaps a module for every file that loads after
 * it. The same code then passes locally and fails in CI purely on
 * file-discovery order (macOS vs Linux walk the directory differently). We lost
 * hours to exactly this (the D261 TtsService leak).
 *
 * The invariant: any file that calls `mock.module(...)` MUST live in
 * `tests/unit-isolated/`, where `scripts/run-unit.sh` runs it in its own
 * `bun test` process — making the leak structurally impossible. This guard
 * fails the build if a `mock.module(` call sneaks back into the shared dir.
 *
 * The check is anchored to the filesystem (not an allowlist), so the only way
 * to make it pass is to actually move the offending file. See
 * `.cursor/rules/test-mock-isolation.mdc`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const SHARED_UNIT_DIR = import.meta.dir;
const SELF = "mock-module-isolation-guard.test.ts";
// Matches an actual call: `mock.module(`, tolerating whitespace. Plain prose
// mentions of mock.module elsewhere (without the open paren) do not trip it.
const MOCK_MODULE_CALL = /\bmock\s*\.\s*module\s*\(/;

/**
 * Recurse the whole shared tree, not just its top level — `run-unit.sh` globs
 * `tests/unit` recursively (`find tests/unit -name '*.test.ts'`), so a nested
 * `tests/unit/foo/bar.test.ts` also runs in the shared process and must be
 * guarded too.
 */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (ent.name.endsWith(".test.ts") && ent.name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe("mock.module isolation guard", () => {
  test("no test in shared tests/unit/ calls mock.module (move it to tests/unit-isolated/)", () => {
    const offenders: string[] = [];
    for (const full of collectTestFiles(SHARED_UNIT_DIR)) {
      const src = readFileSync(full, "utf8");
      if (MOCK_MODULE_CALL.test(src)) offenders.push(relative(SHARED_UNIT_DIR, full));
    }

    expect(
      offenders,
      [
        "",
        "These files call mock.module() in the SHARED tests/unit/ process.",
        "mock.module() is process-global and sticky in Bun (mock.restore() does",
        "NOT undo it), so they poison every file that loads after them and cause",
        "order-dependent green-local/red-CI failures.",
        "",
        "Fix: move each file to tests/unit-isolated/ (own process). See",
        ".cursor/rules/test-mock-isolation.mdc.",
        "",
        ...offenders.map((f) => `  - tests/unit/${f}`),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
