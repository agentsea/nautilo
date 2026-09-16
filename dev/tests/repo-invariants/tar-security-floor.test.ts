import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedSecurityFloor = [7, 5, 21] as const;

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

describe("tar security floor", () => {
  test("pins every transitive archive-tool resolution above the audited floor", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      overrides?: Record<string, unknown>;
    };
    const tarVersion = packageJson.overrides?.tar;

    expect(
      compareVersions(parseExactVersion(tarVersion), auditedSecurityFloor),
    ).toBeGreaterThanOrEqual(0);

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    const resolvedVersions = [
      ...lockfile.matchAll(/\["tar@(\d+\.\d+\.\d+)/g),
    ].map((match) => match[1]);

    expect(resolvedVersions.length).toBeGreaterThan(0);
    expect(new Set(resolvedVersions)).toEqual(new Set([tarVersion]));
  });
});
