import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedSecurityFloor = [41, 10, 3] as const;

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

describe("Desktop Electron security floor", () => {
  test("pins a patched Electron release and keeps bun.lock aligned", async () => {
    const packageJsonPath = join(repositoryRoot, "apps/desktop/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      devDependencies?: Record<string, unknown>;
    };
    const electronVersion = packageJson.devDependencies?.["electron"];

    expect(
      compareVersions(parseExactVersion(electronVersion), auditedSecurityFloor),
    ).toBeGreaterThanOrEqual(0);

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).toContain(`"electron": "${electronVersion}"`);
    expect(lockfile).toContain(`"electron": ["electron@${electronVersion}"`);
  });
});
