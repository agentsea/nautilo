import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("native Chromium floors reject 154 and 155 on both architectures and accept 156 or newer", () => {
  const root = mkdtempSync(join(tmpdir(), "package-floors-"));
  writeFileSync(join(root, "dpkg"), `#!/bin/sh
if [ "$1" = --print-architecture ]; then echo "$FIXTURE_ARCH"; exit 0; fi
test "$1" = --compare-versions
test "$3" = ge
# Only Chromium is under test: the query shim echoes each other package's floor.
case "$2" in
  156.0.8078.48-1~deb13u1|157.0.8100.1-1~deb13u1) exit 0 ;;
esac
test "$2" = "$4"
`, {mode: 0o700});
  writeFileSync(join(root, "dpkg-query"), `#!/bin/sh
case "$3" in
 chromium-*) echo "$FIXTURE_CHROMIUM" ;;
 *) awk -v p="$3" '$1 == p {print $2; exit}' "$FIXTURE_FLOORS" ;;
esac
`, {mode: 0o700});
  const floors = join(import.meta.dir, "server-security-package-floors.txt");
  const execute = (architecture: string, version: string) => spawnSync("sh", [
    join(import.meta.dir, "check-security-package-floors.sh"), floors,
  ], {encoding: "utf8", env: {...process.env, PATH: root + ":" + process.env.PATH,
    FIXTURE_ARCH: architecture, FIXTURE_CHROMIUM: version, FIXTURE_FLOORS: floors}});
  for (const architecture of ["amd64", "arm64"]) {
    expect(execute(architecture, "154.0.8037.92-1~deb13u1").status).toBe(1);
    expect(execute(architecture, "155.0.8059.79-1~deb13u1").status).toBe(1);
    expect(execute(architecture, "156.0.8078.47-1~deb13u1").status).toBe(0);
    expect(execute(architecture, "156.0.8078.48-1~deb13u1").status).toBe(0);
    expect(execute(architecture, "157.0.8100.1-1~deb13u1").status).toBe(0);
  }
  expect(execute("unsupported", "156.0.8078.47-1~deb13u1").status).toBe(1);
});
