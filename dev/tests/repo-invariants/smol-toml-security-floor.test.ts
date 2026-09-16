import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedVersion = "1.8.0";
const manifestPaths = [
  "package.json",
  "apps/cli/package.json",
  "apps/desktop/package.json",
  "bin/nautilo-dev/package.json",
  "packages/config-guard/package.json",
  "packages/deploy-config/package.json",
  "packages/instance-discovery/package.json",
  "packaging/docker/runtime-install/packages/config-guard/package.json",
] as const;

describe("smol-toml security floor", () => {
  test("keeps every first-party consumer above the CVE-2026-85730 fixed floor", async () => {
    for (const path of manifestPaths) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, path), "utf8"),
      ) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      expect(
        manifest.dependencies?.["smol-toml"]
          ?? manifest.devDependencies?.["smol-toml"],
      ).toBe(auditedVersion);
    }
  });

  test("keeps the production runtime projection free of the vulnerable release", async () => {
    const lockfile = await readFile(
      join(repositoryRoot, "packaging/docker/runtime-install/bun.lock"),
      "utf8",
    );
    expect(lockfile).toContain(`"smol-toml@${auditedVersion}"`);
    expect(lockfile).not.toContain('"smol-toml@1.6.1"');
  });
});
