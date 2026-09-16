import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

const expressInstallRoots = [
  "package.json",
  "dev/tools/electron-debug/package.json",
  "dev/tools/nautilo-db/package.json",
  "dev/tools/nautilo-server-logs/package.json",
  "dev/tools/security-smoke/package.json",
  "packaging/docker/runtime-install/package.json",
] as const;

const expressLockfiles = [
  "bun.lock",
  "dev/tools/electron-debug/bun.lock",
  "dev/tools/nautilo-db/bun.lock",
  "dev/tools/nautilo-server-logs/bun.lock",
  "dev/tools/security-smoke/bun.lock",
  "packaging/docker/runtime-install/bun.lock",
] as const;

describe("residual JavaScript dependency security pack", () => {
  test("keeps every Express install root on exact audited parser versions", async () => {
    for (const manifestPath of expressInstallRoots) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, manifestPath), "utf8"),
      ) as { overrides?: Record<string, unknown> };

      expect(manifest.overrides?.["body-parser"]).toBe("2.3.0");
      expect(manifest.overrides?.qs).toBe("6.15.3");
    }

    for (const lockfilePath of expressLockfiles) {
      const lockfile = await readFile(
        join(repositoryRoot, lockfilePath),
        "utf8",
      );

      expect(lockfile).toContain('"body-parser@2.3.0"');
      expect(lockfile).not.toContain('"body-parser@2.2.2"');
      expect(lockfile).toContain('"qs@6.15.3"');
      expect(lockfile).not.toContain('"qs@6.15.1"');
    }
  });

  test("keeps the audited toolchain and Drizzle upgrades in place", async () => {
    const desktopManifest = JSON.parse(
      await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, unknown> };
    const cliManifest = JSON.parse(
      await readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, unknown> };
    const workbenchComponentsManifest = JSON.parse(
      await readFile(
        join(repositoryRoot, "packages/workbench-components/package.json"),
        "utf8",
      ),
    ) as { devDependencies?: Record<string, unknown> };
    const latticeBridgeManifest = JSON.parse(
      await readFile(
        join(repositoryRoot, "packages/lattice-bridge/package.json"),
        "utf8",
      ),
    ) as { devDependencies?: Record<string, unknown> };
    const rootLockfile = await readFile(
      join(repositoryRoot, "bun.lock"),
      "utf8",
    );

    expect(cliManifest.devDependencies?.["@microsoft/api-extractor"]).toBe(
      "7.58.13",
    );
    expect(
      workbenchComponentsManifest.devDependencies?.[
        "@microsoft/api-extractor"
      ],
    ).toBe(
      "7.58.13",
    );
    expect(desktopManifest.devDependencies?.esbuild).toBe("0.28.2");
    expect(latticeBridgeManifest.devDependencies?.["drizzle-orm"]).toBe(
      "0.45.2",
    );

    expect(rootLockfile).toContain(
      '["@microsoft/api-extractor@7.58.13"',
    );
    expect(rootLockfile).toContain('"diff@8.0.4"');
    expect(rootLockfile).not.toContain('"diff@8.0.2"');
    expect(rootLockfile).toContain(
      '"esbuild": ["esbuild@0.28.2"',
    );
    expect(rootLockfile).not.toContain('"drizzle-orm@0.44.6"');
  });
});
