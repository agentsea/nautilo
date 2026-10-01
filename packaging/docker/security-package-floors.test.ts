import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("native Chromium floors reject the vulnerable AMD64 package without inventing an unavailable ARM64 binary", () => {
  const root = mkdtempSync(join(tmpdir(), "package-floors-"));
  writeFileSync(join(root, "dpkg"), `#!/bin/sh
if [ "$1" = --print-architecture ]; then echo "$FIXTURE_ARCH"; exit 0; fi
test "$1" = --compare-versions
test "$3" = ge
# Only Chromium is under test: the query shim echoes each other package's floor.
test "$2" = "$4" || test "$2" = 154.0.8037.92-1~deb13u1
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
  expect(execute("amd64", "154.0.8037.57-1~deb13u1").status).toBe(1);
  expect(execute("amd64", "154.0.8037.92-1~deb13u1").status).toBe(0);
  expect(execute("arm64", "154.0.8037.57-1~deb13u1").status).toBe(0);
  expect(execute("arm64", "154.0.8037.92-1~deb13u1").status).toBe(0);
  expect(execute("unsupported", "154.0.8037.92-1~deb13u1").status).toBe(1);
});
