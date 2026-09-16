import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedVersions = {
  "linkify-it": "5.0.2",
  "markdown-it": "14.3.0",
  "react-native-markdown-display": "7.0.2",
} as const;

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(
      new RegExp(`"${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g"),
    ),
  ].map((match) => match[1]!);
}

describe("Mobile Markdown security floor", () => {
  test("pins the renderer and parser closure to the audited exact versions", async () => {
    const [rootManifestText, mobileManifestText, lockfile] = await Promise.all([
      readFile(join(repositoryRoot, "package.json"), "utf8"),
      readFile(join(repositoryRoot, "apps/mobile/package.json"), "utf8"),
      readFile(join(repositoryRoot, "bun.lock"), "utf8"),
    ]);
    const rootManifest = JSON.parse(rootManifestText) as {
      overrides?: Record<string, unknown>;
    };
    const mobileManifest = JSON.parse(mobileManifestText) as {
      dependencies?: Record<string, unknown>;
    };

    expect(
      mobileManifest.dependencies?.["react-native-markdown-display"],
    ).toBe(auditedVersions["react-native-markdown-display"]);
    expect(rootManifest.overrides?.["markdown-it"]).toBe(
      auditedVersions["markdown-it"],
    );
    expect(rootManifest.overrides?.["linkify-it"]).toBe(
      auditedVersions["linkify-it"],
    );

    for (const [packageName, auditedVersion] of Object.entries(
      auditedVersions,
    )) {
      expect(new Set(resolvedVersions(lockfile, packageName))).toEqual(
        new Set([auditedVersion]),
      );
    }
  });
});
