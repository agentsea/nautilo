import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileRailwayHeldTemplateScaffold } from "../../src/template-held-scaffold";
import { prepareRailwayTemplateAdoption } from "../../src/template-adoption";
import { runRailwayTemplateAdoptionRelease } from "../../src/template-adoption-release";

const root = resolve(import.meta.dir, "../../../..");

test("official template producer entry points stay out of the public product", () => {
  for (const path of [
    "apps/cli/scripts/railway-template-source.ts",
    "apps/cli/src/lib/railway-template-source-release.ts",
    "packages/railway-hosting/src/template-source-project.ts",
    "packages/railway-hosting/RAILWAY-TEMPLATE-LISTING.md",
  ]) expect(existsSync(resolve(root, path))).toBe(false);
  const cli = JSON.parse(readFileSync(resolve(root, "apps/cli/package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(cli.scripts["railway:template-source"]).toBeUndefined();
  const exports = readFileSync(resolve(root, "packages/railway-hosting/src/index.ts"), "utf8");
  expect(exports).not.toContain('from "./template-source-project"');
  expect(typeof compileRailwayHeldTemplateScaffold).toBe("function");
  expect(typeof prepareRailwayTemplateAdoption).toBe("function");
  expect(typeof runRailwayTemplateAdoptionRelease).toBe("function");
});
