import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedUpdaterFloor = [6, 8, 9] as const;
const auditedRuntimeFloor = [9, 7, 0] as const;

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

describe("Desktop updater security floor", () => {
  test("pins patched updater and runtime releases on the shipped path", async () => {
    const packageJsonPath = join(repositoryRoot, "apps/desktop/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const updaterVersion = packageJson.dependencies?.["electron-updater"];

    expect(
      compareVersions(parseExactVersion(updaterVersion), auditedUpdaterFloor),
    ).toBeGreaterThanOrEqual(0);

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).toContain(`"electron-updater": "${updaterVersion}"`);

    const updaterEntry = new RegExp(
      `"electron-updater": \\["electron-updater@${updaterVersion}", "", \\{ "dependencies": \\{ "builder-util-runtime": "([^"]+)"`,
    ).exec(lockfile);
    expect(updaterEntry).not.toBeNull();

    const runtimeVersion = updaterEntry![1];
    expect(
      compareVersions(parseExactVersion(runtimeVersion), auditedRuntimeFloor),
    ).toBeGreaterThanOrEqual(0);
    const nestedRuntimeResolution =
      `"electron-updater/builder-util-runtime": ["builder-util-runtime@${runtimeVersion}"`;
    const deduplicatedRuntimeResolution =
      `"builder-util-runtime": ["builder-util-runtime@${runtimeVersion}"`;
    expect(
      lockfile.includes(nestedRuntimeResolution) ||
        lockfile.includes(deduplicatedRuntimeResolution),
    ).toBe(true);
  });
});
