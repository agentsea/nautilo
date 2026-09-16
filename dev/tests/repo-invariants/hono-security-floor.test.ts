import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedVersions = {
  "@hono/node-server": "1.19.15",
  hono: "4.12.34",
} as const;

const installRootManifests = [
  "package.json",
  "dev/tools/electron-debug/package.json",
  "dev/tools/nautilo-backup/package.json",
  "dev/tools/nautilo-db/package.json",
  "dev/tools/nautilo-server-logs/package.json",
  "dev/tools/security-smoke/package.json",
  "packaging/docker/runtime-install/package.json",
] as const;

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "dist",
  "node_modules",
  "release",
]);

async function findLockfiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await findLockfiles(path)));
    if (entry.isFile() && entry.name === "bun.lock") {
      paths.push(relative(repositoryRoot, path));
    }
  }
  return paths.sort();
}

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(new RegExp(`${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g")),
  ].map((match) => match[1]!);
}

describe("Hono security floors", () => {
  test("pins every install root and lockfile to the audited patched releases", async () => {
    for (const manifestPath of installRootManifests) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, manifestPath), "utf8"),
      ) as { overrides?: Record<string, unknown> };
      for (const [packageName, auditedVersion] of Object.entries(
        auditedVersions,
      )) {
        expect(manifest.overrides?.[packageName]).toBe(auditedVersion);
      }
    }

    const honoLocks: string[] = [];
    for (const lockPath of await findLockfiles(repositoryRoot)) {
      const lockfile = await readFile(join(repositoryRoot, lockPath), "utf8");
      const resolutions = Object.fromEntries(
        Object.keys(auditedVersions).map((packageName) => [
          packageName,
          resolvedVersions(lockfile, packageName),
        ]),
      );
      if (Object.values(resolutions).every((versions) => versions.length === 0)) {
        continue;
      }
      honoLocks.push(lockPath);
      for (const [packageName, auditedVersion] of Object.entries(
        auditedVersions,
      )) {
        expect(resolutions[packageName]?.length).toBeGreaterThan(0);
        expect(new Set(resolutions[packageName])).toEqual(
          new Set([auditedVersion]),
        );
      }
    }

    expect(honoLocks).toEqual([
      "bun.lock",
      "dev/tools/electron-debug/bun.lock",
      "dev/tools/nautilo-db/bun.lock",
      "dev/tools/nautilo-server-logs/bun.lock",
      "dev/tools/security-smoke/bun.lock",
      "packaging/docker/runtime-install/bun.lock",
    ]);
  });
});
