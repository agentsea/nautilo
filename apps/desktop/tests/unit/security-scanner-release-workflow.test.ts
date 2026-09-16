import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { validateSecurityScannerManifest } from "../../electron/security-scanner-runtime/manifest.ts";

const root = join(import.meta.dir, "../../../..");

test("managed scanner source retains verified acquisition without official publication", () => {
  expect(existsSync(join(root, ".github/workflows/security-scanner-release.yml"))).toBe(false);
  expect(existsSync(join(root, "apps/desktop/scripts/assemble-security-scanners.ts"))).toBe(false);
  const manifest: unknown = JSON.parse(readFileSync(join(root, "apps/desktop/security-scanners/manifest.json"), "utf8"));
  expect(validateSecurityScannerManifest(manifest)).not.toBeNull();
  for (const name of ["security.yml", "README.md", "LICENSE"]) {
    expect(existsSync(join(root, "apps/desktop/security-scanners/rules", name))).toBe(true);
  }
});
