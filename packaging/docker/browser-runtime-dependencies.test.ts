import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf8");
const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime\n"))
  .replace(/\\\r?\n\s*/gu, " ");

describe("headless browser runtime dependency closure", () => {
  test("excludes unused CUPS while retaining native browser linkage checks", () => {
    const installs = runtime.split(/&&|\n/u).filter((line) => line.includes("apt-get install"));
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).not.toMatch(/\blibcups2t64\b/u);
    expect(runtime).toContain("/opt/nautilo/chromium/chrome-headless-shell /opt/nautilo/chromium/*.so /opt/nautilo/chromium/*.so.1");
    expect(runtime).toContain('ldd "$binary" > /tmp/chromium-linkage.txt ||');
    expect(runtime).toContain("if grep -F 'not found' /tmp/chromium-linkage.txt; then exit 1; fi");
  });

  test("the actual build guard rejects an installed CUPS library and permits its absence", () => {
    const guard = runtime.match(/for package in libcups2t64; do[\s\S]*?done/u)?.[0];
    expect(guard).toBeDefined();
    if (!guard) throw new Error("runtime is missing the unused printing-library guard");
    const directory = mkdtempSync(join(tmpdir(), "browser-runtime-dependency-"));
    try {
      writeFileSync(join(directory, "dpkg-query"), `#!/bin/sh
        test "$1" = -W && test "$3" = libcups2t64 || exit 2
        test -n "$FIXTURE_PACKAGE_STATUS" || exit 1
        printf '%s' "$FIXTURE_PACKAGE_STATUS"
      `, { mode: 0o700 });
      for (const [status, expected] of [["ii ", 1], ["rc ", 0], ["", 0]] as const) {
        const result = Bun.spawnSync(["sh", "-c", guard], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_PACKAGE_STATUS: status },
          stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).toBe(expected);
        if (expected !== 0) expect(result.stderr.toString()).toContain("unexpected unused printing library retained: libcups2t64");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
