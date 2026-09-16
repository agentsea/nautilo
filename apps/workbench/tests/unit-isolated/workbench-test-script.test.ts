import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKBENCH_ROOT = join(import.meta.dir, "../..");
const packageJson = JSON.parse(
  readFileSync(join(WORKBENCH_ROOT, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("workbench test scripts (Stack 198)", () => {
  test("default test composes isolated unit + integration suites", () => {
    const scripts = packageJson.scripts ?? {};
    expect(scripts.test).toBe("bun run test:unit && bun run test:integration");
  });

  test("test:unit uses the per-file isolated runner", () => {
    const scripts = packageJson.scripts ?? {};
    expect(scripts["test:unit"]).toBe("bun run scripts/run-unit-isolated.ts");
  });

  test("default test does not invoke broad unisolated bun test", () => {
    const scripts = packageJson.scripts ?? {};
    const testScript = scripts.test ?? "";
    expect(/\bbun\s+test\b/.test(testScript)).toBe(false);
  });
});
