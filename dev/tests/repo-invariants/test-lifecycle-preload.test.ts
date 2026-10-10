import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const preload = resolve(import.meta.dir, "../test-lifecycle-preload.ts");
const repositoryRoot = resolve(import.meta.dir, "../../..");

test("package-local timer suites load lifecycle support explicitly", () => {
  for (const directory of ["apps/desktop", "apps/cli", "bin/nautilo-dev", "packages/lattice-bridge", "packages/runtime", "packages/reflection"]) {
    const configuration = Bun.TOML.parse(readFileSync(join(repositoryRoot, directory, "bunfig.toml"), "utf8")) as {
      test?: { preload?: string[] };
    };
    expect(configuration.test?.preload).toContain("../../dev/tests/test-lifecycle-preload.ts");
  }
});

test.each([false, true])("test lifecycle settles unref timers and releases the process after failure=%s", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-test-lifecycle-"));
  try {
    const file = join(root, "lifecycle.test.ts");
    writeFileSync(file, `import { afterAll, afterEach, test } from "bun:test";
      afterEach(async () => {
        await new Promise(resolve => { setTimeout(resolve, 5).unref(); });
      });
      afterAll(async () => {
        await new Promise(resolve => { setTimeout(resolve, 5).unref(); });
        console.error("lifecycle teardown settled");
      });
      test("unref timer", async () => {
        await new Promise(resolve => { setTimeout(resolve, 5).unref(); });
      });
      ${failure ? 'test("unsettled promise", () => new Promise(() => {}), 50);' : ""}
    `);
    const result = spawnSync(process.execPath, ["test", "--preload", preload, file], {
      cwd: root, encoding: "utf8", timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(failure ? 1 : 0);
    // Newer Bun releases list only failed tests; the counters are stable.
    expect(result.stderr).not.toContain("(fail) unref timer");
    expect(result.stderr).toMatch(/\b1 pass\b/);
    expect(result.stderr).toContain("lifecycle teardown settled");
    if (failure) expect(result.stderr).toContain("timed out after 50ms");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
