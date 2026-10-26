import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedVersion = "1.9.1";
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
  test("keeps every first-party consumer on the audited parser release", async () => {
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

  test("keeps active dependency locks free of vulnerable releases", async () => {
    for (const path of [
      "bun.lock",
      "packaging/docker/runtime-install/bun.lock",
    ]) {
      const lockfile = await readFile(join(repositoryRoot, path), "utf8");
      const versions = new Set(
        [...lockfile.matchAll(/"smol-toml@([^"]+)"/g)].map((match) => match[1]),
      );
      expect([...versions]).toEqual([auditedVersion]);
    }
  });
});
