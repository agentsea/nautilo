import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const roots = ["apps", "bin", "packages", "packaging"];
const allowedLegacyMigrationPaths = new Set([
  "apps/desktop/electron/paths.ts",
  "apps/desktop/tests/unit/desktop-filesystem-grants-store.test.ts",
]);
const ignored = new Set(["node_modules", ".turbo", "dist", "release"]);

function files(root: string): string[] {
  const absolute = join(repoRoot, root);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    if (entry.name.endsWith(".tsbuildinfo")) return [];
    const child = join(root, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

describe("Desktop Filesystem Grant terminology", () => {
  test("retire generic workstation-grant vocabulary, old paths, and the old package", () => {
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of files(root)) {
        if (/workstation-grants|workstation-grant/.test(file) && !allowedLegacyMigrationPaths.has(file)) {
          violations.push(`${file}: retired generic path`);
        }
        if (!/\.(?:ts|tsx|json|md|yml|yaml)$/.test(file)) continue;
        const text = readFileSync(join(repoRoot, file), "utf8");
        if (text.includes("@nautilo/workstation-grants")) violations.push(`${file}: old package`);
        if (/\b(?:workstationGrant|WorkstationGrant|WORKSTATION_GRANT)\b/.test(text)) {
          violations.push(`${file}: generic workstation grant identifier`);
        }
        if (/\b(?:workstationAuthority|WorkstationBaselineAuthority|FsDispatchWorkstationAuthority|WORKSTATION_BASELINE_FS_ACCESS)\b/.test(text)) {
          violations.push(`${file}: generic workstation filesystem authority`);
        }
        if (/\b(?:WorkstationOperationGuard|guardWorkstationOperation)\b/.test(text)) {
          violations.push(`${file}: generic workstation operation guard`);
        }
        if (/\bworkstation authority\b/i.test(text)) {
          violations.push(`${file}: generic workstation authority diagnostic`);
        }
        if (/\bguarded workstation locations\b/i.test(text)) {
          violations.push(`${file}: generic workstation location copy`);
        }
        if (text.includes("workstation-grants.json") && !allowedLegacyMigrationPaths.has(file)) {
          violations.push(`${file}: historical filename outside one-time migration`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
