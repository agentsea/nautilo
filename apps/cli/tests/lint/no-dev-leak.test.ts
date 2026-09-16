import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const distIndex = join(import.meta.dirname, "..", "..", "dist", "index.js");

test("published CLI bundle does not reference nautilo-dev paths", () => {
  if (!existsSync(distIndex)) {
    throw new Error("run bun run build in apps/cli before this lint test");
  }
  const src = readFileSync(distIndex, "utf8");
  expect(src.includes("bin/nautilo-dev")).toBe(false);
  expect(src.includes("nautilo-dev/")).toBe(false);
});
