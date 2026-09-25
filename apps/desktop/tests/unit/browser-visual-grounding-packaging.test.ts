import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  browserVisualGroundingBuildPlan,
  buildBrowserVisualGroundingHelper,
} from "../../scripts/build-browser-visual-grounding.ts";

const desktopRoot = join(import.meta.dir, "../..");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const builder = yaml.load(readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8")) as {
  mac?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> };
  extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
  linux?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> };
  win?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> };
};

test("browser visual helper is built for dev/mac flows and packaged only on macOS", () => {
  expect(packageJson.scripts["compile:browser-visual-grounding"])
    .toBe("bun scripts/build-browser-visual-grounding.ts");
  for (const name of ["dev:prepare", "package:mac:build", "package:dev:build"]) {
    expect(packageJson.scripts[name]).toContain("bun run compile:browser-visual-grounding");
  }
  const mapping = {
    from: "vendor/browser-visual-grounding",
    to: "tools-browser-vision",
    filter: ["nautilo-browser-visual-grounding"],
  };
  expect(builder.mac?.extraResources?.filter((entry) => entry.from === mapping.from)).toEqual([mapping]);
  for (const resources of [builder.extraResources, builder.linux?.extraResources, builder.win?.extraResources]) {
    expect(resources?.some((entry) => entry.from === mapping.from || entry.to === mapping.to) ?? false).toBe(false);
  }
});

test("browser visual build plan is source-owned, universal, and a non-macOS no-op", () => {
  const plan = browserVisualGroundingBuildPlan(desktopRoot);
  expect(plan.source).toBe(join(desktopRoot, "native/browser-visual-grounding/main.swift"));
  expect(plan.universalOutput).toBe(join(
    desktopRoot, "vendor/browser-visual-grounding/nautilo-browser-visual-grounding",
  ));
  expect(buildBrowserVisualGroundingHelper(desktopRoot, "linux")).toBeNull();
});

test("packaged browser visual helper has exact signing and empty-entitlement audits", () => {
  const contract = readFileSync(join(desktopRoot, "scripts/native-helper-contract.cjs"), "utf8");
  const signer = readFileSync(join(desktopRoot, "scripts/sign-adhoc.cjs"), "utf8");
  const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf8");
  const afterSign = readFileSync(join(desktopRoot, "scripts/after-sign.cjs"), "utf8");
  expect(contract).toContain("com.nautilo.desktop.browser-visual-grounding");
  expect(signer).toContain("BROWSER_VISUAL_GROUNDING_RELATIVE_PATH");
  expect(afterPack).toContain('"nautilo-browser-visual-grounding"');
  expect(afterSign).toContain("assertPackagedBrowserVisualGroundingSignature(bundlePath)");
  expect(afterSign).toContain('inspectExactEntitlements(helperPath, {}, "Browser visual grounding helper")');
});
