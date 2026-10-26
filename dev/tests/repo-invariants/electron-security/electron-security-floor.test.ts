import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../../..");
const auditedSecurityFloor = [43, 8, 3] as const;
const electronWorkspaces = [
  ["apps/desktop", "devDependencies"],
  ["packages/computer-use-host", "devDependencies"],
  ["dev/tools/genie-lab", "dependencies"],
] as const;

type Dependencies = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type WorkspaceLock = {
  workspaces: Record<string, Dependencies>;
  packages: Record<string, unknown[]>;
};

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
  test("pins one patched exact release across Electron consumers and lock importers", async () => {
    const lock = Bun.JSONC.parse(
      await readFile(join(repositoryRoot, "bun.lock"), "utf8"),
    ) as WorkspaceLock;
    const versions = new Set<string>();

    for (const [workspace, dependencyKind] of electronWorkspaces) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, workspace, "package.json"), "utf8"),
      ) as Dependencies;
      const version = manifest[dependencyKind]?.["electron"];
      const parsed = parseExactVersion(version);
      // A higher major can still predate the TLS fix. Qualify a new release
      // line explicitly before changing the supported security floor.
      expect(parsed[0], workspace).toBe(auditedSecurityFloor[0]);
      expect(compareVersions(parsed, auditedSecurityFloor), workspace).toBeGreaterThanOrEqual(0);
      expect(lock.workspaces[workspace]?.[dependencyKind]?.["electron"], workspace).toBe(version);
      versions.add(parsed.join("."));
    }

    expect(versions.size).toBe(1);
    const version = [...versions][0]!;
    const resolutions = Object.values(lock.packages).filter(
      (entry) => typeof entry[0] === "string" && entry[0].startsWith("electron@"),
    );
    expect(resolutions).toHaveLength(1);
    expect(lock.packages["electron"]?.[0]).toBe(`electron@${version}`);
    expect(resolutions[0]?.[0]).toBe(`electron@${version}`);
  });

  test("declares the supported macOS minimum in the packaged application", async () => {
    const builder = Bun.YAML.parse(
      await readFile(join(repositoryRoot, "apps/desktop/electron-builder.yml"), "utf8"),
    ) as { mac: { extendInfo: { LSMinimumSystemVersion: string } } };
    expect(builder.mac.extendInfo.LSMinimumSystemVersion).toBe("13.0");
  });
});
