import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFiles } from "./checkout-files";

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

function findLockfiles(root: string): string[] {
  return checkoutFiles(root).filter(
    (path) => path === "bun.lock" || path.endsWith("/bun.lock"),
  );
}

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(new RegExp(`${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g")),
  ].map((match) => match[1]!);
}

describe("Hono security floors", () => {
  test("lockfile discovery covers new files and skips ignored nested checkouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hono-lockfiles-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await writeFile(join(root, ".gitignore"), ".claude/\nnode_modules/\n");
      await mkdir(join(root, "tools/new-root"), { recursive: true });
      await mkdir(join(root, ".claude/worktrees/other/tools"), { recursive: true });
      await mkdir(join(root, "node_modules/pkg"), { recursive: true });
      for (const path of [
        "bun.lock",
        "tools/new-root/bun.lock",
        ".claude/worktrees/other/bun.lock",
        ".claude/worktrees/other/tools/bun.lock",
        "node_modules/pkg/bun.lock",
      ]) {
        await writeFile(join(root, path), "");
      }
      execFileSync("git", ["add", "bun.lock"], { cwd: root });

      expect(findLockfiles(root)).toEqual(["bun.lock", "tools/new-root/bun.lock"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    for (const lockPath of findLockfiles(repositoryRoot)) {
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
