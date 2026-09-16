import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const unitDirectory = import.meta.dir;

function unitTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return unitTestFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("Runtime shared-process unit isolation", () => {
  test("keeps process-global Bun module mocks in unit-isolated", () => {
    const offenders = unitTestFiles(unitDirectory)
      .filter((path) => path !== import.meta.path)
      .filter((path) => readFileSync(path, "utf8").includes("mock.module("))
      .map((path) => path.slice(unitDirectory.length + 1))
      .sort();

    expect(offenders).toEqual([]);
  });
});
