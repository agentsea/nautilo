import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

const auditedVersions = {
  "happy-dom": "20.11.6",
  "js-yaml": "4.3.1",
  postcss: "8.5.26",
  turbo: "2.10.11",
  vite: "6.4.3",
  vitest: "4.1.11",
} as const;

const manifestExpectations: Record<string, Record<string, Record<string, string>>> = {
  "package.json": {
    devDependencies: {
      "happy-dom": auditedVersions["happy-dom"],
      turbo: auditedVersions.turbo,
    },
    overrides: {
      "js-yaml": auditedVersions["js-yaml"],
      postcss: auditedVersions.postcss,
    },
  },
  "apps/workbench/package.json": {
    devDependencies: {
      "happy-dom": auditedVersions["happy-dom"],
      vite: auditedVersions.vite,
    },
  },
  "dev/harnesses/writer-editor/package.json": {
    devDependencies: { vite: auditedVersions.vite },
  },
  "packages/first-party-apps/writer/package.json": {
    devDependencies: { "happy-dom": auditedVersions["happy-dom"] },
  },
  "packages/relay/package.json": {
    devDependencies: { "happy-dom": auditedVersions["happy-dom"] },
  },
  "packages/workbench-components/package.json": {
    devDependencies: {
      "happy-dom": auditedVersions["happy-dom"],
      vitest: auditedVersions.vitest,
    },
  },
} as const;

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(
      new RegExp(`"${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g"),
    ),
  ].map((match) => match[1]!);
}

describe("JavaScript editor and toolchain security pack", () => {
  test("keeps every owned manifest on exact audited versions", async () => {
    for (const [manifestPath, sections] of Object.entries(
      manifestExpectations,
    )) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, manifestPath), "utf8"),
      ) as Record<string, Record<string, unknown> | undefined>;

      for (const [section, dependencies] of Object.entries(sections)) {
        for (const [packageName, auditedVersion] of Object.entries(
          dependencies,
        )) {
          expect(manifest[section]?.[packageName]).toBe(auditedVersion);
        }
      }
    }
  });

  test("resolves only the audited versions in the root lockfile", async () => {
    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");

    for (const [packageName, auditedVersion] of Object.entries(
      auditedVersions,
    )) {
      expect(new Set(resolvedVersions(lockfile, packageName))).toEqual(
        new Set([auditedVersion]),
      );
    }
  });

  test("keeps the standalone Writer lock aligned", async () => {
    const lockfile = await readFile(
      join(repositoryRoot, "packages/first-party-apps/writer/bun.lock"),
      "utf8",
    );

    expect(new Set(resolvedVersions(lockfile, "happy-dom"))).toEqual(
      new Set([auditedVersions["happy-dom"]]),
    );
  });
});
