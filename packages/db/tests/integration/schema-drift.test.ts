import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

describe("schema drift guard", () => {
  test("drizzle-kit check reports schema aligned with committed migrations", () => {
    const dbPkgRoot = join(import.meta.dirname, "../..");
    execSync("bun run db:check", {
      cwd: dbPkgRoot,
      stdio: "pipe",
    });
    expect(true).toBe(true);
  });
});
