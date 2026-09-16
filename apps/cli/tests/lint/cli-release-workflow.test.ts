import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
test("CLI source keeps contributor packaging and consumer trust without official signing", () => {
  expect(existsSync(resolve(root, ".github/workflows/cli-release.yml"))).toBe(false);
  expect(existsSync(resolve(root, "apps/cli/scripts/assemble-cli-release.ts"))).toBe(false);
  const packageJson = JSON.parse(readFileSync(resolve(root, "apps/cli/package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(packageJson.scripts["assemble:release"]).toBeUndefined();
  expect(packageJson.scripts["qualify:standalone"]).toContain("build-standalone.ts");
  const compiler = readFileSync(resolve(root, "apps/cli/scripts/compile-standalone-native.ts"), "utf8");
  expect(compiler).not.toMatch(/process\.env|createPrivateKey|--options.*runtime|--timestamp.*--sign/);
  expect(compiler).toContain('"--sign", "-", "--timestamp=none"');
  expect(compiler).toContain("embeddedNativeDeveloperIdCodeSigned: false");
  expect(readFileSync(resolve(root, "apps/cli/src/lib/cli-release.ts"), "utf8")).toContain("parseAndVerifyCliReleaseManifest");
});
