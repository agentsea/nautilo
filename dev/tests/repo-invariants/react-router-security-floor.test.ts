import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedSecurityFloor = [7, 18, 2] as const;

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

describe("Workbench React Router security floor", () => {
  test("pins a patched React Router release and keeps bun.lock aligned", async () => {
    const packageJsonPath = join(repositoryRoot, "apps/workbench/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const reactRouterDomVersion =
      packageJson.dependencies?.["react-router-dom"];

    expect(
      compareVersions(
        parseExactVersion(reactRouterDomVersion),
        auditedSecurityFloor,
      ),
    ).toBeGreaterThanOrEqual(0);

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).toContain(
      `"react-router-dom": "${reactRouterDomVersion}"`,
    );
    expect(lockfile).toContain(
      `"react-router-dom": ["react-router-dom@${reactRouterDomVersion}"`,
    );
    expect(lockfile).toContain(
      `"react-router": ["react-router@${reactRouterDomVersion}"`,
    );
  });
});
