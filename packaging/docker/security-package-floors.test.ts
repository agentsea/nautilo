import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("OS security floors remain required independently of the vendored browser", () => {
  const root = mkdtempSync(join(tmpdir(), "package-floors-"));
  const floors = join(import.meta.dir, "server-security-package-floors.txt");
  const packages = readFileSync(floors, "utf8").split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]!);
  expect(packages).not.toContain("chromium-common");
  expect(packages).not.toContain("chromium-headless-shell");
  expect(packages).toContain("libbrotli1");
  expect(packages).toContain("libsqlite3-0");
  writeFileSync(join(root, "dpkg"), `#!/bin/sh
if [ "$1" = --print-architecture ]; then echo "$FIXTURE_ARCH"; exit 0; fi
test "$1" = --compare-versions
test "$3" = ge
test "$2" = "$4"
`, { mode: 0o700 });
  writeFileSync(join(root, "dpkg-query"), `#!/bin/sh
test "$3" != "$FIXTURE_MISSING" || exit 1
awk -v p="$3" '$1 == p {print $2; exit}' "$FIXTURE_FLOORS"
`, { mode: 0o700 });
  const execute = (architecture: string, missing = "") => spawnSync("sh", [
    join(import.meta.dir, "check-security-package-floors.sh"), floors,
  ], { encoding: "utf8", env: { ...process.env, PATH: root + ":" + process.env.PATH,
    FIXTURE_ARCH: architecture, FIXTURE_MISSING: missing, FIXTURE_FLOORS: floors } });
  try {
    for (const architecture of ["amd64", "arm64"]) {
      expect(execute(architecture).status).toBe(0);
      for (const name of packages) expect(execute(architecture, name).status).toBe(1);
    }
    expect(execute("unsupported").status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Brotli floors require the Debian security backport on both architectures", () => {
  const root = mkdtempSync(join(tmpdir(), "brotli-package-floors-"));
  writeFileSync(join(root, "dpkg"), `#!/bin/sh
if [ "$1" = --print-architecture ]; then echo "$FIXTURE_ARCH"; exit 0; fi
test "$1" = --compare-versions
test "$3" = ge
if [ "$4" = '1.1.0-2+deb13u1' ]; then
  case "$2" in
    1.1.0-2+deb13u1|1.1.0-2+deb13u2) exit 0 ;;
    *) exit 1 ;;
  esac
fi
test "$2" = "$4"
`, { mode: 0o700 });
  writeFileSync(join(root, "dpkg-query"), `#!/bin/sh
case "$3" in
  libbrotli1) echo "$FIXTURE_BROTLI" ;;
  *) awk -v p="$3" '$1 == p {print $2; exit}' "$FIXTURE_FLOORS" ;;
esac
`, { mode: 0o700 });
  const floors = join(import.meta.dir, "server-security-package-floors.txt");
  const execute = (architecture: string, version: string) => spawnSync("sh", [
    join(import.meta.dir, "check-security-package-floors.sh"), floors,
  ], { encoding: "utf8", env: { ...process.env, PATH: root + ":" + process.env.PATH,
    FIXTURE_ARCH: architecture, FIXTURE_BROTLI: version, FIXTURE_FLOORS: floors } });
  for (const architecture of ["amd64", "arm64"]) {
    for (const vulnerable of ["1.1.0-2", "1.1.0-2+b7"]) {
      expect(execute(architecture, vulnerable).status).toBe(1);
    }
    expect(execute(architecture, "1.1.0-2+deb13u1").status).toBe(0);
    expect(execute(architecture, "1.1.0-2+deb13u2").status).toBe(0);
  }
});
