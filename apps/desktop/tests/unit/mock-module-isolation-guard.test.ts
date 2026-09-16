/**
 * Test-isolation guard — see packages/server/tests/unit/mock-module-isolation-guard.test.ts.
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
        "Fix: move each file to tests/unit-isolated/ (own process).",
        "",
        ...offenders.map((f) => `  - tests/unit/${f}`),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
