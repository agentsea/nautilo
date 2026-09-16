import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedBuilderFloor = [26, 15, 0] as const;
const auditedRuntimeFloor = [9, 7, 0] as const;
const auditedTransitiveFloors = {
  "form-data": [4, 0, 6],
  tmp: [0, 2, 7],
} as const;

function parseExactVersion(value: unknown): [number, number, number] {
  expect(typeof value).toBe("string");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value as string);
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(new RegExp(`${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g")),
  ].map((match) => match[1]);
}

describe("Desktop builder security floor", () => {
  test("pins a patched builder closure for every desktop target", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as {
      devDependencies?: Record<string, unknown>;
    };
    const rootPackageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      overrides?: Record<string, unknown>;
    };
    const builderVersion = packageJson.devDependencies?.["electron-builder"];
    const windowsBuilderVersion =
      rootPackageJson.overrides?.["electron-builder-squirrel-windows"];

    expect(
      compareVersions(parseExactVersion(builderVersion), auditedBuilderFloor),
    ).toBeGreaterThanOrEqual(0);
    expect(windowsBuilderVersion).toBe(builderVersion);

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).toContain(`"electron-builder": "${builderVersion}"`);
    expect(lockfile).toContain(
      `"electron-builder-squirrel-windows": ["electron-builder-squirrel-windows@${windowsBuilderVersion}"`,
    );

    for (const packageName of [
      "electron-builder",
      "electron-builder-squirrel-windows",
      "app-builder-lib",
      "builder-util",
      "dmg-builder",
      "electron-publish",
    ]) {
      const versions = resolvedVersions(lockfile, packageName);
      expect(versions.length).toBeGreaterThan(0);
      expect(
        versions.every(
          (version) =>
            compareVersions(parseExactVersion(version), auditedBuilderFloor) >= 0,
        ),
      ).toBe(true);
    }

    const runtimeVersions = resolvedVersions(lockfile, "builder-util-runtime");
    expect(runtimeVersions.length).toBeGreaterThan(0);
    expect(
      runtimeVersions.every(
        (version) =>
          compareVersions(parseExactVersion(version), auditedRuntimeFloor) >= 0,
      ),
    ).toBe(true);

    for (const [packageName, auditedFloor] of Object.entries(
      auditedTransitiveFloors,
    )) {
      const overrideVersion = rootPackageJson.overrides?.[packageName];
      expect(
        compareVersions(parseExactVersion(overrideVersion), auditedFloor),
      ).toBeGreaterThanOrEqual(0);

      const versions = resolvedVersions(lockfile, packageName);
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((version) => version === overrideVersion)).toBe(
        true,
      );
    }
  });
});
