import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");
const POLICY_ROOTS = [resolve(SRC_ROOT, "app"), resolve(SRC_ROOT, "providers")];

function productionSources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [path];
  });
}

function matchingFiles(pattern: RegExp): string[] {
  return POLICY_ROOTS.flatMap(productionSources)
    .filter((path) => !/\.(?:native|web)\.(ts|tsx)$/.test(path))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC_ROOT, path))
    .sort();
}

test("D515 capability policy does not grow new scattered Platform.OS branches", () => {
  expect(matchingFiles(/Platform\.OS/)).toEqual([
    "app/(onboarding)/qualification/markdown-source.tsx",
  ]);
});

test("D515 records native-authority imports that remain in shared route sources", () => {
  const nativeAuthorityImport = /from ["']expo-(?:audio|camera|device|file-system|image-picker|notifications|secure-store|sharing)["']/;
  expect(matchingFiles(nativeAuthorityImport)).toEqual([
    "app/(drawer)/(tabs)/settings/agent-photos.tsx",
    "app/(drawer)/(tabs)/settings/voice-picker.tsx",
    "app/(drawer)/(tabs)/settings/voice.tsx",
    "app/(onboarding)/scan-computer-qr.tsx",
    "app/(onboarding)/scan-qr.tsx",
  ]);
});

test("D515 root navigation consumes the canonical capability context", () => {
  const rootLayout = readFileSync(resolve(SRC_ROOT, "app/_layout.tsx"), "utf8");
  expect(rootLayout).toContain("<PlatformCapabilitiesProvider>");
  expect(rootLayout).toMatch(/usePlatformRouteAdmission\((?:usePathname\(\)|pathname)\)/);
  expect(rootLayout).not.toContain("Platform.OS");
});

test("D515 platform definitions stay confined to the platform projection files", () => {
  const definitionOwners = productionSources(resolve(SRC_ROOT, "platform"))
    .filter((path) => readFileSync(path, "utf8").includes("definePlatformCapabilities("))
    .map((path) => relative(SRC_ROOT, path))
    .sort();
  expect(definitionOwners).toEqual([
    "platform/capabilities.native.ts",
    "platform/capabilities.ts",
    "platform/capabilities.web.ts",
    "platform/capability-contract.ts",
  ]);
});
