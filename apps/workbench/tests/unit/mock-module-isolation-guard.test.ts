/**
 * Test-isolation guard.
 *
 * Bun's `mock.module()` is process-global and sticky: `mock.restore()` resets
 * spies but does not undo module replacements. Any test that calls it must
 * live in `tests/unit-isolated/`, where `scripts/run-unit.sh` gives it its own
 * Bun process.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const SHARED_UNIT_DIR = import.meta.dir;
const SELF = "mock-module-isolation-guard.test.ts";
const MOCK_MODULE_CALL = /\bmock\s*\.\s*module\s*\(/;

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (
      (ent.name.endsWith(".test.ts") || ent.name.endsWith(".test.tsx")) &&
      ent.name !== SELF
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("mock.module isolation guard", () => {
  test("no shared unit test calls mock.module (move it to tests/unit-isolated/)", () => {
    const offenders = collectTestFiles(SHARED_UNIT_DIR)
      .filter((full) => MOCK_MODULE_CALL.test(readFileSync(full, "utf8")))
      .map((full) => relative(SHARED_UNIT_DIR, full));

    expect(
      offenders,
      [
        "",
        "These files call mock.module() in the shared tests/unit/ process.",
        "mock.module() is process-global and sticky in Bun, so it poisons files",
        "that load after it and causes order-dependent green-local/red-CI failures.",
        "",
        "Fix: move each file to tests/unit-isolated/ (one process per file).",
        "",
        ...offenders.map((file) => `  - tests/unit/${file}`),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
