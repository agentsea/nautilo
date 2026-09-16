/**
 * Unit-test classification guard — @nautilo/config.
 *
 * Real-binary OfficeCLI tests belong in the explicit
 * `test:integration:officecli` smoke command, not tests/unit/. Spawning a
 * vendored binary from a unit test fails on hosts where that platform binary
 * is absent or not executable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const SHARED_UNIT_DIR = import.meta.dir;
const SELF = "officecli-spawn-unit-guard.test.ts";
const DESKTOP_OFFICECLI_VENDOR = /apps\/desktop\/vendor\/officecli/;
const BUN_SPAWN_SYNC = /\bBun\.spawnSync\s*\(/;

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

describe("officecli spawn unit-test guard", () => {
  test("no test in shared tests/unit/ spawns the desktop OfficeCLI binary", () => {
    const offenders: string[] = [];
    for (const full of collectTestFiles(SHARED_UNIT_DIR)) {
      const src = readFileSync(full, "utf8");
      if (DESKTOP_OFFICECLI_VENDOR.test(src) || BUN_SPAWN_SYNC.test(src)) {
        offenders.push(relative(SHARED_UNIT_DIR, full));
      }
    }

    expect(
      offenders,
      [
        "",
        "These unit tests reference the desktop OfficeCLI vendor tree or call",
        "Bun.spawnSync(). Real-binary OfficeCLI coverage belongs in the",
        "explicit test:integration:officecli smoke command.",
        "",
        ...offenders.map((f) => `  - tests/unit/${f}`),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
